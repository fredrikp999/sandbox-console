// The bridge's core: polls OpenShell for sandboxes, owns the agent sessions and
// handles messages from the browser tabs.
import type { WebSocket } from "ws";
import type { AgentId, ClientMessage, GatewayStatus, SandboxRow, ServerMessage } from "../shared/protocol.ts";
import { type AgentConfig, agentInfo, findPolicy, loadAgents, StateStore } from "./config.ts";
import * as os from "./openshell.ts";
import { Session, type SessionHost } from "./session.ts";

const LIST_EVERY = 3_000;
const STATUS_EVERY = 10_000;
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

interface Tab {
  ws: WebSocket;
  subs: Set<Session>;
}

export class Console implements SessionHost {
  readonly agents = loadAgents();
  readonly state = new StateStore();
  readonly policy = findPolicy();
  private tabs = new Set<Tab>();
  private sessions = new Map<string, Session>(); // by sandbox name
  private raw: os.RawSandbox[] = [];
  private listError: string | undefined;
  private detected = new Map<string, { agent: AgentId | null; source: SandboxRow["agentSource"] }>(); // by sandbox id
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
        msg = JSON.parse(String(data));
      } catch {
        return this.send(tab, { type: "error", message: "Bad message from the browser" });
      }
      this.handle(tab, msg).catch((e) =>
        this.send(tab, {
          type: "error",
          reqId: (msg as any).reqId,
          sessionId: (msg as any).sessionId,
          message: e.message ?? String(e),
          detail: e.detail,
          hint: e.hint,
        }),
      );
    });
    this.send(tab, {
      type: "hello",
      agents: [...this.agents.values()].map(agentInfo),
      sessions: [...this.sessions.values()].filter((s) => s.sessionId).map((s) => s.info()),
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

  publish(session: Session, msg: ServerMessage) {
    const sessionScoped = msg.type !== "session_info";
    for (const t of this.tabs) if (!sessionScoped || t.subs.has(session)) this.send(t, msg);
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

  private bySessionId(id: string): Session {
    for (const s of this.sessions.values()) if (s.sessionId === id) return s;
    throw Object.assign(new Error("That session is no longer open."), { hint: "Start a new session from the sandbox list." });
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
        return this.openSession(tab, msg);

      case "new_session": {
        const s = this.bySessionId(msg.sessionId);
        await s.begin();
        this.broadcast({ type: "session_opened", reqId: msg.reqId, session: s.info() });
        return;
      }

      case "close_session": {
        const s = this.bySessionId(msg.sessionId);
        s.close();
        return;
      }

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
        const s = this.bySessionId(msg.sessionId);
        try {
          const sessions = (await s.listPast()).filter((p) => p.sessionId !== s.sessionId);
          this.send(tab, { type: "past_sessions", reqId: msg.reqId, sessionId: msg.sessionId, sessions });
        } catch (e) {
          this.send(tab, { type: "past_sessions", reqId: msg.reqId, sessionId: msg.sessionId, sessions: [], error: (e as Error).message });
        }
        return;
      }

      case "network": {
        const s = this.bySessionId(msg.sessionId);
        try {
          const hosts = await os.networkSince(s.sandbox, s.spawnedAt);
          this.send(tab, { type: "network", reqId: msg.reqId, sessionId: msg.sessionId, hosts });
        } catch (e) {
          this.send(tab, { type: "network", reqId: msg.reqId, sessionId: msg.sessionId, hosts: [], error: (e as Error).message });
        }
        return;
      }

      case "set_sandbox_agent":
        this.agent(msg.agent);
        this.state.set(msg.name, { agent: msg.agent });
        this.changed();
        return;

      case "create_sandbox":
        return this.create(tab, msg);

      case "delete_sandbox": {
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

  private async openSession(tab: Tab, msg: Extract<ClientMessage, { type: "open_session" }>) {
    const agent = this.agent(msg.agent);
    const cwd = msg.cwd?.trim() || "/sandbox";
    if (!cwd.startsWith("/")) throw new Error("The working directory must be an absolute path inside the sandbox.");
    const existing = this.sessions.get(msg.sandbox);

    if (existing?.alive) {
      if (msg.loadSessionId) {
        // Reuse the running agent process: session/load on the same connection.
        await existing.begin(msg.loadSessionId);
        this.broadcast({ type: "session_opened", reqId: msg.reqId, session: existing.info() });
      } else {
        this.send(tab, { type: "session_opened", reqId: msg.reqId, session: existing.info() });
      }
      return;
    }

    const sb = this.raw.find((s) => s.name === msg.sandbox);
    if (sb && sb.phase !== "Ready") {
      throw Object.assign(new Error(`Sandbox ${msg.sandbox} is ${sb.phase}, not Ready.`), {
        hint: "Wait for it, or delete it and create it again.",
      });
    }

    const remembered = this.state.get(msg.sandbox);
    const model = msg.model || remembered.model;
    const session = new Session(msg.sandbox, agent, cwd, model, this);
    this.sessions.set(msg.sandbox, session);
    this.changed();
    try {
      await session.start(msg.loadSessionId);
    } catch (e) {
      if (this.sessions.get(msg.sandbox) === session) this.sessions.delete(msg.sandbox);
      this.changed();
      throw e;
    }
    this.state.set(msg.sandbox, { agent: agent.id, cwd });
    this.broadcast({ type: "session_opened", reqId: msg.reqId, session: session.info() });
    this.changed();
  }

  private async create(tab: Tab, msg: Extract<ClientMessage, { type: "create_sandbox" }>) {
    const name = msg.name.trim();
    if (!NAME_RE.test(name)) {
      throw new Error("Use lowercase letters, digits and dashes for the name (max 63 characters).");
    }
    if (this.raw.some((s) => s.name === name)) throw new Error(`A sandbox named ${name} already exists.`);
    const agent = this.agent(msg.agent);
    if (!agent.image) throw new Error(`No image is configured for ${agent.label} in agents.json.`);
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

  private async refreshList() {
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
    if (this.detected.has(s.id) && this.detected.get(s.id)!.source === "policy") return;
    if (s.phase === "Ready") {
      try {
        const full = await os.getSandbox(s.name);
        const keys = Object.keys(full.policy?.network_policies ?? {});
        for (const a of this.agents.values()) {
          if (a.provider && keys.includes(`_provider_${a.provider}`)) {
            this.detected.set(s.id, { agent: a.id, source: "policy" });
            return;
          }
        }
      } catch {
        /* fall back to the name */
      }
    }
    for (const a of this.agents.values()) {
      if (s.name === a.id || s.name.startsWith(`${a.id}-`)) {
        this.detected.set(s.id, { agent: a.id, source: "name" });
        return;
      }
    }
    this.detected.set(s.id, { agent: null, source: null });
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
          sessionId: session.sessionId,
          state: session.state,
          lastActivity: session.lastActivity,
          agent: session.agent.id,
        },
      };
    });
  }

  /** For the bundle download: the sandbox and directory of an open session. */
  sessionFor(sessionId: string) {
    return this.bySessionId(sessionId);
  }
}
