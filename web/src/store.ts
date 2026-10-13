// Client state: one WebSocket to the bridge, the sandbox list, and a folded
// conversation per open session. Reconnects and replays what it missed.
import { useSyncExternalStore } from "react";
import type {
  AgentInfo,
  ClientMessage,
  EditorInfo,
  GatewayStatus,
  ImageBuild,
  SandboxRow,
  ServerMessage,
  SessionInfo,
} from "../../shared/protocol.ts";
import { authHeaders, getToken, initToken, wsProtocols } from "./auth.ts";
import { apply, type Conversation, emptyConversation } from "./conversation.ts";

export interface SessionView {
  info: SessionInfo;
  conv: Conversation;
  lastSeq: number;
  replayed: boolean;
  /** Last bridge error about this session that wasn't a reply to a request. */
  error?: { message: string; hint?: string; at: number };
}

export type Link = "connecting" | "open" | "closed" | "unauthorized";

export interface State {
  link: Link;
  agents: AgentInfo[];
  editors: EditorInfo[];
  /** The image build running or last run, from any tab. */
  build: ImageBuild | null;
  createNote?: string;
  sandboxes: SandboxRow[];
  listError?: string;
  gateway: GatewayStatus | null;
  sessions: Record<string, SessionView>;
  /** The thread shown per sandbox (always one that is open). */
  bySandbox: Record<string, string>;
  /** Threads with a tab. The others are listed in the sidebar and opened from there. */
  open: Record<string, true>;
  selected: string | null;
}

type Pending = { resolve: (m: ServerMessage) => void; reject: (e: RequestError) => void };

export class RequestError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

// Before anything reads the URL: take the token out of it.
initToken();

const OPEN_KEY = "sandbox-console-open-threads";

function loadOpen(): Record<string, true> {
  try {
    return Object.fromEntries((JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]).map((id) => [id, true as const]));
  } catch {
    return {};
  }
}

const initialSelected = () => new URLSearchParams(location.hash.slice(1)).get("sb") || null;

class Store {
  state: State = {
    link: "connecting",
    agents: [],
    editors: [],
    build: null,
    sandboxes: [],
    gateway: null,
    sessions: {},
    bySandbox: {},
    open: loadOpen(),
    selected: initialSelected(),
  };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextReq = 0;
  private retry = 500;
  private queue: ServerMessage[] = [];
  private flushScheduled = false;

  private notify() {
    for (const l of this.listeners) l();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.notify();
  }

