// One agent process per sandbox: `openshell sandbox exec … <agent> acp`,
// with the current ACP session on it, its event log and pending permissions.
import { spawn } from "node:child_process";
import type { AvailableCommand, SessionConfigOption, Usage } from "@agentclientprotocol/sdk";
import type { ActivityState, PastSession, ServerMessage, SessionEvent, SessionInfo } from "../shared/protocol.ts";
import type { AgentConfig } from "./config.ts";
import { bound } from "./eventlog.ts";
import { exitHint, rpcHint } from "./hints.ts";
import { OPENSHELL, sandboxArg } from "./openshell.ts";
import { JsonRpcPeer, METHOD_NOT_FOUND, RpcError, TransportClosed } from "./rpc.ts";

const INIT_TIMEOUT = 60_000;
const LOAD_TIMEOUT = 180_000;
const MAX_EVENTS = 20_000;

/** Distributive Omit, so it keeps each member of the SessionEvent union. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewEvent = DistOmit<SessionEvent, "sessionId" | "seq" | "ts">;

interface PendingPermission {
  options: { optionId: string; name: string }[];
  resolve: (outcome: object) => void;
}

export interface SessionHost {
  /** Send to every tab subscribed to this session. */
  publish(session: Session, msg: ServerMessage): void;
  /** Something visible in the sandbox list changed (state, activity). */
  changed(session: Session): void;
}

export function agentCommand(sandbox: string, agent: AgentConfig, cwd: string, model?: string): string[] {
  const args = ["sandbox", "exec", sandboxArg(sandbox), "--no-tty", "--no-login-shell", "--workdir", cwd];
  if (agent.modelEnv && (model || agent.defaultModel)) {
    // `opencode acp` has no -m flag: the model goes in through its config env.
    args.push("--env", `${agent.modelEnv}=${JSON.stringify({ model: model || agent.defaultModel })}`);
  }
  return [...args, "--", ...agent.cmd];
}

export class Session {
  sessionId: string | null = null;
  state: ActivityState = "starting";
  lastActivity = Date.now();
  startedAt = Date.now();
  /** When the agent process started; the network view counts from here. */
  readonly spawnedAt = Date.now();
  /** Set when the user closed the session, so its exit isn't reported as a failure. */
  closedByUser = false;
  agentInfo: SessionInfo["agentInfo"] = null;
  canLoad = false;
  canList = false;
  configOptions: SessionConfigOption[] = [];
  commands: AvailableCommand[] = [];
  usage: SessionInfo["usage"] = undefined;
  exitCode: number | null = null;
  log: SessionEvent[] = [];

  private seq = 0;
  private peer: JsonRpcPeer;
  private child;
  private turn: Promise<void> | null = null;
  private permissions = new Map<string, PendingPermission>();
  private nextPermission = 0;
  private dead = false;

