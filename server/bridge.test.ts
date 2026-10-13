// End-to-end through the real bridge, with test/fixtures/fake-openshell.mjs as the CLI.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { ROOT } from "./config.ts";

const PORT = 7900 + Math.floor(Math.random() * 90);
const TOKEN = "test-token";
const BASE = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof spawn>;
// A stand-in openshell-configs: two of the policies, and a Makefile whose one target "builds" quickly.
const configs = mkdtempSync(join(tmpdir(), "sc-configs-"));
mkdirSync(join(configs, "policies"));
for (const p of ["vscode-terminal.yaml", "browser.yaml"]) writeFileSync(join(configs, "policies", p), "version: 1\n");
writeFileSync(join(configs, "Makefile"), "claude-browser:\n\t@echo step 1\n\t@echo step 2\n");
const createLog = join(configs, "created.jsonl");

before(async () => {
  server = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server/index.ts"), "--port", String(PORT)], {
    env: {
      ...process.env,
      OPENSHELL_BIN: join(ROOT, "test/fixtures/fake-openshell.mjs"),
      CONSOLE_TOKEN: TOKEN,
      CONSOLE_STATE: join(mkdtempSync(join(tmpdir(), "sc-test-")), "state.json"),
      OPENSHELL_CONFIGS: configs,
      ENGINE: join(ROOT, "test/fixtures/fake-engine.mjs"),
      FAKE_IMAGES: "claude-sandbox:latest,claude-browser:latest",
      FAKE_CREATE_LOG: createLog,
      FAKE_FORWARDS: join(configs, "forwards.json"),
      FAKE_RULES: join(configs, "rules.json"),
      FAKE_RULES_LOG: join(configs, "rules.log"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve) => server.stdout!.on("data", (d) => String(d).includes("running") && resolve()));
});
after(() => server.kill());

const AUTH = { Authorization: `Bearer ${TOKEN}` };

function connect(opts: { origin?: string; token?: string | null; port?: number } = {}) {
  const port = opts.port ?? PORT;
  const token = opts.token === undefined ? TOKEN : opts.token;
  const protocols = token === null ? ["sandbox-console"] : ["sandbox-console", `token.${token}`];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers: { Origin: opts.origin ?? `http://127.0.0.1:${port}` } });
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
      setTimeout(() => reject(new Error(`timed out waiting for a message: ${pred}`)), ms);
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
  c.send({ type: "repo", reqId: "d4", sandbox: "opencode-demo", op: "rm-rf" });
  assert.match((await c.next((m) => m.type === "error" && m.reqId === "d4")).message, /Unknown repository action/);
  c.send({ type: "repo", reqId: "d5", sandbox: "opencode-demo", op: "merge", repo: "nope" });
  assert.match((await c.next((m) => m.type === "error" && m.reqId === "d5")).message, /No repository "nope"/);
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

