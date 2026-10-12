// Repositories in and out of a sandbox with git bundles, as openshell-configs'
// bundle.sh does, plus the host side around it: clone or pull from the remote,
// review the agent's branch, merge it into the base branch, push.
//
// Git with credentials only ever runs here on the host. The sandbox gets a bundle
// of the base branch (no other branches, no remote, no credentials), and what
// comes back is a bundle of the agent's branch, verified and fetched under that
// branch's name. Nothing from the sandbox is merged until you ask for it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { RepoCommit, RepoFile, RepoLink, RepoReview } from "../shared/protocol.ts";
import { CliError, download, execScript, upload } from "./openshell.ts";

export const REPOS_DIR = process.env.CONSOLE_REPOS ?? join(homedir(), "sandbox-repos");
const MAX_PATCH = 1_500_000;
const MAX_COMMITS = 200;

// ---- git on the host

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run git without a shell. Never prompts: a credential prompt would hang the bridge. */
export function git(cwd: string | null, args: string[], timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((done, fail) => {
    const child = spawn("git", ["-c", "protocol.ext.allow=never", ...args], {
      cwd: cwd ?? undefined,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes", LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new CliError(`git ${args[0]} timed out after ${timeoutMs / 1000}s`, stderr));
    }, timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new CliError(e.code === "ENOENT" ? "git was not found in PATH" : `cannot start git: ${e.message}`, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

async function gitOk(cwd: string | null, args: string[], timeoutMs?: number): Promise<string> {
  const r = await git(cwd, args, timeoutMs);
  if (r.code !== 0) throw new CliError(`git ${args[0]} failed`, (r.stderr || r.stdout).trim() || `exit code ${r.code}`);
  return r.stdout;
}

async function rev(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await git(cwd, ["merge-base", "--is-ancestor", a, b])).code === 0;
}

async function count(cwd: string, range: string): Promise<number> {
  return Number((await gitOk(cwd, ["rev-list", "--count", range])).trim());
}

/** The work tree that has `branch` checked out, if any (the main one or a `git worktree`). */
async function worktreeOf(cwd: string, branch: string): Promise<string | null> {
  const out = await gitOk(cwd, ["worktree", "list", "--porcelain"]);
  for (const block of out.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path;
  }
  return null;
}

/** Changes to tracked files. Untracked files don't stop a merge or a fast-forward unless they're in the way, and git checks that itself. */
async function isDirty(worktree: string): Promise<boolean> {
  return (await gitOk(worktree, ["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
}

async function hasOrigin(cwd: string): Promise<boolean> {
  return (await gitOk(cwd, ["remote"])).split("\n").includes("origin");
}

async function validBranch(name: string): Promise<boolean> {
  return (await git(null, ["check-ref-format", "--branch", name])).code === 0;
}

// ---- linking

const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

function expandHome(p: string) {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** The repo's name in /sandbox: its directory name, made safe for a path. */
export function sandboxName(hostPath: string) {
  const n = basename(hostPath)
    .replace(/\.git$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  return n || "repo";
}

export interface LinkRequest {
  sandbox: string;
  source: string;
  base?: string;
  dest?: string;
}

/**
 * Clone `source` if it's a URL (or reuse an earlier clone of it at `dest`), or use it
 * as a host path. Returns the link; nothing is sent to the sandbox yet.
 */
export async function link(req: LinkRequest, existing: RepoLink[], log: string[]): Promise<RepoLink> {
  const source = req.source.trim();
  if (!source) throw new CliError("Give a repository URL or a path on this machine.", "");
  if (source.startsWith("-")) throw new CliError("That doesn't look like a repository.", source);
  let hostPath: string;
  let cloneUrl: string | undefined;
  if (looksLikeUrl(source)) {
    cloneUrl = source;
    const dest = resolve(expandHome(req.dest?.trim() || join(REPOS_DIR, sandboxName(source.replace(/[/:]+$/, "")))));
    if (existsSync(join(dest, ".git"))) {
      const origin = (await git(dest, ["remote", "get-url", "origin"])).stdout.trim();
      if (origin !== source) {
        throw new CliError(
          `${dest} already exists and is a clone of something else.`,
          origin || "(no origin)",
          "Choose another directory to clone into.",
        );
      }
      log.push(`Using the earlier clone in ${dest}.`);
    } else if (existsSync(dest) && (await readdir(dest)).length) {
      throw new CliError(`${dest} already exists and isn't empty.`, "", "Choose another directory to clone into.");
    } else {
      await gitOk(null, ["clone", "--quiet", "--", source, dest], 900_000).catch((e: CliError) => {
        throw new CliError(
          "git clone failed",
          e.detail,
          /terminal prompts disabled|could not read Username|Permission denied|Authentication failed/i.test(e.detail)
            ? "The console can't answer a password prompt. Use an SSH URL with a key in ssh-agent, or a credential helper."
            : undefined,
        );
      });
      log.push(`Cloned ${source} into ${dest}.`);
    }
    hostPath = dest;
  } else {
    const p = resolve(expandHome(source));
    if (!isAbsolute(expandHome(source))) throw new CliError("Give the full path of the repository on this machine.", source);
    // git fails to start in a directory that doesn't exist.
    const top = existsSync(p) ? await git(p, ["rev-parse", "--show-toplevel"]) : null;
    if (top?.code !== 0) throw new CliError(`${p} is not a git repository.`, top?.stderr.trim() ?? "It doesn't exist.");
    hostPath = top.stdout.trim();
  }

  // The base branch: as asked, else origin's default branch, else what is checked out.
  let base = req.base?.trim() || "";
  if (!base) {
    const head = (await git(hostPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).stdout.trim();
    base = head.replace(/^origin\//, "") || (await git(hostPath, ["branch", "--show-current"])).stdout.trim() || "main";
  }
  if (!(await validBranch(base))) throw new CliError(`${base} isn't a valid branch name.`, "");
  if (!(await rev(hostPath, `refs/heads/${base}`))) {
    if (await rev(hostPath, `refs/remotes/origin/${base}`)) await gitOk(hostPath, ["branch", "--quiet", "--", base, `origin/${base}`]);
    else throw new CliError(`Branch ${base} doesn't exist in ${hostPath}.`, "", "Give the base branch to use.");
  }

  const name = sandboxName(hostPath);
  const clash = existing.find((r) => r.name === name && r.hostPath !== hostPath);
  if (clash) throw new CliError(`This sandbox already has a repository named ${name}.`, clash.hostPath, "Unlink it first.");
  const branch = `agent/${req.sandbox}`;
  if (!(await validBranch(branch))) throw new CliError(`Can't use ${branch} as a branch name.`, "");
  return { name, hostPath, cloneUrl, base, branch, sandboxPath: `/sandbox/${name}` };
}

// ---- in

/** Bring base up to date with origin, if there is one and it can fast-forward. Never rewrites local commits. */
async function pullBase(r: RepoLink, log: string[]) {
  if (!(await hasOrigin(r.hostPath))) {
    log.push(`No origin remote: sending ${r.base} as it is on this machine.`);
    return;
  }
  await gitOk(r.hostPath, ["fetch", "--quiet", "origin", `+refs/heads/${r.base}:refs/remotes/origin/${r.base}`], 600_000).catch((e: CliError) => {
    throw new CliError(`Could not fetch ${r.base} from origin`, e.detail, "Check your network and credentials, or fix origin in the repository.");
  });
  const local = await rev(r.hostPath, `refs/heads/${r.base}`);
  const remote = await rev(r.hostPath, `refs/remotes/origin/${r.base}`);
  if (!remote || local === remote) {
    log.push(`${r.base} is up to date with origin.`);
    return;
  }
  if (local && !(await isAncestor(r.hostPath, local, remote))) {
    log.push(`warning: ${r.base} here has commits that aren't on origin. Sending it as it is here; push it when you're ready.`);
    return;
  }
  const n = local ? await count(r.hostPath, `${local}..${remote}`) : 0;
  const wt = await worktreeOf(r.hostPath, r.base);
  if (wt) {
    if (await isDirty(wt)) {
      log.push(`warning: ${r.base} is checked out in ${wt} with uncommitted changes, so it wasn't updated from origin. Sending it as it is.`);
      return;
    }
    await gitOk(wt, ["merge", "--ff-only", "--quiet", `refs/remotes/origin/${r.base}`]);
  } else {
    await gitOk(r.hostPath, ["update-ref", `refs/heads/${r.base}`, remote, local ?? ""]);
  }
  log.push(`Pulled ${n} new commit${n === 1 ? "" : "s"} on ${r.base} from origin.`);
}

const IN_SCRIPT = `
set -e
bundle=$1 repo=$2 branch=$3 base=$4 sandbox=$5
trap 'rm -f "$bundle"' EXIT
if [ ! -d "$repo/.git" ]; then
  if [ -e "$repo" ] && [ -n "$(ls -A "$repo" 2>/dev/null)" ]; then
    echo "$repo exists in the sandbox and isn't a git repository." >&2; exit 2
  fi
  git init -q "$repo"
  cd "$repo"
  git fetch -q "$bundle" "+refs/heads/*:refs/remotes/host/*"
  git config user.name "Agent ($sandbox)"
  git config user.email "agent@$sandbox.sandbox"
  git checkout -q -b "$branch" "host/$base"
  echo "RESULT created $branch 0"
else
  cd "$repo"
  git fetch -q "$bundle" "+refs/heads/*:refs/remotes/host/*"
  cur=$(git branch --show-current)
  behind=0
  if git rev-parse --verify -q "refs/heads/$branch" >/dev/null; then behind=$(git rev-list --count "$branch..host/$base"); fi
  echo "RESULT updated \${cur:-detached} $behind"
fi
`;

/** Pull base from origin (unless `pull` is false), bundle it and fetch it into the sandbox repo as host/<base>. */
export async function sendIn(sandbox: string, r: RepoLink, log: string[], pull = true) {
  if (pull) await pullBase(r, log);
  const dir = await mkdtemp(join(tmpdir(), "sandbox-console-"));
  const file = `.console-in-${Date.now().toString(36)}.bundle`;
  try {
    await gitOk(r.hostPath, ["bundle", "create", "--quiet", join(dir, file), `refs/heads/${r.base}`], 600_000);
    await upload(sandbox, join(dir, file), "/sandbox/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const res = await execScript(sandbox, IN_SCRIPT, [`/sandbox/${file}`, r.sandboxPath, r.branch, r.base, sandbox], 300_000);
  if (res.code !== 0) throw new CliError("Could not bring the repository into the sandbox", (res.stderr || res.stdout).trim());
  const [, what, current, behind] = /RESULT (\S+) (\S+) (\d+)/.exec(res.stdout) ?? [];
  if (what === "created") {
    log.push(`Created ${r.sandboxPath} in the sandbox, on branch ${r.branch} from ${r.base}.`);
  } else {
    log.push(`Sent ${r.base} into ${r.sandboxPath} as host/${r.base}.`);
    if (current && current !== r.branch) log.push(`note: the sandbox repo is on ${current}, not ${r.branch}. Only ${r.branch} comes back out.`);
    if (Number(behind) > 0) {
      log.push(`${r.branch} is ${behind} commit${behind === "1" ? "" : "s"} behind host/${r.base}. Ask the agent to merge or rebase host/${r.base}.`);
    }
  }
}

// ---- out

const OUT_SCRIPT = `
set -e
repo=$1 branch=$2 base=$3 bundle=$4
cd -- "$repo" 2>/dev/null || { echo "$repo doesn't exist in the sandbox." >&2; exit 2; }
git rev-parse --verify -q "refs/heads/$branch" >/dev/null || { echo "Branch $branch doesn't exist in $repo." >&2; exit 2; }
git rev-parse --verify -q "refs/remotes/host/$base" >/dev/null || { echo "host/$base is missing in $repo; send the repository in again." >&2; exit 2; }
dirty=0
[ -z "$(git status --porcelain)" ] || dirty=1
n=$(git rev-list --count "host/$base..$branch")
if [ "$n" -eq 0 ]; then echo "RESULT 0 $dirty"; exit 0; fi
git bundle create -q "$bundle" "$branch" "^host/$base"
echo "RESULT $n $dirty"
`;

/** Bundle the agent's commits in the sandbox and fetch them into the host repo as the same branch. */
export async function getOut(sandbox: string, r: RepoLink, log: string[]) {
  const file = `/sandbox/.console-out-${Date.now().toString(36)}.bundle`;
  const res = await execScript(sandbox, OUT_SCRIPT, [r.sandboxPath, r.branch, r.base, file], 300_000);
  if (res.code !== 0) throw new CliError("Could not bundle the agent's commits", (res.stderr || res.stdout).trim());
  const [, n = "0", dirty = "0"] = /RESULT (\d+) (\d)/.exec(res.stdout) ?? [];
  if (dirty === "1") log.push("warning: the sandbox repo has uncommitted changes. Only commits come out; ask the agent to commit.");
  if (n === "0") {
    log.push(`No new commits on ${r.branch} in the sandbox.`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "sandbox-console-"));
  try {
    await download(sandbox, file, `${dir}/`);
    const [name] = await readdir(dir);
    if (!name) throw new CliError("The bundle download produced no file", "");
    const path = join(dir, name);
    const verify = await git(r.hostPath, ["bundle", "verify", "--quiet", path]);
    if (verify.code !== 0) throw new CliError(`The bundle from the sandbox doesn't fit ${r.hostPath}. Nothing was changed.`, verify.stderr.trim());
    if (await worktreeOf(r.hostPath, r.branch)) {
      throw new CliError(`${r.branch} is checked out on this machine, so it can't be updated.`, "", "Switch that work tree to another branch.");
    }
    // The sandbox owns this branch: if the agent rebased, take its version.
    await gitOk(r.hostPath, ["fetch", "--quiet", path, `+refs/heads/${r.branch}:refs/heads/${r.branch}`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await execScript(sandbox, 'rm -f "$1"', [file], 30_000).catch(() => {});
  }
  log.push(`Fetched ${n} commit${n === "1" ? "" : "s"} into ${r.hostPath} as ${r.branch}.`);
}

// ---- review

/** Split `git diff` output into files. */
export function splitPatch(text: string): RepoFile[] {
  const files: RepoFile[] = [];
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const lines = chunk.split("\n");
    const header = lines[0];
    let path = /^diff --git a\/(.*) b\/(.*)$/.exec(header)?.[2] ?? header.slice(11);
    const plus = lines.find((l) => l.startsWith("+++ "));
    if (plus && plus !== "+++ /dev/null") path = plus.slice(6);
    else if (plus === "+++ /dev/null") path = lines.find((l) => l.startsWith("--- "))?.slice(6) ?? path;
    const start = lines.findIndex((l) => l.startsWith("@@"));
    const body = start < 0 ? [] : lines.slice(start);
    let added = 0;
    let removed = 0;
    for (const l of body) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
    files.push({ path, added, removed, binary: lines.some((l) => l.startsWith("Binary files ")), patch: body.join("\n").replace(/\n$/, "") });
  }
  return files;
}

export async function review(r: RepoLink): Promise<RepoReview> {
  const empty: RepoReview = { base: r.base, branch: r.branch, hasBranch: false, commits: [], behind: 0, files: [], truncated: false };
  if (!(await rev(r.hostPath, `refs/heads/${r.branch}`))) return empty;
  const range = `refs/heads/${r.base}..refs/heads/${r.branch}`;
  const log = await gitOk(r.hostPath, ["log", `--max-count=${MAX_COMMITS}`, "--format=%H%x1f%an%x1f%at%x1f%s", range]);
  const commits: RepoCommit[] = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, author, time, subject] = l.split("\x1f");
      return { sha, author, time: Number(time) * 1000, subject };
    });
  const behind = await count(r.hostPath, `refs/heads/${r.branch}..refs/heads/${r.base}`);
  // What merging would bring in: the branch since it left base.
  const diff = await gitOk(r.hostPath, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    `refs/heads/${r.base}...refs/heads/${r.branch}`,
  ]);
  const truncated = diff.length > MAX_PATCH;
  return { ...empty, hasBranch: true, commits, behind, files: splitPatch(truncated ? diff.slice(0, MAX_PATCH) : diff), truncated };
}

// ---- merge and push

/**
 * Merge the agent's branch into base on the host: a fast-forward when base hasn't
 * moved, otherwise a merge commit. If base is checked out, that work tree must be
 * clean and is updated; if not, only the branch ref moves.
 */
export async function merge(r: RepoLink, log: string[]) {
  const head = await rev(r.hostPath, `refs/heads/${r.branch}`);
  const baseRev = await rev(r.hostPath, `refs/heads/${r.base}`);
  if (!head) throw new CliError(`There is no ${r.branch} here yet.`, "", "Get the agent's changes first.");
  if (!baseRev) throw new CliError(`Branch ${r.base} is gone from ${r.hostPath}.`, "");
  if ((await count(r.hostPath, `${baseRev}..${head}`)) === 0) {
    log.push(`${r.base} already has everything on ${r.branch}.`);
    return;
  }
  const message = `Merge branch '${r.branch}' into ${r.base}`;
  const ff = await isAncestor(r.hostPath, baseRev, head);
  const wt = await worktreeOf(r.hostPath, r.base);
  if (wt) {
    if (await isDirty(wt)) {
      throw new CliError(`${r.base} is checked out in ${wt} with uncommitted changes.`, "", "Commit or stash them, then merge again.");
    }
    const m = await git(wt, ["merge", "--no-edit", "-m", message, `refs/heads/${r.branch}`]);
    if (m.code !== 0) {
      await git(wt, ["merge", "--abort"]);
      throw new CliError("The merge has conflicts, so nothing was merged.", (m.stdout + m.stderr).trim(), conflictHint(r));
    }
    log.push(ff ? `Fast-forwarded ${r.base} in ${wt}.` : `Merged ${r.branch} into ${r.base} in ${wt}.`);
    return;
  }
  if (ff) {
    await gitOk(r.hostPath, ["update-ref", `refs/heads/${r.base}`, head, baseRev]);
    log.push(`Fast-forwarded ${r.base} to ${r.branch}.`);
    return;
  }
  // Not checked out: merge without a work tree.
  const t = await git(r.hostPath, ["merge-tree", "--write-tree", "--name-only", "--no-messages", baseRev, head]);
  if (t.code === 1) {
    throw new CliError("The merge has conflicts, so nothing was merged.", t.stdout.split("\n").slice(1).filter(Boolean).join("\n"), conflictHint(r));
  }
  if (t.code !== 0) throw new CliError("git merge-tree failed", t.stderr.trim());
  const tree = t.stdout.split("\n")[0].trim();
  const commit = (await gitOk(r.hostPath, ["commit-tree", tree, "-p", baseRev, "-p", head, "-m", message])).trim();
  await gitOk(r.hostPath, ["update-ref", `refs/heads/${r.base}`, commit, baseRev]);
  log.push(`Merged ${r.branch} into ${r.base} (merge commit ${commit.slice(0, 8)}).`);
}

const conflictHint = (r: RepoLink) =>
  `Send the latest ${r.base} into the sandbox and ask the agent to merge host/${r.base} into ${r.branch}, then get the changes again.`;

export async function push(r: RepoLink, log: string[]) {
  if (!(await hasOrigin(r.hostPath))) throw new CliError(`${r.hostPath} has no origin remote to push to.`, "");
  const out = await git(r.hostPath, ["push", "--porcelain", "origin", `refs/heads/${r.base}:refs/heads/${r.base}`], 600_000);
  if (out.code !== 0) {
    throw new CliError(
      `Could not push ${r.base} to origin`,
      (out.stderr || out.stdout).trim(),
      /rejected|non-fast-forward|fetch first/i.test(out.stderr + out.stdout)
        ? `origin has commits on ${r.base} that aren't here. Send latest (which pulls), merge again, then push.`
        : undefined,
    );
  }
  log.push(`Pushed ${r.base} to origin.`);
}