  connect() {
    if (!getToken()) return this.set({ link: "unauthorized" });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, wsProtocols());
    this.ws = ws;
    this.set({ link: "connecting" });
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.retry = 500;
      this.set({ link: "open" });
    };
    ws.onmessage = (e) => this.enqueue(JSON.parse(e.data));
    ws.onclose = async () => {
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new RequestError("Lost the connection to the console bridge."));
      this.pending.clear();
      if (!opened) {
        // The upgrade is refused with a wrong token, e.g. after the bridge restarted with a new one.
        const r = await fetch("/api/ping", { headers: authHeaders() }).catch(() => null);
        if (r?.status === 401) return this.set({ link: "unauthorized" });
      }
      this.set({ link: "closed" });
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  // Streaming chunks arrive fast; apply them in one render per frame.
  private enqueue(m: ServerMessage) {
    this.queue.push(m);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      const batch = this.queue;
      this.queue = [];
      let s = this.state;
      for (const msg of batch) s = this.reduce(s, msg);
      this.state = s;
      this.notify();
    });
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new RequestError("Not connected to the console bridge.");
    this.ws.send(JSON.stringify(msg));
  }

  /** Send a message with a reqId and wait for the reply that carries it. */
  request<T extends ServerMessage = ServerMessage>(msg: DistributiveOmit<Extract<ClientMessage, { reqId: string }>, "reqId">): Promise<T> {
    const reqId = `r${++this.nextReq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (m: ServerMessage) => void, reject });
      try {
        this.send({ ...msg, reqId } as ClientMessage);
      } catch (e) {
        this.pending.delete(reqId);
        reject(e);
      }
    });
  }

  select(name: string | null) {
    history.replaceState(null, "", name ? `#${new URLSearchParams({ sb: name })}` : location.pathname);
    this.set({ selected: name });
  }

  /** Show a thread of a sandbox (opening its tab if it has none). */
  activate(sandbox: string, sessionId: string) {
    this.set((s) =>
      s.sessions[sessionId] ? { open: this.remember({ ...s.open, [sessionId]: true }), bySandbox: { ...s.bySandbox, [sandbox]: sessionId } } : {},
    );
  }

  /** Close a thread's tab. The thread itself stays, on the bridge and in the sidebar. */
  close(sandbox: string, sessionId: string) {
    this.set((s) => {
      const { [sessionId]: _closed, ...open } = s.open;
      return { open: this.remember(open), bySandbox: this.afterRemoval(s, sandbox, sessionId, open) };
    });
  }

  private remember(open: Record<string, true>) {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(Object.keys(open)));
    } catch {
      /* storage unavailable */
    }
    return open;
  }

  /** If the thread shown was removed, show another open one of its sandbox, if any. */
  private afterRemoval(s: State, sandbox: string, gone: string, open: Record<string, true>) {
    if (s.bySandbox[sandbox] !== gone) return s.bySandbox;
    const bySandbox = { ...s.bySandbox };
    const next = Object.values(s.sessions)
      .filter((x) => x.info.sandbox === sandbox && x.info.sessionId !== gone && open[x.info.sessionId])
      .sort((a, b) => b.info.startedAt - a.info.startedAt)[0];
    if (next) bySandbox[sandbox] = next.info.sessionId;
    else delete bySandbox[sandbox];
    return bySandbox;
  }

  private settle(m: ServerMessage & { reqId?: string }) {
    if (!m.reqId) return;
    const p = this.pending.get(m.reqId);
    if (!p) return;
    this.pending.delete(m.reqId);
    if (m.type === "error") p.reject(new RequestError(m.message, m.detail, m.hint));
    else if (m.type === "result" && !m.ok) p.reject(new RequestError(m.message ?? "Failed", undefined, m.hint));
    else p.resolve(m);
  }

  /** Add or refresh a thread. `activate` makes it the one shown for its sandbox. */
  private track(s: State, info: SessionInfo, activate: boolean): State {
    const prev = s.sessions[info.sessionId];
    const sessions = { ...s.sessions };
    // New live threads get a tab; saved ones only if they had one before.
    const isOpen = s.open[info.sessionId] || activate || (!prev && info.state !== "dead");
    const open = isOpen && !s.open[info.sessionId] ? this.remember({ ...s.open, [info.sessionId]: true }) : s.open;
    if (prev) {
      sessions[info.sessionId] = { ...prev, info };
      // A saved thread that was resumed: the bridge now publishes its new events.
      if (prev.info.state === "dead" && info.state !== "dead") {
        queueMicrotask(() => this.trySend({ type: "subscribe", sessionId: info.sessionId, sinceSeq: prev.lastSeq }));
      }
    } else {
      sessions[info.sessionId] = { info, conv: emptyConversation(), lastSeq: 0, replayed: false };
      queueMicrotask(() => this.trySend({ type: "subscribe", sessionId: info.sessionId, sinceSeq: 0 }));
    }
    const current = s.bySandbox[info.sandbox];
    // A live thread replaces an exited one as the thread shown.
    const replaces = !current || !sessions[current] || (sessions[current].info.state === "dead" && info.state !== "dead");
    const bySandbox = activate || (isOpen && replaces) ? { ...s.bySandbox, [info.sandbox]: info.sessionId } : s.bySandbox;
    return { ...s, sessions, bySandbox, open };
  }

  private trySend(msg: ClientMessage) {
    try {
      this.send(msg);
    } catch {
      /* resubscribed on reconnect */
    }
  }

  private reduce(s: State, m: ServerMessage): State {
    switch (m.type) {
      case "hello": {
        let next: State = { ...s, agents: m.agents, editors: m.editors ?? [], createNote: m.createNote };
        const live = new Set(m.sessions.map((x) => x.sessionId));
        // Forget sessions the bridge no longer has (e.g. it restarted).
        const sessions = Object.fromEntries(Object.entries(next.sessions).filter(([id]) => live.has(id)));
        const bySandbox = Object.fromEntries(Object.entries(next.bySandbox).filter(([, id]) => live.has(id)));
        next = { ...next, sessions, bySandbox };
        for (const info of m.sessions) {
          const known = next.sessions[info.sessionId];
          if (known) {
            next.sessions = { ...next.sessions, [info.sessionId]: { ...known, info } };
            queueMicrotask(() => this.trySend({ type: "subscribe", sessionId: info.sessionId, sinceSeq: known.lastSeq }));
          } else next = this.track(next, info, false);
        }
        return next;
      }
      case "sandboxes":
        return { ...s, sandboxes: m.sandboxes, listError: m.error };
      case "gateway":
        return { ...s, gateway: m.gateway };
      case "image_build":
        return { ...s, build: m.build };
      case "session_opened": {
        // Every tab hears about a new thread; only the one that asked switches to it.
        const mine = !!m.reqId && this.pending.has(m.reqId);
        this.settle(m);
        return this.track(s, m.session, mine);
      }
      case "session_info":
        if (!m.session.sessionId) return s;
        return this.track(s, m.session, false);
      case "thread_deleted": {
        this.settle(m);
        const v = s.sessions[m.sessionId];
        if (!v) return s;
        const { [m.sessionId]: _gone, ...sessions } = s.sessions;
        const { [m.sessionId]: _closed, ...open } = s.open;
        const bySandbox = this.afterRemoval({ ...s, sessions }, v.info.sandbox, m.sessionId, open);
        return { ...s, sessions, bySandbox, open: this.remember(open) };
      }
      case "replay_done": {
        const v = s.sessions[m.sessionId];
        return v ? { ...s, sessions: { ...s.sessions, [m.sessionId]: { ...v, replayed: true } } } : s;
      }
      case "result":
      case "error":
      case "past_sessions":
      case "network":
      case "repo_result":
      case "editor_opened":
      case "catalog":
      case "sandbox_types":
        this.settle(m);
        if (m.type === "error" && !m.reqId) {
          const id = m.sessionId;
          const v = id ? s.sessions[id] : undefined;
          if (id && v) return { ...s, sessions: { ...s.sessions, [id]: { ...v, error: { message: m.message, hint: m.hint, at: Date.now() } } } };
          console.warn("bridge:", m.message, m.detail ?? "");
        }
        return s;
      default: {
        // A session event: fold it into that session's conversation, once.
        const v = s.sessions[m.sessionId];
        if (!v || m.seq <= v.lastSeq) return s;
        let info = v.info;
        if (m.type === "event") {
          // These can arrive any time after session/new; keep the header and slash menu current.
          const u = m.update;
          if (u.sessionUpdate === "available_commands_update") info = { ...info, commands: u.availableCommands ?? [] };
          else if (u.sessionUpdate === "config_option_update") info = { ...info, configOptions: u.configOptions ?? info.configOptions };
          else if (u.sessionUpdate === "usage_update") info = { ...info, usage: { ...info.usage, used: u.used, size: u.size } };
        }
        return { ...s, sessions: { ...s.sessions, [m.sessionId]: { ...v, info, conv: apply(v.conv, m), lastSeq: m.seq } } };
      }
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const store = new Store();

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.state));
}