test("a sandbox can have several threads that run independently", async () => {
  const c = connect();
  await c.opened;
  const hello = await c.next((m) => m.type === "hello");
  const firstInfo = hello.sessions.find((s: any) => s.sandbox === "opencode-demo");
  const first = firstInfo.sessionId;
  const firstModel = firstInfo.configOptions[0].currentValue;
  assert.notEqual(firstModel, "openrouter/anthropic/claude-fable-5.1");

  c.send({ type: "new_thread", reqId: "t1", sandbox: "opencode-demo" });
  const second = (await c.next((m) => m.type === "session_opened" && m.reqId === "t1")).session;
  assert.notEqual(second.sessionId, first);
  assert.equal(second.sandbox, "opencode-demo");
  assert.equal(second.title, null);

  // A turn in the new thread shows up only in its own log, and names the thread after the prompt.
  c.send({ type: "subscribe", sessionId: second.sessionId, sinceSeq: 0 });
  c.send({ type: "prompt", sessionId: second.sessionId, text: "second thread question" });
  const perm = await c.next((m) => m.type === "permission_request" && m.sessionId === second.sessionId);
  const titled = await c.next((m) => m.type === "session_info" && m.session.sessionId === second.sessionId && m.session.title);
  assert.equal(titled.session.title, "second thread question");
  c.send({ type: "permission_answer", sessionId: second.sessionId, requestId: perm.requestId, optionId: "once" });
  await c.next((m) => m.type === "turn_end" && m.sessionId === second.sessionId);

  // Settings are per thread.
  c.send({ type: "set_option", reqId: "m2", sessionId: second.sessionId, configId: "model", value: "openrouter/anthropic/claude-fable-5.1" });
  await c.next((m) => m.type === "result" && m.reqId === "m2");
  const d = connect();
  await d.opened;
  const again = await d.next((m) => m.type === "hello");
  const mine = again.sessions.filter((s: any) => s.sandbox === "opencode-demo");
  assert.deepEqual(
    mine.map((s: any) => s.sessionId),
    [first, second.sessionId],
  );
  assert.equal(mine[1].configOptions[0].currentValue, "openrouter/anthropic/claude-fable-5.1");
  assert.equal(mine[0].configOptions[0].currentValue, firstModel);

  // An earlier session is loaded as one more thread; the live ones aren't offered again.
  c.send({ type: "list_past_sessions", reqId: "p1", sessionId: second.sessionId });
  const past = await c.next((m) => m.type === "past_sessions" && m.reqId === "p1");
  assert.deepEqual(
    past.sessions.map((p: any) => p.sessionId),
    ["ses_old1"],
  );
  c.send({ type: "open_session", reqId: "l1", sandbox: "opencode-demo", agent: "opencode", cwd: "/sandbox/myrepo", loadSessionId: "ses_old1" });
  const loaded = (await c.next((m) => m.type === "session_opened" && m.reqId === "l1")).session;
  assert.equal(loaded.sessionId, "ses_old1");
  assert.equal(loaded.title, "Add a health endpoint");
  c.send({ type: "subscribe", sessionId: "ses_old1", sinceSeq: 0 });
  await c.next((m) => m.type === "replay_done" && m.sessionId === "ses_old1");
  assert.ok(c.inbox.some((m) => m.sessionId === "ses_old1" && m.type === "event" && m.update.sessionUpdate === "agent_message_chunk"));

  // The sandbox row shows the most urgent thread, and the thread that was touched last.
  const rows = await c.next(
    (m) => m.type === "sandboxes" && m.sandboxes.find((s: any) => s.name === "opencode-demo")?.session?.sessionId === "ses_old1",
  );
  assert.ok(rows);

  c.send({ type: "new_thread", reqId: "t2", sandbox: "claude-demo" });
  assert.match((await c.next((m) => m.type === "error" && m.reqId === "t2")).message, /isn't running/);
  c.ws.close();
  d.ws.close();
});

/** A second bridge on its own port, sharing a state directory, so the first can "restart". */
async function startBridge(port: number, stateDir: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server/index.ts"), "--port", String(port)], {
    env: {
      ...process.env,
      OPENSHELL_BIN: join(ROOT, "test/fixtures/fake-openshell.mjs"),
      CONSOLE_TOKEN: TOKEN,
      CONSOLE_STATE: join(stateDir, "state.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  extra.push(child);
  await new Promise<void>((resolve) => child.stdout!.on("data", (d) => String(d).includes("running") && resolve()));
  return child;
}

/** Bridges a test started, killed at the end even if it failed half way. */
const extra: ReturnType<typeof spawn>[] = [];
after(() => {
  for (const c of extra) c.kill();
});

function stopBridge(child: ReturnType<typeof spawn>) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

test("threads survive a restart, can be resumed without repeating the replay, and can be deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-persist-"));
  const port = PORT + 100;
  let bridge = await startBridge(port, dir);
  let c = connect({ port });
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  c.send({ type: "open_session", reqId: "o1", sandbox: "opencode-demo", agent: "opencode", cwd: "/sandbox/myrepo" });
  const sid = (await c.next((m) => m.type === "session_opened" && m.reqId === "o1")).session.sessionId;
  c.send({ type: "subscribe", sessionId: sid, sinceSeq: 0 });
  c.send({ type: "prompt", sessionId: sid, text: "remember me" });
  const perm = await c.next((m) => m.type === "permission_request");
  c.send({ type: "permission_answer", sessionId: sid, requestId: perm.requestId, optionId: "once" });
  const end = await c.next((m) => m.type === "turn_end");
  c.ws.close();
  // SIGTERM: the bridge writes what it has before it exits.
  await stopBridge(bridge);

  bridge = await startBridge(port, dir);
  c = connect({ port });
  await c.opened;
  const hello = await c.next((m) => m.type === "hello");
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  const saved = hello.sessions.find((s: any) => s.sessionId === sid);
  assert.equal(saved.state, "dead");
  assert.equal(saved.title, "remember me");
  assert.equal(saved.lastSeq, end.seq);
  c.send({ type: "subscribe", sessionId: sid, sinceSeq: 0 });
  await c.next((m) => m.type === "replay_done" && m.sessionId === sid);
  assert.ok(c.inbox.some((m) => m.sessionId === sid && m.type === "user_message" && m.text === "remember me"));
  // A saved thread can't be prompted until it's resumed.
  c.send({ type: "prompt", sessionId: sid, text: "hi" });
  assert.match((await c.next((m) => m.type === "error" && m.sessionId === sid)).message, /no longer open/);

  // Resuming (session/load) keeps the saved log; the agent's replay is not recorded a second time.
  c.send({ type: "open_session", reqId: "o2", sandbox: "opencode-demo", agent: "opencode", cwd: "/sandbox/myrepo", loadSessionId: sid });
  const resumedMsg = await c.next((m) => (m.type === "session_opened" || m.type === "error") && m.reqId === "o2");
  assert.equal(resumedMsg.type, "session_opened", `${resumedMsg.message} ${resumedMsg.detail}`);
  const resumed = resumedMsg.session;
  assert.equal(resumed.sessionId, sid);
  assert.equal(resumed.state, "idle");
  assert.equal(resumed.lastSeq, end.seq);

  // Delete: gone from every tab, from disk, and from the agent's earlier-sessions list.
  const other = connect({ port });
  await other.opened;
  c.send({ type: "delete_thread", reqId: "x1", sessionId: sid });
  await c.next((m) => m.type === "thread_deleted" && m.reqId === "x1");
  await other.next((m) => m.type === "thread_deleted" && m.sessionId === sid);
  c.send({ type: "new_thread", reqId: "n1", sandbox: "opencode-demo" });
  const fresh = (await c.next((m) => m.type === "session_opened" && m.reqId === "n1")).session;
  c.send({ type: "list_past_sessions", reqId: "p1", sessionId: fresh.sessionId });
  assert.deepEqual(
    (await c.next((m) => m.type === "past_sessions" && m.reqId === "p1")).sessions.map((p: any) => p.sessionId),
    ["ses_old1"],
  );
  c.send({ type: "delete_thread", reqId: "x2", sessionId: "ses_old1" });
  c.send({ type: "delete_thread", reqId: "x3", sessionId: sid });
  assert.match((await c.next((m) => m.type === "error" && m.reqId === "x3")).message, /already gone/);
  // Delete all: every thread of the sandbox, live ones included.
  c.send({ type: "delete_threads", reqId: "x4", sandbox: "opencode-demo" });
  await c.next((m) => m.type === "result" && m.reqId === "x4");
  assert.ok(c.inbox.some((m) => m.type === "thread_deleted" && m.sessionId === fresh.sessionId));
  c.ws.close();
  other.ws.close();
  await stopBridge(bridge);

  bridge = await startBridge(port, dir);
  c = connect({ port });
  await c.opened;
  const after = await c.next((m) => m.type === "hello");
  assert.deepEqual(after.sessions, []);
  c.ws.close();
});

