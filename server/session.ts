// One agent process per sandbox: `openshell sandbox exec … <agent> acp`. Several
// ACP sessions ("threads") share it; each has its own event log, turn and pending
// permissions.
import { spawn } from "node:child_process";
import type {
  AvailableCommand,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  SetSessionConfigOptionResponse,
  Usage,
} from "@agentclientprotocol/sdk";
import type { ActivityState, PastSession, ServerMessage, SessionEvent, SessionInfo } from "../shared/protocol.ts";
import type { AgentConfig } from "./config.ts";
import { bound } from "./eventlog.ts";
import { exitHint, rpcHint } from "./hints.ts";
import { OPENSHELL, sandboxArg } from "./openshell.ts";
import { JsonRpcPeer, METHOD_NOT_FOUND, RpcError, TransportClosed } from "./rpc.ts";
import type { StoredThread } from "./threadstore.ts";

const INIT_TIMEOUT = 60_000;
const LOAD_TIMEOUT = 180_000;
const MAX_EVENTS = 20_000;
/** Updates for a session we have not seen the session/new reply for yet. */
const MAX_ORPHAN_SESSIONS = 20;
const TITLE_LENGTH = 80;

/** Distributive Omit, so it keeps each member of the SessionEvent union. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewEvent = DistOmit<SessionEvent, "sessionId" | "seq" | "ts">;

interface PendingPermission {
  options: { optionId: string; name: string }[];
  resolve: (outcome: object) => void;
}

export interface SessionHost {
  /** Send to every tab subscribed to this thread. */
  publish(thread: Thread, msg: ServerMessage): void;
  /** Something visible in the sandbox list changed (state, activity). */
  changed(): void;
  /** This thread changed; save it to disk soon. */
  persist(thread: Thread): void;
  /** A saved thread of this id from before the agent process started, if there is one. */
  archived(sandbox: string, sessionId: string): StoredThread | undefined;
}

export function agentCommand(sandbox: string, agent: AgentConfig, cwd: string, model?: string): string[] {
  const args = ["sandbox", "exec", sandboxArg(sandbox), "--no-tty", "--no-login-shell", "--workdir", cwd];
  if (agent.modelEnv && (model || agent.defaultModel)) {
    // `opencode acp` has no -m flag: the model goes in through its config env.
    args.push("--env", `${agent.modelEnv}=${JSON.stringify({ model: model || agent.defaultModel })}`);
  }
  return [...args, "--", ...agent.cmd];
}

/** One ACP session on a sandbox's agent process. */
export class Thread {
  state: ActivityState = "starting";
  title: string | null = null;
  lastActivity = Date.now();
  startedAt = Date.now();
  configOptions: SessionConfigOption[] = [];
  commands: AvailableCommand[] = [];
  usage: SessionInfo["usage"] = undefined;
  log: SessionEvent[] = [];

  /** While the agent replays a loaded session whose log we already have: don't record it twice. */
  replaying = false;
  private compacted = false;
  private seq = 0;
  private turn: Promise<void> | null = null;
  private permissions = new Map<string, PendingPermission>();
  private nextPermission = 0;

  constructor(
    readonly proc: Session,
    readonly sessionId: string,
  ) {}

  get sandbox() {
    return this.proc.sandbox;
  }

  get cwd() {
    return this.proc.cwd;
  }

