#!/usr/bin/env node
// A stand-in for the `openshell` CLI with a scripted ACP agent, for trying the
// console without a gateway and for the bridge test:
//
//   OPENSHELL_BIN=test/fixtures/fake-openshell.mjs npm run serve
//
// Prompts containing "fail" return a JSON-RPC error; "exit" makes the agent exit;
// anything else plays a turn with a plan, an edit with a diff, a permission
// request for a command, and a refused fs/read_text_file request.
//
// With FAKE_SANDBOX_ROOT set, `sandbox exec … sh -c`, `upload` and `download` are
// real: they run on this machine with /sandbox mapped to that directory (repos.test.ts).
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const SANDBOXES = [
  { id: "1", name: "opencode-demo", phase: "Ready", created_at: "2026-10-11 05:20:23", conditions: [{ type: "Ready", status: "True" }] },
  { id: "2", name: "claude-demo", phase: "Ready", created_at: "2026-10-11 05:35:31", conditions: [{ type: "Ready", status: "True" }] },
  {
    id: "3",
    name: "broken",
    phase: "Error",
    created_at: "2026-10-10 06:43:24",
    conditions: [{ type: "Ready", status: "False", message: "Canonical main process exited with status 137" }],
  },
];

const [a, b] = args;
const ROOT = process.env.FAKE_SANDBOX_ROOT;
const inBox = (p) => p.replaceAll("/sandbox", ROOT);
if (ROOT && a === "sandbox" && b === "exec" && args.includes("sh")) {
  const { spawnSync } = await import("node:child_process");
  const [script, ...rest] = args.slice(args.indexOf("--") + 3);
  const r = spawnSync("sh", ["-c", inBox(script), ...rest.map(inBox)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
} else if (ROOT && a === "sandbox" && (b === "upload" || b === "download")) {
  const { copyFileSync } = await import("node:fs");
  const { basename, join } = await import("node:path");
  const [from, to] = args.slice(3);
  const src = b === "download" ? inBox(from) : from;
  const dir = b === "upload" ? inBox(to) : to;
  copyFileSync(src, join(dir, basename(src)));
} else if (a === "status") out({ gateway: "openshell", status: "connected", version: "fake" });
else if (a === "sandbox" && b === "list") out({ sandboxes: SANDBOXES });
else if (a === "sandbox" && b === "get") {
  const s = SANDBOXES.find((x) => x.name === args[2]);
  out({ ...s, policy: { network_policies: s?.name.startsWith("opencode") ? { _provider_openrouter: {} } : {} } });
} else if (a === "logs") {
  const t = (Date.now() / 1000).toFixed(3);
  console.log(`[${t}] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/local/bin/opencode(0) -> openrouter.ai:443 [policy:x]`);
  console.log(`[${t}] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(3) -> pypi.org:443 [reason:x]`);
} else if (a === "sandbox" && b === "exec") {
  const cmd = args.slice(args.indexOf("--") + 1);
  // Simulates a Claude image built before the ACP adapter was added.
  if (cmd[0] === "claude-acp-start") {
    console.error("sh: 1: claude-acp-start: not found");
    process.exit(127);
  }
  if (cmd[0] === "sh") {
    // bundle.ts: `sh -c <script> sh <repo> <out>`. /sandbox/repo is a repo with two
    // commits on a branch whose name isn't Latin-1; anything else isn't a repo.
    const [script, , repo] = cmd.slice(2);
    if (script.includes("git bundle create") && repo === "/sandbox/repo") {
      console.log("agent/ünï 2 host/main");
      process.exit(0);
    }
    if (script.includes("git bundle create")) {
      console.error(`${repo} is not a git repository.`);
      process.exit(2);
    }
    process.exit(0); // rm -f of the remote bundle
  }
  agent();
} else if (a === "sandbox" && b === "download") {
  const [remote, localDir] = args.slice(3);
  if (!remote.startsWith("/sandbox/")) {
    console.error(`Error: sandbox source path '${remote}' is outside the sandbox workspace (/sandbox)`);
    process.exit(1);
  }
  const { writeFileSync } = await import("node:fs");
  const { basename, join } = await import("node:path");
  writeFileSync(join(localDir, basename(remote)), "# v2 git bundle (fake)\n");
} else {
  console.error(`fake openshell: unsupported ${args.join(" ")}`);
  process.exit(1);
}

function agent() {
  const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const pending = new Map();
  let nextId = 100;
  let cancelled = false;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DEFAULT_MODEL = "openrouter/nvidia/nemotron-3.5-lightning:free";
  const models_by_session = new Map();
  const models = ["openrouter/nvidia/nemotron-3.5-lightning:free", "openrouter/anthropic/claude-fable-5.1", "openrouter/openrouter/auto"];
  const config = (sessionId) => [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models_by_session.get(sessionId) ?? DEFAULT_MODEL,
      options: models.map((value) => ({ value, name: value })),
    },
  ];

  async function turn(id, sessionId, text) {
    cancelled = false;
    if (/fail/.test(text)) return send({ id, error: { code: -32603, message: "Cannot connect to API: models.opencode.ai" } });
    if (/exit/.test(text)) {
      console.error("fake agent: exiting on request");
      process.exit(3);
    }
    const chunk = async (t) => {
      for (const w of t.split(/(?<= )/)) {
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: w } });
        await sleep(25);
      }
    };
    update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "The user wants a health endpoint. I'll read server.py first." },
    });
    const plan = (s) =>
      update(sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Read server.py", status: s > 0 ? "completed" : "in_progress", priority: "high" },
          { content: "Add the /health route", status: s > 1 ? "completed" : s === 1 ? "in_progress" : "pending", priority: "high" },
          { content: "Run the tests", status: s > 2 ? "completed" : s === 2 ? "in_progress" : "pending", priority: "medium" },
        ],
      });
    plan(0);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "r1",
      title: "server.py",
      kind: "read",
      status: "in_progress",
      locations: [{ path: "/sandbox/myrepo/server.py" }],
    });
    await sleep(300);
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "r1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "142 lines" } }],
    });
    // Must be refused: the console advertises no fs capability.
    const fs = await request("fs/read_text_file", { sessionId, path: "/etc/passwd" });
    plan(1);
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "e1",
      title: "server.py",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: "/sandbox/myrepo/server.py" }],
    });
    await sleep(300);
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "e1",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/sandbox/myrepo/server.py",
          oldText: "import time\n\napp = App()\n",
          newText:
            'import time\n\napp = App()\n\n@app.get("/health")\ndef health():\n    return {"commit": GIT_SHA, "uptime_s": int(time.monotonic() - STARTED)}\n',
        },
      ],
    });
    plan(2);
    await chunk(
      `The route is in place (and my fs request was ${fs.error ? `refused with ${fs.error.code}` : "ANSWERED, which is wrong"}). I'd like to run the tests.\n\n`,
    );
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "x1",
      title: "pytest -q tests/test_health.py",
      kind: "execute",
      status: "pending",
      rawInput: { command: "pytest -q tests/test_health.py" },
    });
    const perm = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "x1" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow pytest", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    if (cancelled || perm.result?.outcome?.outcome === "cancelled") return send({ id, result: { stopReason: "cancelled" } });
    if (perm.result.outcome.optionId === "reject") {
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "x1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "Rejected by the user" } }],
      });
      await chunk("OK, I won't run the tests.");
      return send({ id, result: { stopReason: "end_turn" } });
    }
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "x1", status: "in_progress" });
    await sleep(1200);
    if (cancelled) return send({ id, result: { stopReason: "cancelled" } });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "x1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "..                                     [100%]\n2 passed in 0.31s" } }],
    });
    plan(3);
    await chunk(
      "Both tests pass. The endpoint returns the commit from `GIT_SHA` and the uptime in seconds:\n\n```python\n@app.get(\"/health\")\ndef health(): ...\n```\n<script>alert('raw html must not run')</script>",
    );
    update(sessionId, { sessionUpdate: "usage_update", used: 14200, size: 200000 });
    send({ id, result: { stopReason: cancelled ? "cancelled" : "end_turn", usage: { inputTokens: 12000, outputTokens: 2200, totalTokens: 14200 } } });
  }

  createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
      return;
    }
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        return send({
          id: m.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "FakeCode", version: "0.0.1" },
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
          },
        });
      case "session/new": {
        const sessionId = `ses_${Math.random().toString(36).slice(2, 10)}`;
        send({ id: m.id, result: { sessionId, configOptions: config(sessionId) } });
        setTimeout(
          () =>
            update(sessionId, {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "init", description: "guided AGENTS.md setup" },
                { name: "review", description: "review changes [commit|branch|pr]" },
              ],
            }),
          50,
        );
        return;
      }
      case "session/load":
        update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "An earlier question" } });
        update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "An earlier **answer**." } });
        return send({ id: m.id, result: { configOptions: config(p.sessionId) } });
      case "session/list":
        return send({
          id: m.id,
          result: {
            sessions: [{ sessionId: "ses_old1", cwd: p.cwd, title: "Add a health endpoint", updatedAt: new Date(Date.now() - 3600e3).toISOString() }],
          },
        });
      case "session/set_config_option":
        models_by_session.set(p.sessionId, p.value);
        return send({ id: m.id, result: { configOptions: config(p.sessionId) } });
      case "session/prompt":
        return void turn(m.id, p.sessionId, p.prompt.map((c) => c.text).join(""));
      case "session/cancel":
        cancelled = true;
        return;
      default:
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } });
    }
  });
}