test("sandbox types: image and policy checks, creating one, and building an image", async () => {
  const c = connect();
  await c.opened;
  c.send({ type: "sandbox_types", reqId: "ty" });
  const types = (await c.next((m) => m.type === "sandbox_types" && m.reqId === "ty")).types;
  const byId = Object.fromEntries(types.map((t: any) => [t.id, t]));
  assert.equal(byId["claude-browser"].imageState, "present");
  assert.equal(byId["claude-browser"].policy, "browser.yaml");
  assert.equal(byId["claude-hyperframes"].imageState, "missing");
  assert.equal(byId["claude-hyperframes"].policy, null, "its policy isn't in this openshell-configs");

  // A type's own policy is required, and so is its image.
  c.send({ type: "create_sandbox", reqId: "c1", name: "hf-1", sandboxType: "claude-hyperframes", workdir: "/sandbox" });
  assert.match((await c.next((m) => m.reqId === "c1")).message, /hyperframes.yaml wasn't found/);
  c.send({ type: "create_sandbox", reqId: "c2", name: "oc-1", sandboxType: "opencode", workdir: "/sandbox" });
  const missing = await c.next((m) => m.reqId === "c2");
  assert.match(missing.message, /isn't built yet/);
  assert.match(missing.hint, /make opencode-sandbox/);

  c.send({ type: "create_sandbox", reqId: "c3", name: "web-1", sandboxType: "claude-browser", workdir: "/sandbox" });
  assert.equal((await c.next((m) => m.reqId === "c3")).ok, true);
  const created = readFileSync(createLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const args = created.at(-1) as string[];
  const opt = (k: string) => args[args.indexOf(k) + 1];
  assert.equal(opt("--name"), "web-1");
  assert.equal(opt("--from"), "claude-browser:latest");
  assert.equal(opt("--provider"), "claude");
  assert.equal(opt("--policy"), join(configs, "policies", "browser.yaml"));

  c.send({ type: "build_image", reqId: "b1", sandboxType: "claude-browser" });
  assert.equal((await c.next((m) => m.reqId === "b1")).ok, true);
  const done = await c.next((m) => m.type === "image_build" && m.build.state !== "running");
  assert.equal(done.build.state, "done");
  assert.ok(done.build.lines.includes("step 2"));
  c.ws.close();
});

test("ports: forward, list, refuse a port in use here, stop", async () => {
  const c = connect();
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  const port = 41000 + Math.floor(Math.random() * 2000);
  c.send({ type: "forward", reqId: "f1", sandbox: "opencode-demo", op: "start", port });
  const started = await c.next((m) => m.reqId === "f1");
  assert.equal(started.type, "ports");
  assert.deepEqual(
    started.forwards.map((f: any) => f.port),
    [port],
  );
  assert.match(started.log[0], new RegExp(`127.0.0.1:${port}`));

  c.send({ type: "ports", reqId: "f2", sandbox: "claude-demo" });
  assert.deepEqual((await c.next((m) => m.reqId === "f2")).forwards, [], "only that sandbox's forwards");

  // A port something here already listens on is refused before openshell is asked.
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(port + 1, "127.0.0.1", r));
  c.send({ type: "forward", reqId: "f3", sandbox: "opencode-demo", op: "start", port: port + 1 });
  assert.match((await c.next((m) => m.reqId === "f3")).message, /already in use on this machine/);
  busy.close();

  c.send({ type: "forward", reqId: "f4", sandbox: "opencode-demo", op: "start", port: 80 });
  assert.match((await c.next((m) => m.reqId === "f4")).message, /1024 to 65535/);

  c.send({ type: "forward", reqId: "f5", sandbox: "opencode-demo", op: "stop", port });
  assert.deepEqual((await c.next((m) => m.reqId === "f5")).forwards, []);
  c.ws.close();
});

test("the bridge says when its code on disk changed since it started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-code-"));
  mkdirSync(join(dir, "server"));
  mkdirSync(join(dir, "shared"));
  writeFileSync(join(dir, "server", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "server", "a.test.ts"), "// tests don't count\n");
  const port = PORT + 150;
  const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "server/index.ts"), "--port", String(port)], {
    env: {
      ...process.env,
      OPENSHELL_BIN: join(ROOT, "test/fixtures/fake-openshell.mjs"),
      CONSOLE_TOKEN: TOKEN,
      CONSOLE_STATE: join(mkdtempSync(join(tmpdir(), "sc-test-")), "state.json"),
      CONSOLE_WATCH: dir,
      CONSOLE_BUILD_CHECK_MS: "200",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  extra.push(child);
  await new Promise<void>((resolve) => child.stdout!.on("data", (d) => String(d).includes("running") && resolve()));
  const c = connect({ port });
  await c.opened;
  const hello = await c.next((m) => m.type === "hello");
  assert.match(hello.build.protocol, /^[0-9a-f]{12}$/);
  assert.equal(hello.build.stale, false);

  writeFileSync(join(dir, "server", "a.test.ts"), "// still not counted\n");
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(!c.inbox.some((m) => m.type === "server_build"));

  writeFileSync(join(dir, "server", "a.ts"), "export const a = 2;\n");
  assert.equal((await c.next((m) => m.type === "server_build")).build.stale, true);
  // Put back, it's the code that was loaded again.
  writeFileSync(join(dir, "server", "a.ts"), "export const a = 1;\n");
  await c.next((m) => m.type === "server_build" && m.build.stale === false);
  c.ws.close();
});

