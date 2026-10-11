// End-to-end through the real bridge, with test/fake-openshell.mjs as the CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { ROOT } from "./config.ts";

const PORT = 7900 + Math.floor(Math.random() * 90);
const TOKEN = "test-token";
const BASE = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof spawn>;

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server/index.ts"), "--port", String(PORT)], {
    env: {
      ...process.env,
      OPENSHELL_BIN: join(ROOT, "test/fake-openshell.mjs"),
      CONSOLE_TOKEN: TOKEN,
      CONSOLE_STATE: join(mkdtempSync(join(tmpdir(), "sc-test-")), "state.json"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => server.stdout!.on("data", (d) => String(d).includes("running") && resolve()));
});
after(() => server.kill());

function connect(headers: Record<string, string> = { Cookie: `sc_token=${TOKEN}`, Origin: BASE }) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  });
  const next = (pred: (m: any) => boolean, ms = 10_000) =>
    new Promise<any>((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
    });
  const send = (m: object) => ws.send(JSON.stringify(m));
  return { ws, inbox, next, send, opened: new Promise((r, j) => (ws.on("open", r), ws.on("unexpected-response", (_q, res) => j(res.statusCode)))) };
}

test("HTTP needs the token; the token URL sets an HttpOnly cookie", async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 401);
  assert.equal((await fetch(`${BASE}/?token=nope`, { redirect: "manual" })).status, 403);
  const r = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
});

test("WebSocket needs the cookie and a local Origin", async () => {
  await assert.rejects(connect({ Origin: BASE }).opened, (code) => code === 403);
  await assert.rejects(connect({ Cookie: `sc_token=${TOKEN}`, Origin: "https://evil.example" }).opened, (code) => code === 403);
});

test("a full turn: plan, diff, permission, fs refusal, end_turn", async () => {
  const c = connect();
  await c.opened;
  const list = await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  assert.equal(list.sandboxes.find((s: any) => s.name === "opencode-demo").agent, "opencode");

  c.send({ type: "open_session", reqId: "o1", sandbox: "opencode-demo", agent: "opencode", cwd: "/sandbox/myrepo" });
  const opened = await c.next((m) => m.type === "session_opened" && m.reqId === "o1");
  const sid = opened.session.sessionId;
  assert.equal(opened.session.configOptions[0].id, "model");
  c.send({ type: "subscribe", sessionId: sid, sinceSeq: 0 });
  c.send({ type: "prompt", sessionId: sid, text: "add /health" });

  const perm = await c.next((m) => m.type === "permission_request");
  const waiting = await c.next((m) => m.type === "sandboxes" && m.sandboxes.some((s: any) => s.session?.state === "waiting"));
  assert.ok(waiting);
  c.send({ type: "permission_answer", sessionId: sid, requestId: perm.requestId, optionId: "once" });
  const end = await c.next((m) => m.type === "turn_end");
  assert.equal(end.stopReason, "end_turn");
  const text = c.inbox.filter((m) => m.type === "event" && m.update.sessionUpdate === "agent_message_chunk").map((m) => m.update.content.text).join("");
  assert.match(text, /refused with -32601/);
  assert.ok(c.inbox.some((m) => m.type === "event" && m.update.content?.[0]?.type === "diff"));

  // A second tab replays the session from the start.
  const d = connect();
  await d.opened;
  const hello = await d.next((m) => m.type === "hello");
  assert.equal(hello.sessions[0].sessionId, sid);
  d.send({ type: "subscribe", sessionId: sid, sinceSeq: 0 });
  const done = await d.next((m) => m.type === "replay_done");
  assert.equal(d.inbox.filter((m) => m.seq).length, done.lastSeq);

  // Prompt errors come back with a hint; the session stays usable.
  c.send({ type: "prompt", sessionId: sid, text: "please fail" });
  const err = await c.next((m) => m.type === "session_error");
  assert.match(err.hint, /blocked by the sandbox policy/);

  // Model switch.
  c.send({ type: "set_option", reqId: "m1", sessionId: sid, configId: "model", value: "openrouter/openrouter/auto" });
  await c.next((m) => m.type === "result" && m.reqId === "m1");
  const info = await c.next((m) => m.type === "session_info" && m.session.configOptions[0].currentValue === "openrouter/openrouter/auto");
  assert.ok(info);
  c.ws.close();
  d.ws.close();
});

test("cancel answers the open permission request and ends the turn as cancelled", async () => {
  const c = connect();
  await c.opened;
  const hello = await c.next((m) => m.type === "hello");
  const sid = hello.sessions[0].sessionId;
  c.send({ type: "subscribe", sessionId: sid, sinceSeq: 1e9 });
  await c.next((m) => m.type === "replay_done");
  c.send({ type: "prompt", sessionId: sid, text: "again" });
  await c.next((m) => m.type === "permission_request");
  c.send({ type: "cancel", sessionId: sid });
  const resolved = await c.next((m) => m.type === "permission_resolved");
  assert.equal(resolved.label, "Cancelled");
  assert.equal((await c.next((m) => m.type === "turn_end")).stopReason, "cancelled");
  c.ws.close();
});

test("a missing agent command reports exit 127 with the adapter hint", async () => {
  const c = connect();
  await c.opened;
  c.send({ type: "open_session", reqId: "o2", sandbox: "claude-demo", agent: "claude", cwd: "/sandbox" });
  const err = await c.next((m) => m.type === "error" && m.reqId === "o2");
  assert.match(err.message, /exited \(code 127\)/);
  assert.match(err.hint, /claude-code-acp/);
  c.ws.close();
});
