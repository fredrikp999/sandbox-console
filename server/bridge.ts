// The bridge's core: polls OpenShell for sandboxes, owns the agent sessions and
// handles messages from the browser tabs.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import type {
  AgentId,
  CatalogKind,
  ClientMessage,
  GatewayStatus,
  ImageBuild,
  NetworkHost,
  RepoLink,
  RepoOp,
  RepoReview,
  SandboxCatalog,
  SandboxRow,
  ServerMessage,
} from "../shared/protocol.ts";
import * as catalog from "./catalog.ts";
import { type AgentConfig, agentInfo, findConfigs, findPolicy, loadAgents, StateStore } from "./config.ts";
import * as editor from "./editor.ts";
import type { Explained } from "./hints.ts";
import * as os from "./openshell.ts";
import * as ports from "./ports.ts";
import * as repos from "./repos.ts";
import { Session, type SessionHost, type Thread } from "./session.ts";
import { type StoredThread, ThreadStore } from "./threadstore.ts";
import * as types from "./types.ts";
import { NEW_SANDBOX_NAME, parseClientMessage, SANDBOX_NAME } from "./validate.ts";

const LIST_EVERY = 3_000;
const STATUS_EVERY = 10_000;
/** How long a detection by name (or a failed one) is trusted before asking `sandbox get` again. */
const DETECT_TTL = 60_000;
/** Network results are shared by all tabs for this long. */
const NETWORK_TTL = 10_000;
const REPO_OPS: RepoOp[] = ["link", "send", "get", "review", "merge", "push", "unlink"];

interface Tab {
  ws: WebSocket;
  subs: Set<Thread>;
}

export class Bridge implements SessionHost {
  readonly agents = loadAgents();
  readonly state = new StateStore();
  readonly policy = findPolicy();
  readonly configs = findConfigs();
  readonly types = types.loadTypes();
  readonly portPresets = ports.loadPresets();
  /** The image build running or last run; one at a time. */
  private build: ImageBuild | null = null;
  readonly editors = editor.availableEditors();
  private threadStore = new ThreadStore(join(dirname(this.state.file), "threads"));
  /** Saved threads that no agent process has loaded since the bridge started (or the process exited). Shown as exited. */
  private archive = new Map<string, StoredThread>(); // by session id
  private tabs = new Set<Tab>();
  private sessions = new Map<string, Session>(); // by sandbox name
  private raw: os.RawSandbox[] = [];
  private listError: string | undefined;
  private detected = new Map<string, { agent: AgentId | null; source: SandboxRow["agentSource"]; at: number }>(); // by sandbox id
  private listing: Promise<void> | null = null;
  private network = new Map<string, { at: number; since: number; result: Promise<NetworkHost[]> }>(); // by sandbox
  private gateway: GatewayStatus = { name: "openshell", status: "unknown" };
  private timers: NodeJS.Timeout[] = [];
  /** Sandboxes with a repository action running: one at a time each. */
  private repoBusy = new Set<string>();

  constructor() {
    for (const t of this.threadStore.loadAll()) {
      if (!this.threadStore.isDeleted(t.info.sandbox, t.info.sessionId))
        this.archive.set(t.info.sessionId, { ...t, info: { ...t.info, state: "dead" } });
    }
  }

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
    this.threadStore.flush();
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
      sessions: [
        ...[...this.sessions.values()].flatMap((s) => [...s.threads.values()].map((t) => t.info())),
        ...[...this.archive.values()].map((a) => a.info),
      ],
      canCreate: true,
      editors: this.editors,
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

  persist(thread: Thread) {
    this.threadStore.schedule({ sandbox: thread.sandbox, sessionId: thread.sessionId, read: () => thread.diskSnapshot() });
  }

  archived(sandbox: string, sessionId: string) {
    const a = this.archive.get(sessionId);
    return a?.info.sandbox === sandbox ? a : undefined;
  }

  private findThread(id: string): Thread | undefined {
    for (const s of this.sessions.values()) {
      const t = s.threads.get(id);
      if (t) return t;
    }
  }