  get busy() {
    return this.turn !== null;
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      sandbox: this.sandbox,
      agent: this.proc.agent.id,
      agentCmd: this.proc.agent.cmd,
      agentInfo: this.proc.agentInfo,
      canLoad: this.proc.canLoad,
      canList: this.proc.canList,
      cwd: this.cwd,
      title: this.title,
      configOptions: this.configOptions,
      commands: this.commands,
      state: this.state,
      startedAt: this.startedAt,
      usage: this.usage,
      lastSeq: this.seq,
    };
  }

  /** Take over a saved thread: its log, and the title and times it had. */
  restore(saved: StoredThread) {
    this.log = saved.log;
    this.seq = saved.log.at(-1)?.seq ?? saved.info.lastSeq;
    this.title = saved.info.title ?? this.title;
    this.startedAt = saved.info.startedAt;
    this.usage = saved.info.usage;
    this.lastActivity = saved.log.at(-1)?.ts ?? this.lastActivity;
  }

  /** What is written to disk for this thread, and whether the log was compacted since the last write. */
  diskSnapshot() {
    const rewritten = this.compacted;
    this.compacted = false;
    return { ...this.snapshot(), rewritten };
  }

  /** What is kept for this thread in memory. */
  snapshot(): StoredThread {
    return { info: this.info(), log: this.log };
  }

  // ---- what the browser asks for

  prompt(text: string) {
    if (this.proc.dead) throw new Error("The agent process has exited. Start a new session.");
    if (this.turn) throw new Error("The agent is still working on the last prompt in this thread. Wait, or stop it with Esc.");
    const sessionId = this.sessionId;
    this.title ||= text.trim().split("\n")[0].slice(0, TITLE_LENGTH) || null;
    this.record({ type: "user_message", text });
    this.record({ type: "turn_start" });
    this.setState("working");
    this.turn = (async () => {
      try {
        const r = await this.proc.peer.request<PromptResponse>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        const usage: Usage | undefined = r.usage ?? undefined;
        if (usage) this.usage = { ...this.usage, totals: usage };
        this.record({ type: "turn_end", stopReason: r?.stopReason ?? "end_turn", usage });
      } catch (e) {
        if (e instanceof TransportClosed) {
          this.record({ type: "turn_end", stopReason: "agent_exited" });
        } else {
          const message = e instanceof RpcError ? e.message : String((e as Error).message ?? e);
          const detail = e instanceof RpcError && e.data ? JSON.stringify(e.data) : undefined;
          this.record({ type: "session_error", message: `The prompt failed: ${message}`, detail, hint: rpcHint(`${message} ${detail ?? ""}`) });
          this.record({ type: "turn_end", stopReason: "error" });
        }
      } finally {
        this.turn = null;
        if (!this.proc.dead) this.setState("idle");
        this.proc.host.publish(this, { type: "session_info", session: this.info() });
      }
    })();
  }

  cancel() {
    if (!this.turn || this.proc.dead) return;
    this.proc.peer.notify("session/cancel", { sessionId: this.sessionId });
    // The spec: on cancel, the client answers open permission requests with "cancelled".
    this.cancelPermissions();
    this.notice("Stopping the agent…");
  }

  answer(requestId: string, optionId: string | null): boolean {
    const p = this.permissions.get(requestId);
    if (!p) return false;
    this.permissions.delete(requestId);
    const option = optionId ? p.options.find((o) => o.optionId === optionId) : undefined;
    if (optionId && !option) {
      this.permissions.set(requestId, p);
      throw new Error(`Unknown option ${optionId}`);
    }
    p.resolve(option ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    this.record({ type: "permission_resolved", requestId, optionId: option?.optionId ?? null, label: option?.name ?? "Cancelled" });
    if (this.permissions.size === 0 && this.state === "waiting") this.setState(this.turn ? "working" : "idle");
    return true;
  }

  cancelPermissions() {
    for (const id of [...this.permissions.keys()]) this.answer(id, null);
  }

  async setOption(configId: string, value: string) {
    const r = await this.proc.peer.request<SetSessionConfigOptionResponse>(
      "session/set_config_option",
      { sessionId: this.sessionId, configId, value },
      30_000,
    );
    if (r?.configOptions) this.configOptions = r.configOptions;
    const opt = this.configOptions.find((o) => o.id === configId);
    this.notice(`${opt?.name ?? configId} set to ${value}`);
    this.proc.host.publish(this, { type: "session_info", session: this.info() });
  }

  // ---- from the agent

  requestPermission(params: Partial<RequestPermissionRequest>): Promise<unknown> {
    const requestId = String(++this.nextPermission);
    const options = Array.isArray(params.options) ? params.options : [];
    if (!options.length) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return new Promise((resolve) => {
      this.permissions.set(requestId, { options, resolve });
      this.record({ type: "permission_request", requestId, toolCall: params.toolCall ?? { toolCallId: "" }, options });
      this.setState("waiting");
    });
  }

  onUpdate(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.commands = update.availableCommands ?? [];
        break;
      case "config_option_update":
        this.configOptions = update.configOptions ?? this.configOptions;
        break;
      case "usage_update":
        this.usage = { ...this.usage, used: update.used, size: update.size };
        break;
      case "session_info_update":
        if (update.title !== undefined) {
          this.title = update.title;
          this.proc.host.publish(this, { type: "session_info", session: this.info() });
        }
        break;
    }
    if (!this.replaying) this.record({ type: "event", update });
  }

  /** The process exited: answer what was open and, after the stderr reader drained, say so in the log. */
  exited(code: number | null, stderrTail: string[], hint?: string) {
    this.state = "dead";
    this.record({ type: "session_closed", exitCode: code, stderrTail, hint });
    this.proc.host.publish(this, { type: "session_info", session: this.info() });
  }

  dropPermissions() {
    for (const p of this.permissions.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    this.permissions.clear();
  }

  notice(text: string) {
    this.record({ type: "notice", text });
  }

  // ---- event log

  private record(ev: NewEvent) {
    const full = { ...ev, sessionId: this.sessionId, seq: ++this.seq, ts: Date.now() } as SessionEvent;
    this.log.push(full);
    if (this.log.length > MAX_EVENTS) {
      this.log = bound(this.log, MAX_EVENTS);
      this.compacted = true;
    }
    this.lastActivity = full.ts;
    this.proc.host.publish(this, full);
    this.proc.host.persist(this);
  }

  setState(s: ActivityState) {
    if (this.state === s) return;
    this.state = s;
    this.proc.host.publish(this, { type: "session_info", session: this.info() });
    this.proc.host.changed();
  }
}

