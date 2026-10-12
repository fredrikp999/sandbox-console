// End-to-end through the real bridge, with test/fixtures/fake-openshell.mjs as the CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
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
      OPENSHELL_BIN: join(ROOT, "test/fixtures/fake-openshell.mjs"),
      CONSOLE_TOKEN: TOKEN,
      CONSOLE_STATE: join(mkdtempSync(join(tmpdir(), "sc-test-")), "state.json"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => server.stdout!.on("data", (d) => String(d).includes("running") && resolve()));
});
after(() => server.kill());

const AUTH = { Authorization: `Bearer ${TOKEN}` };

function connect(opts: { origin?: string; token?: string | null } = {}) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const protocols = token === null ? ["sandbox-console"] : ["sandbox-console", `token.${token}`];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, protocols, { headers: { Origin: opts.origin ?? BASE } });
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    inbox.push(m);
    for (const w of [...waiters]) {
      if (!w.pred(m)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const next = (pred: (m: any) => boolean, ms = 10_000) =>
    new Promise<any>((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
    });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const opened = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("unexpected-response", (_req, res) => reject(res.statusCode));
  });
  return { ws, inbox, next, send, opened };
}

/** A raw request, so the Host header can be anything. */
function raw(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the API needs the bearer token; no cookie is ever set", async () => {
  assert.equal((await fetch(`${BASE}/api/ping`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/ping`, { headers: { Authorization: "Bearer nope-nope" } })).status, 401);
  const ok = await fetch(`${BASE}/api/ping`, { headers: AUTH });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${BASE}/api/bundle?sessionId=x`)).status, 401);
});

test("WebSocket needs the token and a local Origin", async () => {
  await assert.rejects(connect({ token: null }).opened, (code) => code === 403);
  await assert.rejects(connect({ token: "wrong-token" }).opened, (code) => code === 403);
  await assert.rejects(connect({ origin: "https://evil.example" }).opened, (code) => code === 403);
  // Another local server on a different port is a different origin.
  await assert.rejects(connect({ origin: "http://127.0.0.1:9999" }).opened, (code) => code === 403);
});

test("requests for another Host are refused (DNS rebinding)", async () => {
  assert.equal((await raw("/api/ping", { ...AUTH, Host: "evil.example" })).status, 421);
  assert.equal((await raw("/", { Host: `attacker.test:${PORT}` })).status, 421);
});

test("a malformed URL gets 400 and the bridge keeps running", async () => {
  assert.equal((await raw("/%E0%A4%A")).status, 400);
  assert.equal((await fetch(`${BASE}/api/ping`, { headers: AUTH })).status, 200);
});

test("HEAD sends no body", { skip: !existsSync(join(ROOT, "dist/web/index.html")) && "UI not built" }, async () => {
  const r = await raw("/", {}, "HEAD");
  assert.equal(r.status, 200);
  assert.equal(r.body, "");
});

test("sandbox names that aren't in the list never reach the CLI", async () => {
  const c = connect();
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  c.send({ type: "delete_sandbox", reqId: "d1", name: "--all" });
  const err = await c.next((m) => m.type === "error" && m.reqId === "d1");
  assert.match(err.message, /no sandbox named "--all"/);
  c.send({ type: "open_session", reqId: "d2", sandbox: "-g", agent: "opencode", cwd: "/sandbox" });
  assert.match((await c.next((m) => m.type === "error" && m.reqId === "d2")).message, /no sandbox named/);
  // Badly shaped messages are refused before anything runs.
  c.send({ type: "open_session", reqId: "d3", sandbox: ["opencode-demo"], agent: "opencode", cwd: "/sandbox" });
  assert.match((await c.next((m) => m.type === "error" && m.reqId === "d3")).message, /Bad message/);
  c.send({ type: "no_such_thing" });
  assert.match((await c.next((m) => m.type === "error" && /unknown type/.test(m.message))).message, /no_such_thing/);
  c.ws.close();
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
  const text = c.inbox
    .filter((m) => m.type === "event" && m.update.sessionUpdate === "agent_message_chunk")
    .map((m) => m.update.content.text)
    .join("");
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
  assert.match(err.hint, /make claude-sandbox/);
  c.ws.close();
});

test("git bundle download: success, branch names that aren't Latin-1, and errors", async () => {
  const c = connect();
  await c.opened;
  const hello = await c.next((m) => m.type === "hello");
  const sid = hello.sessions.find((s: any) => s.sandbox === "opencode-demo").sessionId;
  c.ws.close();

  const r = await fetch(`${BASE}/api/bundle?sessionId=${sid}&dir=/sandbox/repo`, { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(decodeURIComponent(r.headers.get("x-bundle-branch")!), "agent/ünï");
  assert.equal(r.headers.get("x-bundle-commits"), "2");
  assert.match(r.headers.get("content-disposition")!, /^attachment; filename="opencode-demo-[A-Za-z0-9._-]+\.bundle"$/);
  assert.equal(await r.text(), "# v2 git bundle (fake)\n");

  const notRepo = await fetch(`${BASE}/api/bundle?sessionId=${sid}&dir=/sandbox/nothing`, { headers: AUTH });
  assert.equal(notRepo.status, 500);
  assert.match(((await notRepo.json()) as { detail: string }).detail, /not a git repository/);

  const relative = await fetch(`${BASE}/api/bundle?sessionId=${sid}&dir=--upload-pack=x`, { headers: AUTH });
  assert.equal(relative.status, 400);
});
