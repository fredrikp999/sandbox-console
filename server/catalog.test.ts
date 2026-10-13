// The catalog end to end: the fake openshell runs the sandbox side on this machine
// (real sh, tar and awk), with /sandbox mapped to a temporary directory.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./config.ts";

const tmp = mkdtempSync(join(tmpdir(), "sc-catalog-"));
const box = join(tmp, "sandbox");
const home = join(tmp, "home");
const mine = join(tmp, "catalog");
for (const d of [box, join(home, ".claude", "skills", "tool", "scripts"), join(mine, "agents"), join(mine, "context")])
  mkdirSync(d, { recursive: true });
process.env.OPENSHELL_BIN = join(ROOT, "test/fixtures/fake-openshell.mjs");
process.env.FAKE_SANDBOX_ROOT = box;
process.env.CONSOLE_CATALOG = mine;
// Your own ~/.claude stays out of it.
process.env.HOME = home;
const catalog = await import("./catalog.ts");

writeFileSync(join(mine, "agents", "code-reviewer.md"), "---\nname: code-reviewer\ndescription: Mine, not the built-in one\n---\n\nReview.\n");
writeFileSync(join(mine, "context", "house-rules.md"), "---\ndescription: Our rules\n---\n\n# House rules\n\nUse tabs.\n");
writeFileSync(
  join(home, ".claude", "skills", "tool", "SKILL.md"),
  "---\nname: tool\ndescription: >\n  Runs the tool,\n  carefully.\n---\n\nRun scripts/run.sh.\n",
);
writeFileSync(join(home, ".claude", "skills", "tool", "scripts", "run.sh"), "#!/bin/sh\necho ran\n");
chmodSync(join(home, ".claude", "skills", "tool", "scripts", "run.sh"), 0o755);
writeFileSync(join(home, ".claude", "skills", "tool", ".DS_Store"), "junk");

const inBox = (p: string) => p.replace("/sandbox", box);
const read = (p: string) => readFileSync(inBox(p), "utf8");

test("lists all sources; the first one with a name wins", async () => {
  const items = await catalog.list();
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get("agent:code-reviewer")?.source, "Your catalog");
  assert.equal(byId.get("agent:debugger")?.source, "Built in");
  assert.equal(byId.get("skill:commit-for-review")?.source, "Built in");
  assert.equal(byId.get("context:house-rules")?.description, "Our rules");
  const tool = byId.get("skill:tool");
  assert.equal(tool?.source, "~/.claude");
  assert.equal(tool?.description, "Runs the tool, carefully.");
  assert.equal(tool?.files, 2, "dotfiles are skipped");
});

test("adds agents, skills and context for Claude Code, and takes them out again", async () => {
  const log: string[] = [];
  const p = catalog.PLACES.claude;
  const find = (kind: "agent" | "skill" | "context", name: string) => catalog.find(kind, name);

  await catalog.install("claude-demo", await find("agent", "debugger"), "claude", log);
  assert.match(read(`${p.agent}/debugger.md`), /^---\nname: debugger\n/);

  await catalog.install("claude-demo", await find("skill", "tool"), "claude", log);
  assert.match(read(`${p.skill}/tool/SKILL.md`), /Run scripts\/run.sh/);
  assert.ok(statSync(inBox(`${p.skill}/tool/scripts/run.sh`)).mode & 0o100, "keeps the executable bit");

  // Context goes in next to what is already there, and is replaced, not repeated.
  mkdirSync(inBox("/sandbox/.claude"), { recursive: true });
  writeFileSync(inBox(p.context), "# Mine\n\nKeep this.\n");
  await catalog.install("claude-demo", await find("context", "house-rules"), "claude", log);
  await catalog.install("claude-demo", await find("context", "house-rules"), "claude", log);
  await catalog.install("claude-demo", await find("context", "sandbox-basics"), "claude", log);
  const ctx = read(p.context);
  assert.ok(ctx.startsWith("# Mine\n\nKeep this.\n\n<!-- sandbox-console:begin house-rules -->\n# House rules"));
  assert.equal(ctx.split(catalog.marker("begin", "house-rules")).length, 2);
  assert.ok(!ctx.includes("description: Our rules"), "the catalog's frontmatter stays out");

  assert.deepEqual((await catalog.present("claude-demo", "claude")).sort(), [
    "agent:debugger",
    "context:house-rules",
    "context:sandbox-basics",
    "skill:tool",
  ]);

  await catalog.remove("claude-demo", "context", "house-rules", "claude", log);
  await catalog.remove("claude-demo", "context", "sandbox-basics", "claude", log);
  assert.equal(read(p.context), "# Mine\n\nKeep this.\n");
  await catalog.remove("claude-demo", "skill", "tool", "claude", log);
  await catalog.remove("claude-demo", "agent", "debugger", "claude", log);
  assert.deepEqual(await catalog.present("claude-demo", "claude"), []);

  // A context file that only held our blocks goes away with them.
  const o = catalog.PLACES.opencode;
  await catalog.install("opencode-demo", await find("context", "plan-first"), "opencode", log);
  assert.ok(existsSync(inBox(o.context)));
  await catalog.remove("opencode-demo", "context", "plan-first", "opencode", log);
  assert.ok(!existsSync(inBox(o.context)));
  // Nothing is left behind in the sandbox's home: no uploaded tars, no temporary folders.
  assert.deepEqual(
    readdirSync(box).filter((f) => f.startsWith(".sandbox-console")),
    [],
  );
});

test("agents are rewritten for OpenCode, and back", async () => {
  const log: string[] = [];
  await catalog.install("opencode-demo", await catalog.find("agent", "debugger"), "opencode", log);
  const oc = read(`${catalog.PLACES.opencode.agent}/debugger.md`);
  assert.match(oc, /^---\ndescription: ".+"\nmode: subagent\npermission:\n {2}webfetch: deny\n---\n\nYou find why/);

  const back = catalog.convertAgent(
    "---\ndescription: Plans\nmode: subagent\npermission:\n  edit: deny\n---\nThink.\n",
    "planner",
    "opencode",
    "claude",
  );
  assert.equal(back, '---\nname: planner\ndescription: "Plans"\n---\n\nThink.\n');
  assert.equal(catalog.convertAgent("same", "x", "claude", "claude"), "same");
});

test("tar paths longer than 100 bytes use the prefix field", () => {
  const long = `${"d".repeat(80)}/${"f".repeat(60)}.md`;
  const t = catalog.tar([{ rel: long, data: Buffer.from("hi") }]);
  const header = t.subarray(512, 1024);
  assert.equal(header.subarray(0, 63).toString(), `${"f".repeat(60)}.md`);
  assert.equal(header.subarray(345, 425).toString(), "d".repeat(80));
});
