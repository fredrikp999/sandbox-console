import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCommand, presetsFor, programFor, validPort } from "./ports.ts";

const presets = [
  { port: 3002, label: "HyperFrames Studio", types: ["claude-hyperframes"], match: "hyperframes preview" },
  { port: 5173, label: "Vite dev server", match: "vite" },
];

test("a program is matched to a port by its command line, or by a preset's default", () => {
  const cmds = [
    "/usr/local/bin/node /usr/local/bin/hyperframes preview --foreground --no-open",
    "node /sandbox/app/node_modules/.bin/vite --port 4000",
    "python3 -m http.server 8000",
    "/usr/local/bin/claude --some-flag",
  ];
  assert.equal(programFor(3002, cmds, presets), "hyperframes preview --foreground --no-open");
  assert.equal(programFor(4000, cmds, presets), "vite --port 4000");
  // A preset program started on another port isn't taken for the default one.
  assert.equal(programFor(5173, cmds, presets), undefined);
  assert.equal(programFor(40000, cmds, presets), undefined);
  assert.equal(programFor(3102, ["hyperframes preview --port=3102"], presets), "hyperframes preview --port=3102");
  assert.equal(programFor(31020, ["hyperframes preview --port=3102"], presets), undefined);
});

test("presets: for the sandbox's type, everywhere, or when their program runs", () => {
  const ids = (type?: string, cmd?: string) => presetsFor(presets, type, cmd ? [{ port: 3002, command: cmd }] : []).map((p) => p.port);
  assert.deepEqual(ids(), [5173]);
  assert.deepEqual(ids("claude-hyperframes"), [3002, 5173]);
  assert.deepEqual(ids("claude", "hyperframes preview --no-open"), [3002, 5173]);
});

test("command lines are shortened and ports checked", () => {
  assert.equal(describeCommand("/usr/bin/python3 -m http.server 8000"), "http.server 8000");
  assert.equal(describeCommand("npx vite"), "vite");
  assert.ok(validPort(3002));
  assert.ok(!validPort(80));
  assert.ok(!validPort(70000));
  assert.ok(!validPort("3002"));
});