test("rules: proposed network rules are listed, and approved or rejected one at a time", async () => {
  writeFileSync(
    join(configs, "rules.json"),
    JSON.stringify([
      { id: "329ecc4c-c76f-418d-bd5b-c5915a12665a", host: "cdn.jsdelivr.net", port: 443, binary: "/usr/local/bin/node", hits: 10 },
      { id: "004a03b7-c765-46b2-a604-d73c5aba1f73", host: "api.github.com", port: 443, binary: "/usr/lib/git-core/git-remote-http" },
    ]),
  );
  const c = connect();
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  c.send({ type: "rules", reqId: "r1", sandbox: "opencode-demo" });
  const first = await c.next((m) => m.reqId === "r1");
  assert.equal(first.rules.length, 2);
  const [node, git] = first.rules;
  assert.deepEqual(node.endpoints, [{ host: "cdn.jsdelivr.net", port: 443, mode: "L4" }]);
  assert.equal(node.hits, 10);
  assert.equal(node.shared, true, "node is something many programs run as");
  assert.equal(git.shared, false);

  c.send({ type: "rules", reqId: "r2", sandbox: "opencode-demo", op: "approve", chunkId: node.id });
  const after = await c.next((m) => m.reqId === "r2");
  assert.deepEqual(
    after.rules.map((r: any) => r.id),
    [git.id],
  );
  assert.match(after.log[0], /Allowed/);

  c.send({ type: "rules", reqId: "r3", sandbox: "opencode-demo", op: "reject", chunkId: git.id });
  assert.deepEqual((await c.next((m) => m.reqId === "r3")).rules, []);
  assert.deepEqual(readFileSync(join(configs, "rules.log"), "utf8").trim().split("\n"), [`approve ${node.id}`, `reject ${git.id}`]);

  // What reaches the CLI is checked first.
  c.send({ type: "rules", reqId: "r4", sandbox: "opencode-demo", op: "approve", chunkId: "--status" });
  assert.match((await c.next((m) => m.reqId === "r4")).message, /Not a rule id/);
  c.send({ type: "rules", reqId: "r5", sandbox: "opencode-demo", op: "delete" as any, chunkId: node.id });
  assert.match((await c.next((m) => m.reqId === "r5")).message, /Unknown rule action/);
  c.ws.close();
});

