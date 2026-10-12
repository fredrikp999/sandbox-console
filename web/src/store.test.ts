// The browser store's token handling, reconnect and replay, with fake browser globals.
import assert from "node:assert/strict";
import { test } from "node:test";

class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const storage = new Map<string, string>();
let pingStatus = 200;
const loc = { protocol: "http:", host: "127.0.0.1:7801", pathname: "/", search: "", hash: "#token=abc123xyz&sb=c1" };
Object.assign(globalThis, {
  WebSocket: FakeWS,
  location: loc,
  history: {
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, "http://x");
      loc.search = u.search;
      loc.hash = u.hash;
    },
  },
  localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  fetch: async () => ({ status: pingStatus }),
});

const { store } = await import("./store.ts");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const info = {
  sessionId: "s1",
  sandbox: "c1",
  agent: "opencode",
  agentCmd: [],
  agentInfo: null,
  canLoad: false,
  canList: false,
  cwd: "/sandbox",
  configOptions: [],
  commands: [],
  state: "idle",
  startedAt: 0,
  lastSeq: 0,
};
const chunk = (seq: number, text: string) => ({
  type: "event",
  sessionId: "s1",
  seq,
  ts: seq,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const agentText = () => (store.state.sessions.s1?.conv.items[0] as any)?.text;

test("takes the token out of the URL, keeps it per origin, and sends it as a subprotocol", () => {
  assert.equal(storage.get("sandbox-console-token"), "abc123xyz");
  assert.equal(loc.hash, "#sb=c1");
  assert.equal(store.state.selected, "c1");
  store.connect();
  assert.deepEqual(FakeWS.all[0].protocols, ["sandbox-console", "token.abc123xyz"]);
});

test("after a reconnect it resumes from its last seq and ignores replayed duplicates", async () => {
  const a = FakeWS.all[0];
  a.open();
  a.recv({ type: "hello", agents: [], sessions: [info], canCreate: true });
  await tick();
  assert.deepEqual(a.sent.at(-1), { type: "subscribe", sessionId: "s1", sinceSeq: 0 });
  for (const [i, t] of ["Hel", "lo"].entries()) a.recv(chunk(i + 1, t));
  await tick();
  assert.equal(agentText(), "Hello");

  a.close();
  await tick(600); // first retry is after 500 ms
  const b = FakeWS.all[1];
  assert.ok(b, "reconnected");
  b.open();
  b.recv({ type: "hello", agents: [], sessions: [info], canCreate: true });
  await tick();
  assert.deepEqual(b.sent.at(-1), { type: "subscribe", sessionId: "s1", sinceSeq: 2 });
  // The bridge may resend what we already have; it must not be applied twice.
  b.recv(chunk(2, "lo"));
  b.recv(chunk(3, "!"));
  await tick();
  assert.equal(agentText(), "Hello!");
});

test("threads: the tab that asks for one switches to it, others just list it", async () => {
  const b = FakeWS.all[1];
  const pending = store.request({ type: "new_thread", sandbox: "c1" });
  const reqId = b.sent.at(-1).reqId;
  b.recv({ type: "session_opened", reqId, session: { ...info, sessionId: "s2", startedAt: 2 } });
  await pending;
  await tick();
  assert.equal(store.state.bySandbox.c1, "s2");
  assert.deepEqual(b.sent.at(-1), { type: "subscribe", sessionId: "s2", sinceSeq: 0 });

  // Opened from another tab: listed, but this tab stays where it is.
  b.recv({ type: "session_opened", session: { ...info, sessionId: "s3", startedAt: 3 } });
  await tick();
  assert.ok(store.state.sessions.s3);
  assert.equal(store.state.bySandbox.c1, "s2");

  store.activate("c1", "s1");
  assert.equal(store.state.bySandbox.c1, "s1");

  // The agent exits, then a new process starts: the dead process's threads are dropped.
  for (const id of ["s1", "s2", "s3"]) b.recv({ type: "session_info", session: { ...info, sessionId: id, state: "dead" } });
  b.recv({ type: "session_opened", session: { ...info, sessionId: "s4", startedAt: 4 } });
  await tick();
  assert.deepEqual(Object.keys(store.state.sessions), ["s4"]);
  assert.equal(store.state.bySandbox.c1, "s4");
});

test("a refused connection with a wrong token shows the access-link page", async () => {
  pingStatus = 401;
  const b = FakeWS.all[1];
  b.close();
  await tick(1100); // second retry is after 1 s
  const c = FakeWS.all[2];
  c.close(); // refused before opening
  await tick();
  assert.equal(store.state.link, "unauthorized");
});