  constructor(
    readonly sandbox: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    readonly model: string | undefined,
    private readonly host: SessionHost,
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

  /** initialize, then session/new or session/load. Rejects with a readable error on failure. */
  async start(loadSessionId?: string) {
    try {
      // No fs or terminal capability: the agent must not touch the host (DESIGN.md section 8).
      const init = await this.peer.request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "sandbox-console", version: "0.1.0" } },
        INIT_TIMEOUT,
      );
      this.agentInfo = init.agentInfo ?? null;
      const caps = init.agentCapabilities ?? {};
      this.canLoad = !!caps.loadSession;
      this.canList = !!caps.sessionCapabilities?.list;
      await this.begin(loadSessionId);
    } catch (e) {
      this.kill();
      throw await this.describeFailure(e);
    }
  }

  /** Start a new ACP session (or load one) on this process. Resets the event log. */
  async begin(loadSessionId?: string) {
    if (this.turn) throw new Error("The agent is working. Stop it first (Esc).");
    this.log = [];
    this.seq = 0;
    this.usage = undefined;
    this.startedAt = Date.now();
    if (loadSessionId) {
      if (!this.canLoad) throw new Error(`${this.agent.label} can't load earlier sessions.`);
      // The agent replays the conversation as session/update notifications.
      this.sessionId = loadSessionId;
      const r = await this.peer.request("session/load", { sessionId: loadSessionId, cwd: this.cwd, mcpServers: [] }, LOAD_TIMEOUT);
      if (r?.configOptions) this.configOptions = r.configOptions;
    } else {
      this.sessionId = null;
      const r = await this.peer.request("session/new", { cwd: this.cwd, mcpServers: [] }, INIT_TIMEOUT);
      if (!r?.sessionId) throw new Error("session/new returned no sessionId");
      this.sessionId = r.sessionId;
      this.configOptions = r.configOptions ?? [];
      // Updates that arrived before the reply (e.g. available_commands_update) get the id now.
      for (const ev of this.log) ev.sessionId ||= r.sessionId;
    }
    this.setState("idle");
  }

  close() {
    this.closedByUser = true;
    for (const id of [...this.permissions.keys()]) this.answer(id, null);
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
    return this.turn !== null;
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId ?? "",
      sandbox: this.sandbox,
      agent: this.agent.id,
      agentCmd: this.agent.cmd,
      agentInfo: this.agentInfo,
      canLoad: this.canLoad,
      canList: this.canList,
      cwd: this.cwd,
      configOptions: this.configOptions,
      commands: this.commands,
      state: this.state,
      startedAt: this.startedAt,
      usage: this.usage,
      lastSeq: this.seq,
    };
  }

  // ---- what the browser asks for

  prompt(text: string) {
    if (this.dead) throw new Error("The agent process has exited. Start a new session.");
    if (this.turn) throw new Error("The agent is still working on the last prompt. Wait, or stop it with Esc.");
    const sessionId = this.sessionId!;
    this.record({ type: "user_message", text });
    this.record({ type: "turn_start" });
    this.setState("working");
    this.turn = (async () => {
      try {
        const r = await this.peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        const usage: Usage | undefined = r?.usage ?? undefined;
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
        if (!this.dead) this.setState("idle");
        this.host.publish(this, { type: "session_info", session: this.info() });
      }
    })();
  }

  cancel() {
    if (!this.turn || this.dead) return;
    this.peer.notify("session/cancel", { sessionId: this.sessionId });
    // The spec: on cancel, the client answers open permission requests with "cancelled".
    for (const id of [...this.permissions.keys()]) this.answer(id, null);
    this.record({ type: "notice", text: "Stopping the agent…" });
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

  async setOption(configId: string, value: string) {
    const r = await this.peer.request("session/set_config_option", { sessionId: this.sessionId, configId, value }, 30_000);
    if (r?.configOptions) this.configOptions = r.configOptions;
    const opt = this.configOptions.find((o) => o.id === configId);
    this.record({ type: "notice", text: `${opt?.name ?? configId} set to ${value}` });
    this.host.publish(this, { type: "session_info", session: this.info() });
  }

  async listPast(): Promise<PastSession[]> {
    if (!this.canList) return [];
    const r = await this.peer.request("session/list", { cwd: this.cwd }, 30_000);
    return (r?.sessions ?? []).map((s: any) => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt, cwd: s.cwd }));
  }

  // ---- from the agent

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === "session/request_permission") {
      const requestId = String(++this.nextPermission);
      const options = (params.options ?? []) as { optionId: string; name: string }[];
      if (!options.length) return { outcome: { outcome: "cancelled" } };
      return new Promise((resolve) => {
        this.permissions.set(requestId, { options, resolve });
        this.record({ type: "permission_request", requestId, toolCall: params.toolCall ?? {}, options: params.options });
        this.setState("waiting");
      });
    }
    // fs/*, terminal/* and anything else: refused. The agent works only inside its sandbox.
    this.record({ type: "notice", text: `Refused the agent's request ${method} (the console gives no host access).` });
    throw new RpcError(method, METHOD_NOT_FOUND, `not supported: ${method}`);
  }

  private onNotification(method: string, params: any) {
    if (method !== "session/update") return;
    if (this.sessionId && params.sessionId && params.sessionId !== this.sessionId) return; // an older session on this process
    const update = params.update;
    if (!update) return;
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
    }
    this.record({ type: "event", update });
  }

  private onExit(code: number | null) {
    if (this.dead) return;
    this.dead = true;
    this.exitCode = code;
    for (const p of this.permissions.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    this.permissions.clear();
    // Give the stderr reader a moment to drain.
    setTimeout(() => {
      const tail = [...this.peer.stderrTail];
      this.state = "dead";
      if (this.sessionId) {
        this.record({ type: "session_closed", exitCode: code, stderrTail: tail.slice(-15), hint: code === 0 || this.closedByUser ? undefined : exitHint(code, tail, this.agent) });
      }
      this.host.publish(this, { type: "session_info", session: this.info() });
      this.host.changed(this);
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

  // ---- event log

  private record(ev: NewEvent) {
    const full = { ...ev, sessionId: this.sessionId ?? "", seq: ++this.seq, ts: Date.now() } as SessionEvent;
    this.log.push(full);
    if (this.log.length > MAX_EVENTS) this.log = bound(this.log, MAX_EVENTS);
    this.lastActivity = full.ts;
    // Without an id yet, tabs get it in the replay after session_opened.
    if (this.sessionId) this.host.publish(this, full);
  }

  private setState(s: ActivityState) {
    if (this.state === s) return;
    this.state = s;
    this.host.publish(this, { type: "session_info", session: this.info() });
    this.host.changed(this);
  }
}