  private bySessionId(id: string): Thread {
    const found = this.findThread(id);
    if (found) return found;
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
        const saved = this.archive.get(msg.sessionId);
        if (saved) {
          // Nothing more will happen to it until it is resumed.
          for (const ev of saved.log) if (ev.seq > msg.sinceSeq) this.send(tab, ev);
          this.send(tab, { type: "replay_done", sessionId: msg.sessionId, lastSeq: saved.log.at(-1)?.seq ?? msg.sinceSeq });
          return;
        }
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

      case "delete_thread":
        if (!this.deleteThread(msg.sessionId, msg.reqId)) throw new Error("That thread is already gone.");
        this.changed();
        return;

      case "delete_threads": {
        const ids = [...this.archive.values()].filter((a) => a.info.sandbox === msg.sandbox).map((a) => a.info.sessionId);
        ids.push(...(this.sessions.get(msg.sandbox)?.threads.keys() ?? []));
        for (const id of ids) this.deleteThread(id, msg.reqId);
        this.send(tab, { type: "result", reqId: msg.reqId, ok: true, message: `Deleted ${ids.length} threads` });
        this.changed();
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
        const proc = this.bySessionId(msg.sessionId).proc;
        try {
          const sessions = (await proc.listPast()).filter(
            (p) => !proc.threads.has(p.sessionId) && !this.archive.has(p.sessionId) && !this.threadStore.isDeleted(proc.sandbox, p.sessionId),
          );
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

      case "ports":
      case "forward":
        return this.ports(tab, msg);

      case "sandbox_types":
        this.send(tab, {
          type: "sandbox_types",
          reqId: msg.reqId,
          types: await types.describe(this.types, this.configs),
          build: this.build,
          buildNote: this.configs ? undefined : "openshell-configs wasn't found (set OPENSHELL_CONFIGS), so images can't be built from here.",
        });
        return;

      case "build_image": {
        const t = this.types.find((x) => x.id === msg.sandboxType);
        if (!t) throw new Error(`Unknown sandbox type ${msg.sandboxType}`);
        if (!this.configs)
          throw Object.assign(new Error("openshell-configs wasn't found, so the image can't be built from here."), {
            hint: "Set OPENSHELL_CONFIGS to your checkout.",
          });
        if (this.build?.state === "running") throw new Error(`${this.build.target} is being built. Wait for it to finish.`);
        this.build = types.build(t, this.configs, (b) => {
          this.build = b;
          this.broadcast({ type: "image_build", build: b });
        });
        this.broadcast({ type: "image_build", build: this.build });
        this.send(tab, { type: "result", reqId: msg.reqId, ok: true, message: `Building ${t.image}…` });
        return;
      }

      case "repo":
        return this.repo(tab, msg);

      case "catalog":
        return this.catalog(tab, msg);

      case "open_editor": {
        if (!editor.isEditor(msg.editor)) throw new Error(`Unknown editor ${msg.editor}`);
        const sb = this.sandbox(msg.sandbox);
        if (sb.phase !== "Ready") throw new Error(`Sandbox ${sb.name} is ${sb.phase}, not Ready.`);
        const r = await editor.openEditor(msg.editor, sb.name, msg.folder);
        this.send(tab, { type: "editor_opened", reqId: msg.reqId, ...r });
        return;
      }

      case "editor_setting":
        if (!editor.isEditor(msg.editor)) throw new Error(`Unknown editor ${msg.editor}`);
        editor.addServerSetting(msg.editor);
        this.send(tab, { type: "result", reqId: msg.reqId, ok: true, message: "Added. Reload any open window for it to apply." });
        return;

      case "delete_sandbox": {
        this.sandbox(msg.name);
        this.sessions.get(msg.name)?.close();
        this.sessions.delete(msg.name);
        // Its forwards would point at nothing.
        for (const f of await ports.list().catch(() => [])) {
          if (f.sandbox === msg.name) await ports.stop(msg.name, f.port, []).catch(() => {});
        }
        await os.deleteSandbox(msg.name);
        this.state.forget(msg.name);
        this.purgeThreads(msg.name);
        this.send(tab, { type: "result", reqId: msg.reqId, ok: true, message: `Deleted ${msg.name}` });
        await this.refreshList();
        return;
      }
    }
  }

  private async repo(tab: Tab, msg: Extract<ClientMessage, { type: "repo" }>) {
    if (!REPO_OPS.includes(msg.op)) throw new Error(`Unknown repository action ${msg.op}`);
    const sb = this.sandbox(msg.sandbox);
    const name = sb.name;
    const links = this.state.get(name).repos ?? [];
    const save = (r: RepoLink) => this.state.set(name, { repos: [...links.filter((x) => x.name !== r.name), r] });
    const ready = () => {
      if (sb.phase !== "Ready") throw new Error(`Sandbox ${name} is ${sb.phase}, not Ready.`);
    };
    const linked = () => {
      const r = links.find((x) => x.name === msg.repo);
      if (!r) throw new Error(`No repository ${JSON.stringify(msg.repo ?? "")} is linked to ${name}.`);
      return { ...r };
    };
    if (this.repoBusy.has(name)) throw new Error(`Another repository action is running for ${name}. Wait for it to finish.`);
    this.repoBusy.add(name);
    const log: string[] = [];
    let r: RepoLink | null = null;
    let review: RepoReview | undefined;
    try {
      switch (msg.op) {
        case "link": {
          ready();
          r = await repos.link({ sandbox: name, source: msg.source ?? "", base: msg.base, dest: msg.dest }, links, log);
          // Saved before sending, so a failed send can be retried with "Send latest".
          save(r);
          await repos.sendIn(name, r, log);
          r.sentAt = Date.now();
          save(r);
          const cwd = this.state.get(name).cwd;
          if (!cwd || cwd === "/sandbox") {
            this.state.set(name, { cwd: r.sandboxPath });
            log.push(`New sessions in ${name} start in ${r.sandboxPath}.`);
          }
          break;
        }
        case "send":
          ready();
          r = linked();
          await repos.sendIn(name, r, log);
          r.sentAt = Date.now();
          save(r);
          break;
        case "get":
          ready();
          r = linked();
          await repos.getOut(name, r, log);
          r.fetchedAt = Date.now();
          save(r);
          review = await repos.review(r);
          break;
        case "review":
          r = linked();
          review = await repos.review(r);
          break;
        case "merge":
          r = linked();
          await repos.merge(r, log);
          r.mergedAt = Date.now();
          save(r);
          // So the sandbox counts its next commits from what was merged.
          if (sb.phase === "Ready") {
            try {
              await repos.sendIn(name, r, log, false);
              r.sentAt = Date.now();
              save(r);
            } catch (e) {
              log.push(`warning: couldn't send the merged ${r.base} into the sandbox: ${(e as Error).message}`);
            }
          }
          review = await repos.review(r);
          break;
        case "push":
          r = linked();
          await repos.push(r, log);
          r.pushedAt = Date.now();
          save(r);
          break;
        case "unlink":
          r = linked();
          this.state.set(name, { repos: links.filter((x) => x.name !== r?.name) });
          log.push(`Unlinked ${r.name}. Nothing was deleted: ${r.hostPath} and ${r.sandboxPath} are still there.`);
          break;
      }
    } catch (e) {
      // Keep what did happen before the failure (e.g. the clone).
      const err = e as Explained;
      if (log.length) err.detail = [...log, err.detail].filter(Boolean).join("\n");
      throw err;
    } finally {
      this.repoBusy.delete(name);
      this.changed();
    }
    this.send(tab, { type: "repo_result", reqId: msg.reqId, sandbox: name, repo: r?.name ?? null, log, review });
  }

  private async catalog(tab: Tab, msg: Extract<ClientMessage, { type: "catalog" }>) {
    const log: string[] = [];
    const reply = (items: catalog.Entry[], sandbox?: SandboxCatalog, preview?: string) =>
      this.send(tab, {
        type: "catalog",
        reqId: msg.reqId,
        items: items.map(({ path: _, format: __, ...i }) => i),
        folder: catalog.USER_CATALOG.replace(homedir(), "~"),
        sandbox,
        preview,
        log,
      });
    if (msg.op === "list" && !msg.sandbox) return reply(await catalog.list());
    if (!["list", "preview", "install", "remove"].includes(msg.op)) throw new Error(`Unknown catalog action ${msg.op}`);
    if (!msg.sandbox) throw new Error("Which sandbox?");
    const sb = this.sandbox(msg.sandbox);
    const name = sb.name;
    const row = this.rows().find((r) => r.name === name);
    const agentId = row?.session?.agent ?? row?.agent;
    if (!agentId) throw new Error(`Which agent runs in ${name}? Choose it in the sidebar first.`);
    const agent = this.agent(agentId);
    const layout = agent.layout ?? (agent.id === "opencode" ? "opencode" : "claude");
    const item = async () => {
      const kind = msg.kind as CatalogKind;
      if (!catalog.KINDS.includes(kind) || !msg.name || !catalog.ITEM_NAME.test(msg.name)) throw new Error("Which catalog item?");
      return { kind, name: msg.name };
    };
    const look = async (): Promise<SandboxCatalog> => {
      const view: SandboxCatalog = {
        agent: agent.id,
        places: catalog.PLACES[layout],
        present: [],
        installed: this.state.get(name).catalog ?? [],
      };
      if (sb.phase !== "Ready") return { ...view, error: `${name} is ${sb.phase}, not Ready.` };
      try {
        view.present = await catalog.present(name, layout);
      } catch (e) {
        view.error = `${(e as Error).message}: ${(e as Explained).detail ?? ""}`.trim();
      }
      return view;
    };

    if (msg.op === "preview") {
      const { kind, name: n } = await item();
      return reply([], undefined, await catalog.preview(await catalog.find(kind, n), layout));
    }
    if (msg.op === "install" || msg.op === "remove") {
      if (sb.phase !== "Ready") throw new Error(`Sandbox ${name} is ${sb.phase}, not Ready.`);
      const { kind, name: n } = await item();
      if (this.repoBusy.has(name)) throw new Error(`Something else is being copied into ${name}. Wait for it to finish.`);
      this.repoBusy.add(name);
      try {
        const others = (this.state.get(name).catalog ?? []).filter((i) => !(i.kind === kind && i.name === n));
        if (msg.op === "install") {
          const done = await catalog.install(name, await catalog.find(kind, n), layout, log);
          this.state.set(name, { catalog: [...others, done] });
        } else {
          await catalog.remove(name, kind, n, layout, log);
          this.state.set(name, { catalog: others });
        }
      } finally {
        this.repoBusy.delete(name);
      }
      if (this.sessions.has(name)) log.push("New threads pick this up. A thread that's already running may not until the agent restarts.");
    }
    return reply(await catalog.list(), await look());
  }

  private async ports(tab: Tab, msg: Extract<ClientMessage, { type: "ports" | "forward" }>) {
    const sb = this.sandbox(msg.sandbox);
    const log: string[] = [];
    if (msg.type === "forward") {
      if (msg.op !== "start" && msg.op !== "stop") throw new Error(`Unknown forward action ${msg.op}`);
      if (msg.op === "start") {
        if (sb.phase !== "Ready") throw new Error(`Sandbox ${sb.name} is ${sb.phase}, not Ready.`);
        await ports.start(sb.name, msg.port, log);
      } else await ports.stop(sb.name, msg.port, log);
    }
    const [forwards, open] = await Promise.all([
      ports.list().then((all) => all.filter((f) => f.sandbox === sb.name)),
      sb.phase === "Ready"
        ? ports
            .listening(sb.name, this.portPresets)
            .then((l) => ({ l }))
            .catch((e: Explained) => ({ e }))
        : Promise.resolve({ l: [] }),
    ]);
    const listening = "l" in open ? open.l : [];
    this.send(tab, {
      type: "ports",
      reqId: msg.reqId,
      sandbox: sb.name,
      forwards,
      listening,
      presets: ports.presetsFor(this.portPresets, this.state.get(sb.name).type, listening),
      log,
      error: "e" in open ? `${open.e.message}${open.e.detail ? `: ${open.e.detail}` : ""}` : undefined,
    });
  }

  /** Forget a thread, live or saved. False if there is no such thread. */
  private deleteThread(sessionId: string, reqId?: string): boolean {
    const live = this.findThread(sessionId);
    const sandbox = live?.sandbox ?? this.archive.get(sessionId)?.info.sandbox;
    if (!sandbox) return false;
    if (live) {
      live.proc.dropThread(sessionId);
      for (const t of this.tabs) t.subs.delete(live);
    }
    this.archive.delete(sessionId);
    this.threadStore.remove(sandbox, sessionId);
    this.broadcast({ type: "thread_deleted", reqId, sessionId });
    return true;
  }

  private async openSession(msg: Extract<ClientMessage, { type: "open_session" }>) {
    const agent = this.agent(msg.agent);
    const cwd = msg.cwd?.trim() || "/sandbox";
    if (!cwd.startsWith("/")) throw new Error("The working directory must be an absolute path inside the sandbox.");
    const existing = this.sessions.get(msg.sandbox);

    if (existing?.alive) {
      // Reuse the running agent process. An earlier session is loaded as another thread.
      const thread = msg.loadSessionId ? await existing.newThread(msg.loadSessionId) : (existing.latest ?? (await existing.newThread()));
      this.archive.delete(thread.sessionId);
      this.broadcast({ type: "session_opened", reqId: msg.reqId, session: thread.info() });
      return;
    }

    const sb = this.sandbox(msg.sandbox);
    if (sb.phase !== "Ready") {
      throw Object.assign(new Error(`Sandbox ${msg.sandbox} is ${sb.phase}, not Ready.`), {
        hint: "Wait for it, or delete it and create it again.",
      });
    }

    // The exited process's threads stay as saved ones; one of them can be loaded into the new process.
    if (existing) for (const t of existing.threads.values()) this.archive.set(t.sessionId, t.snapshot());
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
    this.archive.delete(thread.sessionId);
    this.broadcast({ type: "session_opened", reqId: msg.reqId, session: thread.info() });
    this.changed();
  }

  private async create(tab: Tab, msg: Extract<ClientMessage, { type: "create_sandbox" }>) {
    const name = msg.name.trim();
    if (!NEW_SANDBOX_NAME.test(name)) {
      throw new Error("Use lowercase letters, digits and dashes for the name (max 63 characters).");
    }
    if (this.raw.some((s) => s.name === name)) throw new Error(`A sandbox named ${name} already exists.`);
    const t = msg.sandboxType ? this.types.find((x) => x.id === msg.sandboxType) : undefined;
    if (msg.sandboxType && !t) throw new Error(`Unknown sandbox type ${msg.sandboxType}`);
    const agent = this.agent(t?.agent ?? msg.agent ?? "");
    const image = t?.image ?? agent.image;
    if (!image) throw new Error(`No image is configured for ${agent.label} in server/agents.json.`);
    let policy = this.policy;
    if (t?.policy) {
      policy = types.policyPath(t, this.configs);
      // Its own policy is part of what the type is: without it, don't fall back to another.
      if (!policy)
        throw Object.assign(new Error(`policies/${t.policy} wasn't found, so ${t.label} can't be created.`), {
          hint: "Set OPENSHELL_CONFIGS to your openshell-configs checkout.",
        });
    }
    if (t && (await types.imageState(image)) === "missing") {
      throw Object.assign(new Error(`The image ${image} isn't built yet.`), {
        hint: `Build it first (make ${t.build ?? "images"} in openshell-configs).`,
      });
    }
    const workdir = msg.workdir?.trim() || "/sandbox";
    this.state.set(name, { agent: agent.id, cwd: workdir, type: t?.id });
    try {
      await os.createSandbox({ name, image, provider: agent.provider, policy });
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
        this.purgeThreads(name);
      }
    }
    if (!this.listError) {
      const gone = new Set([...this.archive.values()].map((a) => a.info.sandbox).filter((n) => !this.raw.some((r) => r.name === n)));
      for (const name of gone) this.purgeThreads(name);
    }
    this.changed();
  }

  /** The sandbox is gone: so are its threads. */
  private purgeThreads(sandbox: string) {
    const ids = [...this.archive.values()].filter((a) => a.info.sandbox === sandbox).map((a) => a.info.sessionId);
    for (const s of this.sessions.values()) if (s.sandbox === sandbox) ids.push(...s.threads.keys());
    for (const id of ids) {
      this.archive.delete(id);
      this.broadcast({ type: "thread_deleted", sessionId: id });
    }
    this.threadStore.removeSandbox(sandbox);
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
        type: this.types.find((t) => t.id === remembered.type)?.label,
        cwd: remembered.cwd,
        model: remembered.model,
        repos: remembered.repos ?? [],
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