test("files: browse, download (files and folders), upload, and what's refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-files-"));
  const box = join(dir, "sandbox");
  mkdirSync(join(box, "videos", "reel", "renders"), { recursive: true });
  writeFileSync(join(box, "videos", "reel", "renders", "video.mp4"), Buffer.from("not really a video"));
  writeFileSync(join(box, "videos", "reel", "index.html"), "<h1>hi</h1>");
  writeFileSync(join(box, "videos", "reel", ".hidden"), "x");
  writeFileSync(join(box, "videos", "reel", "ünï code.txt"), "unicode name");
  const port = PORT + 160;
  await startBridge(port, dir, { FAKE_SANDBOX_ROOT: box });
  const base = `http://127.0.0.1:${port}`;
  const c = connect({ port });
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);

  c.send({ type: "files", reqId: "l1", sandbox: "opencode-demo", path: "/sandbox/videos/reel" });
  const listing = await c.next((m) => m.reqId === "l1");
  const by = Object.fromEntries(listing.entries.map((e: any) => [e.name, e]));
  assert.equal(by.renders.kind, "dir");
  assert.equal(by["index.html"].kind, "file");
  assert.equal(by["index.html"].size, 11);
  assert.ok(by[".hidden"], "hidden files are listed; the page hides them");
  assert.equal(by["ünï code.txt"].kind, "file");
  assert.ok(by["index.html"].mtime > 1_700_000_000);

  c.send({ type: "files", reqId: "l2", sandbox: "opencode-demo", path: "/sandbox/../etc" });
  assert.match((await c.next((m) => m.reqId === "l2")).message, /Only files under \/sandbox/);
  c.send({ type: "files", reqId: "l3", sandbox: "opencode-demo", path: "/sandbox/nope" });
  assert.match((await c.next((m) => m.reqId === "l3")).message, /isn't a folder/);

  // Download a file, a file with a non-Latin-1 name, and a folder as a tar.
  const get = (path: string) => fetch(`${base}/api/file?sandbox=opencode-demo&path=${encodeURIComponent(path)}`, { headers: AUTH });
  const video = await get("/sandbox/videos/reel/renders/video.mp4");
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("content-type"), "video/mp4");
  assert.equal(await video.text(), "not really a video");
  const uni = await get("/sandbox/videos/reel/ünï code.txt");
  assert.equal(decodeURIComponent(uni.headers.get("x-file-name") ?? ""), "ünï code.txt");
  assert.equal(await uni.text(), "unicode name");
  const html = await get("/sandbox/videos/reel/index.html");
  assert.match(html.headers.get("content-type") ?? "", /^text\/plain/, "html from the sandbox is never served as html");
  const folder = await get("/sandbox/videos/reel/renders");
  assert.equal(decodeURIComponent(folder.headers.get("x-file-name") ?? ""), "renders.tar");
  const tarFile = join(dir, "renders.tar");
  writeFileSync(tarFile, Buffer.from(await folder.arrayBuffer()));
  assert.match(execFileSync("tar", ["-tf", tarFile], { encoding: "utf8" }), /renders\/video\.mp4/);
  assert.deepEqual(
    (await import("node:fs")).readdirSync(box).filter((f) => f.startsWith(".sandbox-console")),
    [],
    "the tar made in the sandbox is removed",
  );
  assert.equal((await get("/sandbox/videos/reel/missing.mp4")).status, 404);
  assert.equal((await get("/etc/passwd")).status, 400);
  assert.equal((await get("/sandbox/../etc/passwd")).status, 400);
  assert.equal((await fetch(`${base}/api/file?sandbox=opencode-demo&path=/sandbox`)).status, 401);

  // Upload: refused over an existing name unless asked, and only with a good name.
  const put = (name: string, body: string, extra = "") =>
    fetch(`${base}/api/upload?sandbox=opencode-demo&dir=${encodeURIComponent("/sandbox/videos/reel")}&name=${encodeURIComponent(name)}${extra}`, {
      method: "PUT",
      headers: { ...AUTH, "Content-Type": "application/octet-stream" },
      body,
    });
  const up = await put("logo.png", "PNGDATA");
  assert.equal(up.status, 200);
  assert.equal(readFileSync(join(box, "videos", "reel", "logo.png"), "utf8"), "PNGDATA");
  const again = await put("logo.png", "NEWER");
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { message: string }).message, /already exists/);
  assert.equal(readFileSync(join(box, "videos", "reel", "logo.png"), "utf8"), "PNGDATA");
  assert.equal((await put("logo.png", "NEWER", "&overwrite=1")).status, 200);
  assert.equal(readFileSync(join(box, "videos", "reel", "logo.png"), "utf8"), "NEWER");
  assert.equal((await put("../escape.txt", "x")).status, 400);
  assert.equal((await put("-rf", "x")).status, 400);
  assert.equal(
    (
      await fetch(`${base}/api/upload?sandbox=opencode-demo&dir=/sandbox&name=a.txt`, {
        method: "PUT",
        headers: { ...AUTH, Origin: "http://evil.example" },
        body: "x",
      })
    ).status,
    403,
  );
  assert.ok(!existsSync(join(box, "escape.txt")));
  c.ws.close();
});

