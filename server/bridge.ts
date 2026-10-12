// The bridge's core: polls OpenShell for sandboxes, owns the agent sessions and
// handles messages from the browser tabs.
import type { WebSocket } from "ws";
import type { AgentId, ClientMessage, GatewayStatus, NetworkHost, SandboxRow, ServerMessage } from "../shared/protocol.ts";
import { type AgentConfig, agentInfo, findPolicy, loadAgents, StateStore } from "./config.ts";
import type { Explained } from "./hints.ts";
import * as os from "./openshell.ts";
import { Session, type SessionHost, type Thread } from "./session.ts";
import { NEW_SANDBOX_NAME, parseClientMessage, SANDBOX_NAME } from "./validate.ts";

const LIST_EVERY = 3_000;
const STATUS_EVERY = 10_000;
/** How long a detection by name (or a failed one) is trusted before asking `sandbox get` again. */
const DETECT_TTL = 60_000;
/** Network results are shared by all tabs for this long. */
const NETWORK_TTL = 10_000;

interface Tab {
  ws: WebSocket;
  subs: Set<Thread>;
}

export class Bridge implements SessionHost {
  readonly agents = loadAgents();
  readonly state = new StateStore();
  readonly policy = findPolicy();
  private tabs = new Set<Tab>();
  private sessions = new Map<string, Session>(); // by sandbox name
  private raw: os.RawSandbox[] = [];
  private listError: string | undefined;
  private detected = new Map<string, { agent: AgentId | null; source: SandboxRow["agentSource"]; at: number }>(); // by sandbox id
  private listing: Promise<void> | null = null;
  private network = new Map<string, { at: number; since: number; result: Promise<NetworkHost[]> }>(); // by sandbox
  private gateway: GatewayStatus = { name: "openshell", status: "unknown" };
  private timers: NodeJS.Timeout[] = [];

  start() {
    const list = () => this.refreshList().catch(() => {});
    const status = () => this.refreshStatus().catch(() => {});
    list();
    status();
    this.timers.push(setInterval(list, LIST_EVERY), setInterval(status, STATUS_EVERY));
  }

  stop() {
    this.timers.forEach(clearInterval);
    for (const s of this.sessions.values()) s.close();
  }

  // ---- tabs

