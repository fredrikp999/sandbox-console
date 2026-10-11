// Client state: one WebSocket to the bridge, the sandbox list, and a folded
// conversation per open session. Reconnects and replays what it missed.
import { useSyncExternalStore } from "react";
import type {
  AgentInfo,
  ClientMessage,
  GatewayStatus,
  SandboxRow,
  ServerMessage,
  SessionInfo,
} from "../../shared/protocol.ts";
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
  createNote?: string;
  sandboxes: SandboxRow[];
  listError?: string;
  gateway: GatewayStatus | null;
  sessions: Record<string, SessionView>;
  /** Current session per sandbox. */
  bySandbox: Record<string, string>;
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

const initialSelected = () => decodeURIComponent(location.hash.match(/^#sb=(.+)$/)?.[1] ?? "") || null;

class Store {
  state: State = {
    link: "connecting",
    agents: [],
    sandboxes: [],
    gateway: null,
    sessions: {},
    bySandbox: {},
    selected: initialSelected(),
  };
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private nextReq = 0;
  private retry = 500;
  private queue: ServerMessage[] = [];
  private flushScheduled = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<State> | ((s: State) => Partial<State>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
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
        // The upgrade is refused without the cookie, e.g. after the bridge restarted with a new token.
        const r = await fetch("/", { method: "HEAD" }).catch(() => null);
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
      this.listeners.forEach((l) => l());
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
    history.replaceState(null, "", name ? `#sb=${encodeURIComponent(name)}` : location.pathname);
    this.set({ selected: name });
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

  private track(s: State, info: SessionInfo, reset: boolean): State {
    const prev = s.sessions[info.sessionId];
    const sessions = { ...s.sessions };
    let bySandbox = s.bySandbox;
    if (!prev || reset) {
      // A new session for this sandbox replaces the old one.
      const old = s.bySandbox[info.sandbox];
      if (old && old !== info.sessionId) delete sessions[old];
      sessions[info.sessionId] = { info, conv: emptyConversation(), lastSeq: 0, replayed: false };
      bySandbox = { ...bySandbox, [info.sandbox]: info.sessionId };
      queueMicrotask(() => this.trySend({ type: "subscribe", sessionId: info.sessionId, sinceSeq: 0 }));
    } else {
      sessions[info.sessionId] = { ...prev, info };
    }
    return { ...s, sessions, bySandbox };
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
        let next: State = { ...s, agents: m.agents, createNote: m.createNote };
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
          } else next = this.track(next, info, true);
        }
        return next;
      }
      case "sandboxes":
        return { ...s, sandboxes: m.sandboxes, listError: m.error };
      case "gateway":
        return { ...s, gateway: m.gateway };
      case "session_opened": {
        this.settle(m);
        const known = s.sessions[m.session.sessionId];
        return this.track(s, m.session, !known);
      }
      case "session_info":
        if (!m.session.sessionId) return s;
        return this.track(s, m.session, false);
      case "replay_done": {
        const v = s.sessions[m.sessionId];
        return v ? { ...s, sessions: { ...s.sessions, [m.sessionId]: { ...v, replayed: true } } } : s;
      }
      case "result":
      case "error":
      case "past_sessions":
      case "network":
        this.settle(m);
        if (m.type === "error" && !m.reqId) {
          const v = m.sessionId ? s.sessions[m.sessionId] : undefined;
          if (v) return { ...s, sessions: { ...s.sessions, [m.sessionId!]: { ...v, error: { message: m.message, hint: m.hint, at: Date.now() } } } };
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
          const u: any = m.update;
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
