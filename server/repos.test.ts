// The repository flow end to end with real git: the fake openshell runs the
// sandbox side on this machine, with /sandbox mapped to a temporary directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RepoLink } from "../shared/protocol.ts";
import { ROOT } from "./config.ts";

const tmp = mkdtempSync(join(tmpdir(), "sc-repos-"));
const box = join(tmp, "sandbox");
mkdirSync(box);
process.env.OPENSHELL_BIN = join(ROOT, "test/fixtures/fake-openshell.mjs");
process.env.FAKE_SANDBOX_ROOT = box;
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
Object.assign(process.env, env);
// Imported after the env is set: openshell.ts reads OPENSHELL_BIN when it loads.
const repos = await import("./repos.ts");

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(cwd: string, file: string, text: string, msg: string) {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", msg);
}

// The "remote": a bare repo with one commit on main, and a scratch clone to push from.
const origin = join(tmp, "origin.git");
sh(tmp, "init", "-q", "--bare", "-b", "main", origin);
const upstream = join(tmp, "upstream");
sh(tmp, "clone", "-q", origin, upstream);
sh(upstream, "checkout", "-q", "-b", "main");
commit(upstream, "README.md", "hello\n", "initial");
sh(upstream, "push", "-q", "origin", "main");

test("clone, send in, get out, review, merge, push", async () => {
  const log: string[] = [];
  const url = `file://${origin}`;
  const link: RepoLink = await repos.link({ sandbox: "demo", source: url, dest: join(tmp, "host", "app") }, [], log);
  assert.equal(link.base, "main");
  assert.equal(link.branch, "agent/demo");
  assert.equal(link.sandboxPath, "/sandbox/app");
  await repos.sendIn("demo", link, log);
  const inside = join(box, "app");
  assert.equal(sh(inside, "branch", "--show-current"), "agent/demo");
  assert.match(log.join("\n"), /Created \/sandbox\/app/);

  // Nothing yet.
  await repos.getOut("demo", link, log);
  assert.match(log.at(-1) ?? "", /No new commits/);
  assert.equal((await repos.review(link)).hasBranch, false);

  // The agent commits; it comes out as agent/demo on the host and shows in the review.
  commit(inside, "app.js", "console.log(1)\n", "add app");
  await repos.getOut("demo", link, log);
  assert.match(log.at(-1) ?? "", /Fetched 1 commit into/);
  let v = await repos.review(link);
  assert.deepEqual(
    v.commits.map((c) => c.subject),
    ["add app"],
  );
  assert.equal(v.files[0].path, "app.js");
  assert.equal(v.files[0].added, 1);
  assert.equal(v.behind, 0);

  // Someone pushes to origin meanwhile; "send latest" pulls it into the host's main and the sandbox's host/main.
  commit(upstream, "NEWS.md", "news\n", "upstream change");
  sh(upstream, "push", "-q", "origin", "main");
  log.length = 0;
  await repos.sendIn("demo", link, log);
  assert.match(log.join("\n"), /Pulled 1 new commit on main/);
  assert.match(log.join("\n"), /1 commit behind host\/main/);
  v = await repos.review(link);
  assert.equal(v.behind, 1);

  // main is checked out in the clone and clean: the merge happens there, as a merge commit.
  log.length = 0;
  await repos.merge(link, log);
  assert.match(log.join("\n"), /Merged agent\/demo into main/);
  assert.equal(sh(link.hostPath, "log", "-1", "--format=%s"), "Merge branch 'agent/demo' into main");
  assert.equal((await repos.review(link)).commits.length, 0);

  await repos.push(link, log);
  assert.equal(sh(origin, "log", "-1", "--format=%s", "main"), "Merge branch 'agent/demo' into main");
});

test("merging when base isn't checked out, and a conflict that changes nothing", async () => {
  const host = join(tmp, "host2");
  sh(tmp, "clone", "-q", origin, host);
  sh(host, "checkout", "-q", "-b", "elsewhere");
  const log: string[] = [];
  const link = await repos.link({ sandbox: "two", source: host, base: "main" }, [], log);
  assert.equal(link.name, "host2");
  await repos.sendIn("two", link, log, false);
  const inside = join(box, "host2");

  // Fast-forward without a work tree.
  commit(inside, "a.txt", "a\n", "a");
  await repos.getOut("two", link, log);
  await repos.merge(link, log);
  assert.match(log.at(-1) ?? "", /Fast-forwarded main/);
  assert.equal(sh(host, "log", "-1", "--format=%s", "main"), "a");
  assert.equal(sh(host, "branch", "--show-current"), "elsewhere");

  // Both sides change the same line: merge-tree reports the conflict and main stays put.
  commit(inside, "README.md", "agent\n", "agent edit");
  await repos.getOut("two", link, log);
  sh(host, "checkout", "-q", "main");
  commit(host, "README.md", "human\n", "human edit");
  sh(host, "checkout", "-q", "elsewhere");
  const before = sh(host, "rev-parse", "main");
  await assert.rejects(repos.merge(link, log), /conflicts/);
  assert.equal(sh(host, "rev-parse", "main"), before);
});

test("splitPatch reads paths, counts and binary files", () => {
  const files = repos.splitPatch(
    [
      "diff --git a/x.txt b/x.txt",
      "index 1..2 100644",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+more",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed, f.binary]),
    [
      ["x.txt", 2, 1, false],
      ["img.png", 0, 0, true],
    ],
  );
});