  attach(ws: WebSocket) {
    const tab: Tab = { ws, subs: new Set() };
    this.tabs.add(tab);
    ws.on("close", () => this.tabs.delete(tab));
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(String(data));
      } catch (e) {
        return this.send(tab, { type: "error", reqId: (e as Explained).reqId, message: (e as Error).message });
      }
      this.handle(tab, msg).catch((e: Explained) =>
        this.send(tab, {
          type: "error",
          reqId: "reqId" in msg ? msg.reqId : undefined,
          sessionId: "sessionId" in msg ? msg.sessionId : undefined,
          message: e.message ?? String(e),
          detail: e.detail,
          hint: e.hint,
        }),
      );
    });
    this.send(tab, {
      type: "hello",
      agents: [...this.agents.values()].map(agentInfo),
      sessions: [...this.sessions.values()].flatMap((s) => [...s.threads.values()].map((t) => t.info())),
      canCreate: true,
      createNote: this.policy ? undefined : "No policies/vscode-terminal.yaml found (set OPENSHELL_CONFIGS); new sandboxes get the default policy.",
    });
    this.send(tab, { type: "gateway", gateway: this.gateway });
    this.send(tab, { type: "sandboxes", sandboxes: this.rows(), error: this.listError });
  }

  private send(tab: Tab, msg: ServerMessage) {
    if (tab.ws.readyState === tab.ws.OPEN) tab.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage) {
    for (const t of this.tabs) this.send(t, msg);
  }

  publish(thread: Thread, msg: ServerMessage) {
    const sessionScoped = msg.type !== "session_info";
    for (const t of this.tabs) if (!sessionScoped || t.subs.has(thread)) this.send(t, msg);
  }

  private lastRows = "";

  /** Send the sandbox list to every tab, if it changed. */
  changed() {
    const msg: ServerMessage = { type: "sandboxes", sandboxes: this.rows(), error: this.listError };
    const text = JSON.stringify(msg);
    if (text === this.lastRows) return;
    this.lastRows = text;
    for (const t of this.tabs) if (t.ws.readyState === t.ws.OPEN) t.ws.send(text);
  }

  private bySessionId(id: string): Thread {
    for (const s of this.sessions.values()) {
      const t = s.threads.get(id);
      if (t) return t;
    }
    throw Object.assign(new Error("That session is no longer open."), { hint: "Start a new session from the sandbox list." });
  }

  /** A sandbox that exists right now. Names from the browser go nowhere else. */
  private sandbox(name: string): os.RawSandbox {
    const sb = SANDBOX_NAME.test(name) ? this.raw.find((s) => s.name === name) : undefined;
    if (!sb) {
      throw Object.assign(new Error(`There is no sandbox named ${JSON.stringify(name)}.`), {
        hint: this.listError ? "The sandbox list couldn't be read. Check `openshell status`." : undefined,
      });
    }
    return sb;
  }

  private agent(id: AgentId): AgentConfig {
    const a = this.agents.get(id);
    if (!a) throw new Error(`Unknown agent ${id}`);
    return a;
  }

  private async handle(tab: Tab, msg: ClientMessage) {
    switch (msg.type) {
      case "list_sandboxes":
        await this.refreshList();
        return;

      case "subscribe": {
        const s = this.bySessionId(msg.sessionId);
        for (const ev of s.log) if (ev.seq > msg.sinceSeq) this.send(tab, ev);
        tab.subs.add(s);
        this.send(tab, { type: "replay_done", sessionId: msg.sessionId, lastSeq: s.log.at(-1)?.seq ?? msg.sinceSeq });
        return;
      }

      case "open_session":
        return this.openSession(msg);

      case "new_thread": {
        const proc = this.sessions.get(msg.sandbox);
        if (!proc?.alive) {
          throw Object.assign(new Error("The agent isn't running in this sandbox."), { hint: "Start a session from the sandbox list." });
        }
        const t = await proc.newThread();
        this.broadcast({ type: "session_opened", reqId: msg.reqId, session: t.info() });
        return;
      }

      case "close_session":
        this.bySessionId(msg.sessionId).proc.close();
        return;

      case "prompt":
        this.bySessionId(msg.sessionId).prompt(msg.text);
        return;

      case "cancel":
        this.bySessionId(msg.sessionId).cancel();
        return;

      case "permission_answer":
        // False when another tab answered first; nothing to do then.
        this.bySessionId(msg.sessionId).answer(msg.requestId, msg.optionId);
        return;

      case "set_option": {
        const s = this.bySessionId(msg.sessionId);
        await s.setOption(msg.configId, msg.value);
        const opt = s.configOptions.find((o) => o.id === msg.configId);
        if (opt?.category === "model" || msg.configId === "model") this.state.set(s.sandbox, { model: msg.value });
        this.send(tab, { type: "result", reqId: msg.reqId, ok: true });
        return;
      }

      case "list_past_sessions": {
        const proc = this.bySessionId(msg.sessionId).proc;
        try {
          const sessions = (await proc.listPast()).filter((p) => !proc.threads.has(p.sessionId));
          this.send(tab, { type: "past_sessions", reqId: msg.reqId, sessionId: msg.sessionId, sessions });
        } catch (e) {
          this.send(tab, { type: "past_sessions", reqId: msg.reqId, sessionId: msg.sessionId, sessions: [], error: (e as Error).message });
        }
        return;
      }

      case "network": {
        const s = this.bySessionId(msg.sessionId);
        try {
          const hosts = await this.networkFor(s.proc);
          this.send(tab, { type: "network", reqId: msg.reqId, sessionId: msg.sessionId, hosts });
        } catch (e) {
          this.send(tab, { type: "network", reqId: msg.reqId, sessionId: msg.sessionId, hosts: [], error: (e as Error).message });
        }
        return;
      }

      case "set_sandbox_agent":
        this.sandbox(msg.name);
        this.agent(msg.agent);
        this.state.set(msg.name, { agent: msg.agent });
        this.changed();
        return;

      case "create_sandbox":
        return this.create(tab, msg);

      case "delete_sandbox": {
        this.sandbox(msg.name);
        this.sessions.get(msg.name)?.close();
        this.sessions.delete(msg.name);
        await os.deleteSandbox(msg.name);
        this.state.forget(msg.name);
        this.send(tab, { type: "result", reqId: msg.reqId, ok: true, message: `Deleted ${msg.name}` });
        await this.refreshList();
        return;
      }
    }
  }

  private async openSession(msg: Extract<ClientMessage, { type: "open_session" }>) {
    const agent = this.agent(msg.agent);
    const cwd = msg.cwd?.trim() || "/sandbox";
    if (!cwd.startsWith("/")) throw new Error("The working directory must be an absolute path inside the sandbox.");
    const existing = this.sessions.get(msg.sandbox);

    if (existing?.alive) {
      // Reuse the running agent process. An earlier session is loaded as another thread.
      const thread = msg.loadSessionId ? await existing.newThread(msg.loadSessionId) : (existing.latest ?? (await existing.newThread()));
      this.broadcast({ type: "session_opened", reqId: msg.reqId, session: thread.info() });
      return;
    }

    const sb = this.sandbox(msg.sandbox);
    if (sb.phase !== "Ready") {
      throw Object.assign(new Error(`Sandbox ${msg.sandbox} is ${sb.phase}, not Ready.`), {
        hint: "Wait for it, or delete it and create it again.",
      });
    }

    const remembered = this.state.get(msg.sandbox);
    const model = msg.model || remembered.model;
    const session = new Session(msg.sandbox, agent, cwd, model, this);
    this.sessions.set(msg.sandbox, session);
    this.changed();
    let thread: Thread;
    try {
      thread = await session.start(msg.loadSessionId);
    } catch (e) {
      if (this.sessions.get(msg.sandbox) === session) this.sessions.delete(msg.sandbox);
      this.changed();
      throw e;
    }
    this.state.set(msg.sandbox, { agent: agent.id, cwd });
    this.broadcast({ type: "session_opened", reqId: msg.reqId, session: thread.info() });
    this.changed();
  }

  private async create(tab: Tab, msg: Extract<ClientMessage, { type: "create_sandbox" }>) {
    const name = msg.name.trim();
    if (!NEW_SANDBOX_NAME.test(name)) {
      throw new Error("Use lowercase letters, digits and dashes for the name (max 63 characters).");
    }
    if (this.raw.some((s) => s.name === name)) throw new Error(`A sandbox named ${name} already exists.`);
    const agent = this.agent(msg.agent);
    if (!agent.image) throw new Error(`No image is configured for ${agent.label} in server/agents.json.`);
    const workdir = msg.workdir?.trim() || "/sandbox";
    this.state.set(name, { agent: agent.id, cwd: workdir });
    try {
      await os.createSandbox({ name, image: agent.image, provider: agent.provider, policy: this.policy });
    } catch (e) {
      this.state.forget(name);
      throw e;
    }
    this.send(tab, { type: "result", reqId: msg.reqId, ok: true, message: `Creating ${name}…` });
    await this.refreshList();
  }

  // ---- OpenShell polling

  /** One `sandbox list` at a time: callers share the run in flight. */
  private refreshList(): Promise<void> {
    this.listing ??= this.doRefreshList().finally(() => (this.listing = null));
    return this.listing;
  }

  private async doRefreshList() {
    try {
      this.raw = await os.listSandboxes();
      this.listError = undefined;
    } catch (e) {
      this.listError = `${(e as Error).message}${(e as os.CliError).detail ? `: ${(e as os.CliError).detail}` : ""}`;
    }
    await Promise.all(this.raw.map((s) => this.detect(s)));
    // Sessions whose sandbox is gone.
    for (const [name, s] of this.sessions) {
      if (!this.listError && !this.raw.some((r) => r.name === name)) {
        s.close();
        this.sessions.delete(name);
      }
    }
    this.changed();
  }

  private async refreshStatus() {
    try {
      const st = await os.status();
      this.gateway = { name: st.gateway ?? "openshell", status: st.status ?? "unknown", version: st.version };
    } catch (e) {
      this.gateway = { name: this.gateway.name, status: "unreachable", error: (e as Error).message };
    }
    this.broadcast({ type: "gateway", gateway: this.gateway });
  }

  /**
   * Which agent a sandbox has. `sandbox list` doesn't show the image, so look at
   * the provider in its policy (`_provider_openrouter` -> OpenCode), then the
   * name (`opencode-*`, `claude-*`, as sandbox.sh names them), then what the user told us.
   */
  private async detect(s: os.RawSandbox) {
    const known = this.detected.get(s.id);
    if (known && (known.source === "policy" || Date.now() - known.at < DETECT_TTL)) return;
    const at = Date.now();
    if (s.phase === "Ready") {
      try {
        const full = await os.getSandbox(s.name);
        const keys = Object.keys(full.policy?.network_policies ?? {});
        for (const a of this.agents.values()) {
          if (a.provider && keys.includes(`_provider_${a.provider}`)) {
            this.detected.set(s.id, { agent: a.id, source: "policy", at });
            return;
          }
        }
      } catch {
        /* fall back to the name */
      }
    }
    for (const a of this.agents.values()) {
      if (s.name === a.id || s.name.startsWith(`${a.id}-`)) {
        this.detected.set(s.id, { agent: a.id, source: "name", at });
        return;
      }
    }
    this.detected.set(s.id, { agent: null, source: null, at });
  }

  private rows(): SandboxRow[] {
    return this.raw.map((s) => {
      const remembered = this.state.get(s.name);
      const det = this.detected.get(s.id);
      const session = this.sessions.get(s.name);
      let agent = det?.agent ?? null;
      let agentSource = det?.source ?? null;
      if (det?.source !== "policy" && remembered.agent) {
        agent = remembered.agent;
        agentSource = "remembered";
      }
      return {
        name: s.name,
        phase: s.phase,
        created: s.created_at,
        agent,
        agentSource,
        message: s.phase === "Ready" ? undefined : os.readyMessage(s),
        cwd: remembered.cwd,
        model: remembered.model,
        session: session && {
          sessionId: session.latest?.sessionId ?? null,
          state: session.state,
          lastActivity: session.lastActivity,
          agent: session.agent.id,
        },
      };
    });
  }

  /** `openshell logs` for a session, shared between tabs for a few seconds. */
  private networkFor(s: Session): Promise<NetworkHost[]> {
    const hit = this.network.get(s.sandbox);
    if (hit && hit.since === s.spawnedAt && Date.now() - hit.at < NETWORK_TTL) return hit.result;
    const result = os.networkSince(s.sandbox, s.spawnedAt);
    this.network.set(s.sandbox, { at: Date.now(), since: s.spawnedAt, result });
    result.catch(() => this.network.delete(s.sandbox));
    return result;
  }

  /** For the bundle download: the sandbox and directory of an open session. */
  sessionFor(sessionId: string) {
    return this.bySessionId(sessionId);
  }
}