test("ports: a server that starts while the agent works is announced in its thread, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-announce-"));
  const listen = join(dir, "listen");
  // A preset on a port nothing else here uses (a forward needs it free on this machine).
  const P = 20000 + Math.floor(Math.random() * 5000);
  const hex = P.toString(16).toUpperCase().padStart(4, "0");
  writeFileSync(join(dir, "ports.json"), JSON.stringify([{ port: P, label: "HyperFrames Studio", match: "hyperframes preview" }]));
  writeFileSync(listen, "L 1F90\nC python3 -m http.server 8080\n"); // 8080 is already up: not news
  const port = PORT + 170;
  await startBridge(port, dir, {
    FAKE_LISTEN: listen,
    FAKE_FORWARDS: join(dir, "forwards.json"),
    CONSOLE_PORTS: join(dir, "ports.json"),
    CONSOLE_PORT_LOOK_MS: "200",
  });
  const c = connect({ port });
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  c.send({ type: "open_session", reqId: "o", sandbox: "opencode-demo", agent: "opencode", cwd: "/sandbox/myrepo" });
  const sid = (await c.next((m) => m.type === "session_opened" && m.reqId === "o")).session.sessionId;
  c.send({ type: "subscribe", sessionId: sid, sinceSeq: 0 });
  await c.next((m) => m.type === "replay_done" && m.sessionId === sid);
  await new Promise((r) => setTimeout(r, 600)); // the look at the start
  const announced = () => c.inbox.filter((m) => m.type === "port_open").map((m) => m.port);

  /** A turn of the fake agent, stopped at its permission request (which ends it, and looks at the ports again). */
  let turns = 0;
  const turn = async () => {
    const had = c.inbox.filter((m) => m.type === "turn_end").length;
    c.send({ type: "prompt", sessionId: sid, text: `turn ${++turns}` });
    await c.next(() => c.inbox.filter((m) => m.type === "permission_request").length === turns);
    c.send({ type: "cancel", sessionId: sid });
    await c.next(() => c.inbox.filter((m) => m.type === "turn_end").length > had);
    await new Promise((r) => setTimeout(r, 800));
  };
  const withStudio = `L 1F90\nL ${hex}\nL A1B2\nC python3 -m http.server 8080\nC /usr/local/bin/node /usr/local/bin/hyperframes preview --foreground\n`;

  // The Studio comes up during a turn, and some high port that isn't worth mentioning.
  writeFileSync(listen, withStudio);
  await turn();
  const open = c.inbox.find((m) => m.type === "port_open");
  assert.equal(open.port, P);
  assert.equal(open.label, "HyperFrames Studio");
  assert.match(open.command, /hyperframes preview/);
  assert.deepEqual(announced(), [P], "8080 was there before, and the high port is the agent's own");

  // Still running at the next turn: no repeat.
  await turn();
  assert.deepEqual(announced(), [P]);

  // Stopped, then started again, it's news again, unless it's forwarded by then.
  writeFileSync(listen, "L 1F90\nC python3 -m http.server 8080\n");
  await turn();
  c.send({ type: "forward", reqId: "f", sandbox: "opencode-demo", op: "start", port: P });
  assert.equal((await c.next((m) => m.reqId === "f")).forwards.length, 1);
  c.send({ type: "forward", reqId: "f2", sandbox: "opencode-demo", op: "start", port: P });
  assert.match((await c.next((m) => m.reqId === "f2")).log[0], /already forwarded/);
  writeFileSync(listen, withStudio);
  await turn();
  assert.deepEqual(announced(), [P], "a forwarded port isn't offered again");
  c.ws.close();
});