/** The agent process of one sandbox, and the threads on it. */
export class Session {
  /** When the agent process started; the network view counts from here. */
  readonly spawnedAt = Date.now();
  /** Set when the user closed the process, so its exit isn't reported as a failure. */
  closedByUser = false;
  agentInfo: SessionInfo["agentInfo"] = null;
  canLoad = false;
  canList = false;
  exitCode: number | null = null;
  readonly threads = new Map<string, Thread>();
  dead = false;
  readonly peer: JsonRpcPeer;

  private child;
  /** Updates that arrive before the session/new reply that names their session. */
  private orphans = new Map<string, SessionUpdate[]>();
  private pastTitles = new Map<string, string>();

  constructor(
    readonly sandbox: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    readonly model: string | undefined,
    readonly host: SessionHost,
  ) {
    this.child = spawn(OPENSHELL, agentCommand(sandbox, agent, cwd, model), { stdio: ["pipe", "pipe", "pipe"] });
    this.peer = new JsonRpcPeer(
      this.child,
      (method, params) => this.onRequest(method, params),
      (method, params) => this.onNotification(method, params),
    );
    this.child.on("error", (e) => this.peer.stderrTail.push(`cannot start ${OPENSHELL}: ${e.message}`));
    this.child.on("close", (code) => this.onExit(code));
  }

  // ---- lifecycle

