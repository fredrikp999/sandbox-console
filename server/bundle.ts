// "Download as git bundle": the `out` half of openshell-configs' bundle.sh.
// Bundles the commits on the repo's current branch that are not in host/<base>
// (or the whole branch when the repo didn't come in through bundle.sh), downloads
// the bundle and hands it to the browser. You review it and fetch it yourself.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, download, execScript } from "./openshell.ts";

const SCRIPT = `
set -e
repo=$1 out=$2
cd -- "$repo" 2>/dev/null || { echo "$repo does not exist in the sandbox." >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "$repo is not a git repository." >&2; exit 2; }
branch=$(git branch --show-current)
[ -n "$branch" ] || { echo "$repo is on a detached HEAD; check out a branch first." >&2; exit 2; }
if [ -n "$(git status --porcelain)" ]; then
  echo "warning: uncommitted changes in $repo are not included" >&2
fi
base=
for b in main master; do
  if git rev-parse --verify -q "refs/remotes/host/$b" >/dev/null; then base=host/$b; break; fi
done
if [ -n "$base" ]; then
  count=$(git rev-list --count "$base..$branch")
  [ "$count" -gt 0 ] || { echo "No new commits on $branch compared with $base." >&2; exit 3; }
  git bundle create -q "$out" "$branch" "^$base"
else
  count=$(git rev-list --count "$branch")
  git bundle create -q "$out" "$branch"
fi
echo "$branch $count $base"
`;

export interface Bundle {
  path: string;
  filename: string;
  branch: string;
  commits: number;
  base: string;
  cleanup: () => Promise<void>;
}

export async function makeBundle(sandbox: string, repo: string): Promise<Bundle> {
  // `openshell sandbox download` only reads from the workspace (/sandbox), as bundle.sh does.
  const remote = `/sandbox/.console-${Date.now().toString(36)}.bundle`;
  const r = await execScript(sandbox, SCRIPT, [repo, remote]);
  if (r.code !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`;
    throw new CliError(
      r.code === 3 ? "Nothing to bundle" : "Could not create the git bundle",
      msg,
      r.code === 3 ? "Ask the agent to commit its work first." : undefined,
    );
  }
  const [branch = "", commits = "0", base = ""] = r.stdout.trim().split("\n").pop()!.split(" ");
  const dir = await mkdtemp(join(tmpdir(), "sandbox-console-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await download(sandbox, remote, dir + "/");
    const files = await readdir(dir);
    if (!files.length) throw new CliError("The bundle download produced no file", "");
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
    return {
      path: join(dir, files[0]),
      filename: `${sandbox}-${safeBranch}.bundle`,
      branch,
      commits: Number(commits),
      base,
      cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  } finally {
    await execScript(sandbox, 'rm -f "$1"', [remote], 30_000).catch(() => {});
  }
}
