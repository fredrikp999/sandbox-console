// Files in and out of a sandbox: browse a folder, download a file (or a folder as
// a .tar), upload files. Everything is under /sandbox, the only place
// `openshell sandbox download` reads from. Listing and file sizes come from a small
// shell script in the sandbox; the bytes travel through `sandbox download` and
// `sandbox upload`, and are streamed to or from the browser by index.ts.
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { FileEntry } from "../shared/protocol.ts";
import { CliError, download, execScript, upload } from "./openshell.ts";

export const WORKSPACE = "/sandbox";
export const MAX_DOWNLOAD = 1_000_000_000;
export const MAX_UPLOAD = 500_000_000;
const MAX_ENTRIES = 2_000;

/** A request the caller got wrong, with the HTTP status index.ts answers with. */
export function refused(status: number, message: string, detail = "", hint?: string) {
  return Object.assign(new CliError(message, detail, hint), { status });
}

/** A normalized absolute path inside /sandbox, or an error saying why not. */
export function cleanPath(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/") || /[\0\n\r]/.test(p) || p.length > 4096) {
    throw refused(400, "Give an absolute path inside /sandbox.");
  }
  const n = posix.normalize(p).replace(/(.)\/+$/, "$1");
  if (n !== WORKSPACE && !n.startsWith(`${WORKSPACE}/`)) {
    throw refused(400, "Only files under /sandbox can be browsed.", n, "The sandbox's download reads only from /sandbox.");
  }
  return n;
}

/** A file name to upload as: one path segment, not a flag, nothing odd. */
export function cleanName(n: unknown): string {
  if (typeof n !== "string" || !n || n.length > 200 || /[/\\\0\n\r]/.test(n) || n === "." || n === ".." || n.startsWith("-")) {
    throw refused(400, "That isn't a usable file name.", String(n));
  }
  return n;
}

// $1 the folder. Prints "<type>|<size>|<mtime>|<./name>" per entry, following symlinks.
const LIST = `
cd "$1" 2>/dev/null || { echo "not a folder: $1" >&2; exit 3; }
for f in ./* ./.[!.]* ./..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  stat -L -c '%F|%s|%Y|%n' -- "$f" 2>/dev/null || stat -c '%F|%s|%Y|%n' -- "$f" 2>/dev/null
done
exit 0
`;

export function parseList(text: string): { entries: FileEntry[]; truncated: boolean } {
  const entries: FileEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^([^|]*)\|(\d+)\|(\d+)\|\.\/(.+)$/.exec(line);
    if (!m) continue;
    const type = m[1].toLowerCase();
    entries.push({
      name: m[4],
      kind: type.startsWith("directory") ? "dir" : type.startsWith("regular") ? "file" : "other",
      size: Number(m[2]),
      mtime: Number(m[3]),
    });
  }
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

export async function list(sandbox: string, path: string) {
  const r = await execScript(sandbox, LIST, [path], 30_000);
  if (r.code !== 0) throw new CliError(r.code === 3 ? `${path} isn't a folder in the sandbox.` : "Couldn't list the folder", r.stderr.trim());
  return parseList(r.stdout);
}

// $1 a path. Prints "<type>|<size>" (a folder's size is what `du` says, in bytes).
const STAT = `
t=$(stat -L -c '%F' -- "$1" 2>/dev/null) || { echo "no such file: $1" >&2; exit 3; }
case $t in
  [Dd]irectory*) s=$(du -sk -- "$1" 2>/dev/null | cut -f1); echo "dir|$(( \${s:-0} * 1024 ))" ;;
  [Rr]egular*) echo "file|$(stat -L -c '%s' -- "$1")" ;;
  *) echo "other|0" ;;
esac
`;

// $1 a folder, $2 the tar to make (in /sandbox, so it can be downloaded).
const TAR = `set -e
tar -cf "$2" -C "$(dirname -- "$1")" -- "$(basename -- "$1")"
`;

export interface Download {
  /** The local copy to stream. */
  file: string;
  /** What to call it. */
  name: string;
  size: number;
  cleanup: () => Promise<void>;
}

/** Bring a file (or a folder, as a .tar) out of the sandbox into a temporary directory. */
export async function fetchOut(sandbox: string, path: string): Promise<Download> {
  const s = await execScript(sandbox, STAT, [path], 30_000);
  if (s.code !== 0) throw refused(404, "There's no such file in the sandbox.", s.stderr.trim());
  const [kind, bytes] = s.stdout.trim().split("|");
  const size = Number(bytes);
  if (kind === "other") throw new CliError("That isn't a file or a folder.", path);
  if (size > MAX_DOWNLOAD)
    throw refused(413, `Too big to download here (${Math.round(size / 1e6)} MB; the limit is ${MAX_DOWNLOAD / 1e6} MB).`, path);

  const dir = await mkdtemp(join(tmpdir(), "sandbox-console-file-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  let remote = path;
  let tarRemote: string | null = null;
  try {
    if (kind === "dir") {
      tarRemote = `${WORKSPACE}/.sandbox-console-out-${randomBytes(6).toString("hex")}.tar`;
      const t = await execScript(sandbox, TAR, [path, tarRemote], 300_000);
      if (t.code !== 0) throw new CliError("Couldn't pack the folder", (t.stderr || t.stdout).trim());
      remote = tarRemote;
    }
    await download(sandbox, remote, dir);
    const [got] = await readdir(dir);
    if (!got) throw new CliError("The sandbox sent nothing.", path);
    const file = join(dir, got);
    const name = kind === "dir" ? `${posix.basename(path)}.tar` : posix.basename(path);
    return { file, name, size: (await stat(file)).size, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  } finally {
    if (tarRemote) await execScript(sandbox, 'rm -f -- "$1"', [tarRemote], 30_000).catch(() => {});
  }
}

// $1 the file. Exit 0 if it exists.
const EXISTS = '[ -e "$1" ] || [ -L "$1" ]';

export async function exists(sandbox: string, path: string): Promise<boolean> {
  return (await execScript(sandbox, EXISTS, [path], 30_000)).code === 0;
}

/** Put a local file in a folder of the sandbox, under its own name (so it must be named as it should end up). */
export async function putIn(sandbox: string, localFile: string, folder: string) {
  await upload(sandbox, localFile, `${folder}/`);
}