  /** initialize, then the first thread (new, or an earlier one loaded). Rejects with a readable error on failure. */
  async start(loadSessionId?: string): Promise<Thread> {
    try {
      // No fs or terminal capability: the agent must not touch the host (DESIGN.md section 8).
      const init = await this.peer.request<InitializeResponse>(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "sandbox-console", version: "0.1.0" } },
        INIT_TIMEOUT,
      );
      this.agentInfo = init.agentInfo ?? null;
      const caps = init.agentCapabilities ?? {};
      this.canLoad = !!caps.loadSession;
      this.canList = !!(caps as { sessionCapabilities?: { list?: unknown } }).sessionCapabilities?.list;
      return await this.newThread(loadSessionId);
    } catch (e) {
      this.kill();
      throw await this.describeFailure(e);
    }
  }

  /** Another ACP session on this process: a new one, or an earlier one loaded (session/load). */
  async newThread(loadSessionId?: string): Promise<Thread> {
    if (this.dead) throw new Error("The agent process has exited. Start a new session.");
    if (loadSessionId) {
      const live = this.threads.get(loadSessionId);
      if (live) return live;
      if (!this.canLoad) throw new Error(`${this.agent.label} can't load earlier sessions.`);
      // The agent replays the conversation as session/update notifications.
      const t = new Thread(this, loadSessionId);
      t.title = this.pastTitles.get(loadSessionId) ?? null;
      // A thread we saved already has its conversation; the replay would only repeat it.
      const saved = this.host.archived(this.sandbox, loadSessionId);
      if (saved) {
        t.restore(saved);
        t.replaying = true;
      }
      this.threads.set(loadSessionId, t);
      try {
        const r = await this.peer.request<LoadSessionResponse>(
          "session/load",
          { sessionId: loadSessionId, cwd: this.cwd, mcpServers: [] },
          LOAD_TIMEOUT,
        );
        if (r?.configOptions) t.configOptions = r.configOptions;
      } catch (e) {
        this.threads.delete(loadSessionId);
        throw e;
      } finally {
        t.replaying = false;
      }
      t.setState("idle");
      return t;
    }
    const r = await this.peer.request<NewSessionResponse>("session/new", { cwd: this.cwd, mcpServers: [] }, INIT_TIMEOUT);
    if (!r?.sessionId) throw new Error("session/new returned no sessionId");
    const t = new Thread(this, r.sessionId);
    t.configOptions = r.configOptions ?? [];
    this.threads.set(r.sessionId, t);
    // Updates that came before the reply (e.g. available_commands_update).
    for (const u of this.orphans.get(r.sessionId) ?? []) t.onUpdate(u);
    this.orphans.delete(r.sessionId);
    t.setState("idle");
    return t;
  }

  /** Drop a thread: stop what it is doing and forget it. The agent keeps its own copy of the session. */
  dropThread(sessionId: string) {
    const t = this.threads.get(sessionId);
    if (!t) return;
    t.cancel();
    t.cancelPermissions();
    this.threads.delete(sessionId);
  }

  close() {
    this.closedByUser = true;
    for (const t of this.threads.values()) t.cancelPermissions();
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => this.kill(), 3000).unref();
  }

  private kill() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  get alive() {
    return !this.dead;
  }

  get busy() {
    return [...this.threads.values()].some((t) => t.busy);
  }

  /** The thread touched last. */
  get latest(): Thread | undefined {
    let best: Thread | undefined;
    for (const t of this.threads.values()) if (!best || t.lastActivity >= best.lastActivity) best = t;
    return best;
  }

  get lastActivity() {
    return this.latest?.lastActivity ?? this.spawnedAt;
  }

  /** What the sandbox row shows: whatever needs you most. */
  get state(): ActivityState {
    if (this.dead) return "dead";
    const order: ActivityState[] = ["waiting", "working", "starting", "idle"];
    const states = [...this.threads.values()].map((t) => t.state);
    return order.find((s) => states.includes(s)) ?? "starting";
  }

  async listPast(): Promise<PastSession[]> {
    if (!this.canList) return [];
    const r = await this.peer.request<ListSessionsResponse>("session/list", { cwd: this.cwd }, 30_000);
    const past = (r.sessions ?? []).map((s) => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt, cwd: s.cwd }));
    for (const p of past) if (p.title) this.pastTitles.set(p.sessionId, p.title);
    return past;
  }

  // ---- from the agent

  private async onRequest(method: string, raw: unknown): Promise<unknown> {
    const params = (raw ?? {}) as { sessionId?: string };
    const thread = params.sessionId ? this.threads.get(params.sessionId) : undefined;
    if (method === "session/request_permission") {
      return thread ? thread.requestPermission(raw as Partial<RequestPermissionRequest>) : { outcome: { outcome: "cancelled" } };
    }
    // fs/*, terminal/* and anything else: refused. The agent works only inside its sandbox.
    thread?.notice(`Refused the agent's request ${method} (the console gives no host access).`);
    throw new RpcError(method, METHOD_NOT_FOUND, `not supported: ${method}`);
  }

  private onNotification(method: string, raw: unknown) {
    if (method !== "session/update") return;
    const params = raw as Partial<SessionNotification>;
    const update = params.update;
    if (!update || !params.sessionId) return;
    const thread = this.threads.get(params.sessionId);
    if (thread) return thread.onUpdate(update);
    if (!this.orphans.has(params.sessionId) && this.orphans.size >= MAX_ORPHAN_SESSIONS) return;
    this.orphans.set(params.sessionId, [...(this.orphans.get(params.sessionId) ?? []), update]);
  }

  private onExit(code: number | null) {
    if (this.dead) return;
    this.dead = true;
    this.exitCode = code;
    for (const t of this.threads.values()) t.dropPermissions();
    // Give the stderr reader a moment to drain.
    setTimeout(() => {
      const tail = [...this.peer.stderrTail].slice(-15);
      const hint = code === 0 || this.closedByUser ? undefined : exitHint(code, [...this.peer.stderrTail], this.agent);
      for (const t of this.threads.values()) t.exited(code, tail, hint);
      this.host.changed();
    }, 150);
  }

  private async describeFailure(e: unknown): Promise<Error & { detail?: string; hint?: string }> {
    // If the process died, wait for its exit code so the hint can use it.
    await new Promise((r) => setTimeout(r, 300));
    const tail = this.peer.stderrTail.slice(-15);
    const code = this.child.exitCode;
    let message = e instanceof Error ? e.message : String(e);
    let hint: string | undefined;
    if (e instanceof TransportClosed || this.peer.isClosed) {
      message = `The agent process exited${code !== null ? ` (code ${code})` : ""} before the session started`;
      hint = exitHint(code, tail, this.agent);
    } else if (e instanceof RpcError) {
      hint = rpcHint(e.message) ?? exitHint(code, tail, this.agent);
    }
    return Object.assign(new Error(message), { detail: tail.join("\n"), hint });
  }
}