test("images: sent to the agent as image blocks, kept in the conversation as thumbnails, refused when malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-images-"));
  const port = PORT + 180;
  await startBridge(port, dir);
  const c = connect({ port });
  await c.opened;
  await c.next((m) => m.type === "sandboxes" && m.sandboxes.length);
  c.send({ type: "open_session", reqId: "o", sandbox: "opencode-demo", agent: "opencode", cwd: "/sandbox/myrepo" });
  const opened = await c.next((m) => m.type === "session_opened" && m.reqId === "o");
  assert.equal(opened.session.promptImages, true);
  const sid = opened.session.sessionId;
  c.send({ type: "subscribe", sessionId: sid, sinceSeq: 0 });
  await c.next((m) => m.type === "replay_done" && m.sessionId === sid);

  const png = Buffer.from("PNGFAKE").toString("base64");
  const thumb = Buffer.from("JPEGTHUMB").toString("base64");
  c.send({ type: "prompt", sessionId: sid, text: "what is this", images: [{ mimeType: "image/png", data: png, thumb }] });
  const user = await c.next((m) => m.type === "user_message" && m.sessionId === sid);
  assert.deepEqual(user.images, [{ mimeType: "image/png", thumb }], "the full image isn't kept in the log");
  const heard = await c.next((m) => m.type === "event" && m.update?.content?.text?.startsWith("Got 1 image(s)"));
  assert.match(heard.update.content.text, /image\/png 7 bytes/);
  await c.next((m) => m.type === "permission_request" && m.sessionId === sid);
  c.send({ type: "cancel", sessionId: sid });
  await c.next((m) => m.type === "turn_end" && m.sessionId === sid);

  // Only an image, no text: allowed. Neither: refused.
  c.send({ type: "prompt", sessionId: sid, text: "", images: [{ mimeType: "image/png", data: png, thumb }] });
  assert.equal((await c.next((m) => m.type === "user_message" && m.sessionId === sid && m.seq > user.seq)).text, "");
  await c.next((m) => m.type === "permission_request" && m.sessionId === sid && c.inbox.filter((x) => x.type === "permission_request").length === 2);
  c.send({ type: "cancel", sessionId: sid });
  await c.next(() => c.inbox.filter((m) => m.type === "turn_end").length === 2);
  c.send({ type: "prompt", sessionId: sid, text: "  " });
  assert.match((await c.next((m) => m.type === "error" && m.sessionId === sid)).message, /attach an image/);

  // Not a picture, or not base64: refused before it reaches the agent.
  c.send({ type: "prompt", sessionId: sid, text: "x", images: [{ mimeType: "image/svg+xml", data: png, thumb }] });
  assert.match((await c.next((m) => m.type === "error" && /prompt\.images/.test(m.message))).message, /Bad message/);
  assert.equal(c.inbox.filter((m) => m.type === "user_message").length, 2, "the refused one never became a message");
  c.ws.close();
});
