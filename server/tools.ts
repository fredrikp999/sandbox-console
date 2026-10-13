// Tools from the catalog (tools/<name>.json): command-line programs that don't
// need root, fetched here on the host and copied into the sandbox. The sandbox's
// network policy doesn't change, so the agent never gets a package registry or a
// download site; it only gets the files.
//
//   { "description": "…", "npm": "prettier@3.9.10" }
//   { "description": "…", "binary": "jq",
//     "downloads": { "linux-arm64": { "url": "…", "sha256": "…" }, "linux-x64": { … } } }
//
// npm packages are pinned to an exact version and installed with
// --ignore-scripts, for the sandbox's OS, CPU and C library, so packages with
// prebuilt binaries for Linux get the right ones; npm checks every tarball against
// the registry's integrity hash. Packages that would have to be compiled are
// refused. Binaries are checked against their SHA-256. A download that is an
// archive (.tar.gz, .tar.xz, .zip) needs "path", the binary's path inside it.
//
// In the sandbox a tool lives in ~/.local/share/sandbox-console/tools/<name>,
// with a small launcher per command in ~/.local/bin, which the console puts on
// the agent's PATH (and the login shell's, for the VS Code terminal).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CliError, execScript } from "./openshell.ts";

export const HOME = "/sandbox";
export const TOOLS_DIR = `${HOME}/.local/share/sandbox-console/tools`;
export const BIN_DIR = `${HOME}/.local/bin`;
const MAX_BYTES = 300_000_000;
/** Commands become file names in ~/.local/bin and words in a shell script. */
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** An exact version: no ranges or tags, so what was reviewed is what goes in. */
const NPM_SPEC = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

export interface ToolSpec {
  description?: string;
  npm?: string;
  binary?: string;
  downloads?: Record<string, { url: string; sha256: string; path?: string }>;
}

export interface Platform {
  /** "linux-arm64" or "linux-x64". */
  id: string;
  cpu: "arm64" | "x64";
  libc: "glibc" | "musl";
  node: boolean;
}

/** What's wrong with a tool's definition, if anything. */
export function check(spec: ToolSpec): string | undefined {
  if (!!spec.npm === !!spec.binary) return 'Give either "npm" or "binary".';
  if (spec.npm && !NPM_SPEC.test(spec.npm)) return `"npm" must be a package with an exact version, like prettier@3.9.10 (not ${spec.npm}).`;
  if (spec.binary) {
    if (!COMMAND.test(spec.binary)) return `"binary" must be a plain command name (not ${spec.binary}).`;
    const d = Object.entries(spec.downloads ?? {});
    if (!d.length) return '"downloads" is missing.';
    for (const [k, v] of d) {
      if (!/^https:\/\//.test(v?.url ?? "")) return `downloads.${k}.url must be an https:// URL.`;
      if (!/^[0-9a-f]{64}$/i.test(v?.sha256 ?? "")) return `downloads.${k}.sha256 must be a SHA-256 in hex.`;
      if (v.path && (v.path.startsWith("/") || v.path.split("/").includes("..")))
        return `downloads.${k}.path must be a relative path in the archive.`;
    }
  }
  return undefined;
}

// ---- the sandbox's platform

const PLATFORM = `
uname -m
if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; else echo glibc; fi
command -v node >/dev/null 2>&1 && echo node || echo no-node
`;

export async function platform(sandbox: string): Promise<Platform> {
  const r = await execScript(sandbox, PLATFORM, [], 60_000);
  if (r.code !== 0) throw new CliError("Couldn't tell what the sandbox runs on", (r.stderr || r.stdout).trim());
  const [arch, libc, node] = r.stdout.trim().split("\n");
  const cpu = arch === "aarch64" || arch === "arm64" ? "arm64" : arch === "x86_64" ? "x64" : null;
  if (!cpu) throw new CliError(`Tools aren't supported on ${arch} sandboxes.`, "");
  return { id: `linux-${cpu}`, cpu, libc: libc === "musl" ? "musl" : "glibc", node: node === "node" };
}

// ---- fetching on the host

function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, npm_config_update_notifier: "false" } });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new CliError(e.code === "ENOENT" ? `${cmd} was not found in PATH` : `cannot start ${cmd}: ${e.message}`, ""));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export interface Prepared {
  /** Files under the tool's directory. */
  files: { rel: string; abs: string; exec: boolean }[];
  /** Command name -> the file it runs, relative to the tool's directory, and whether it's a node script. */
  commands: { name: string; target: string; node: boolean }[];
  log: string[];
}

async function walkAll(dir: string, acc: { rel: string; abs: string; exec: boolean; size: number }[] = [], root = dir) {
  for (const e of await readdir(dir)) {
    if (e === ".bin" || e === ".package-lock.json") continue;
    const abs = join(dir, e);
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) await walkAll(abs, acc, root);
    else if (s.isFile()) acc.push({ rel: relative(root, abs), abs, exec: !!(s.mode & 0o111), size: s.size });
  }
  return acc;
}

const isNodeScript = async (file: string) => /^#!.*\bnode\b/.test((await readFile(file, "utf8").catch(() => "")).split("\n", 1)[0]);

async function prepareNpm(spec: string, p: Platform, dir: string): Promise<Prepared> {
  const m = NPM_SPEC.exec(spec);
  if (!m) throw new CliError(`Not an exact npm version: ${spec}`, "");
  const pkg = m[1];
  if (!p.node) throw new CliError("This sandbox has no node, which npm tools need.", "");
  await writeFile(join(dir, "package.json"), '{ "private": true }\n');
  const r = await run(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", `--os=linux`, `--cpu=${p.cpu}`, `--libc=${p.libc}`, spec],
    dir,
  );
  if (r.code !== 0) throw new CliError(`npm couldn't fetch ${spec}`, r.out.trim().split("\n").slice(-15).join("\n"));
  const log = [`Fetched ${spec} for ${p.id}${p.libc === "musl" ? " (musl)" : ""} with npm, install scripts not run.`];

  // What would have needed install scripts or a compiler.
  const scripted: string[] = [];
  const compiled: string[] = [];
  const files = await walkAll(join(dir, "node_modules"));
  for (const f of files.filter((f) => f.rel.endsWith("/package.json"))) {
    // A package's own package.json: right under node_modules/ (or node_modules/@scope/).
    const parts = ["node_modules", ...f.rel.split("/").slice(0, -1)];
    const n = parts.length;
    const scoped = parts[n - 2]?.startsWith("@") && parts[n - 3] === "node_modules";
    if (parts[n - 2] !== "node_modules" && !scoped) continue;
    const name = parts.slice(scoped ? n - 2 : n - 1).join("/");
    const root = `${parts.slice(1).join("/")}/`;
    const own = files.filter((x) => x.rel.startsWith(root) && !x.rel.slice(root.length).includes("node_modules/"));
    const j = JSON.parse(await readFile(f.abs, "utf8").catch(() => "{}"));
    const s = j.scripts ?? {};
    if (own.some((x) => x.rel === `${root}binding.gyp`) && !own.some((x) => x.rel.endsWith(".node"))) compiled.push(name);
    else if (s.preinstall || s.install || s.postinstall) scripted.push(name);
  }
  if (compiled.length) {
    throw new CliError(
      `${spec} has native code that has to be compiled (${compiled.join(", ")}), which can't happen here.`,
      "",
      "Use a sandbox type whose image installs it, or add it to an image in openshell-configs.",
    );
  }
  if (scripted.length) log.push(`warning: these have install scripts that weren't run: ${scripted.join(", ")}. If the tool fails, it may need them.`);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > MAX_BYTES) throw new CliError(`${spec} is too big (${Math.round(bytes / 1e6)} MB).`, "");

  const manifest = JSON.parse(await readFile(join(dir, "node_modules", pkg, "package.json"), "utf8"));
  const bin: Record<string, string> = typeof manifest.bin === "string" ? { [pkg.split("/").pop() as string]: manifest.bin } : (manifest.bin ?? {});
  const commands: Prepared["commands"] = [];
  for (const [name, target] of Object.entries(bin)) {
    if (!COMMAND.test(name)) continue;
    const rel = join("node_modules", pkg, target).replace(/\\/g, "/");
    if (rel.split("/").includes("..")) continue;
    commands.push({ name, target: rel, node: await isNodeScript(join(dir, rel)) });
  }
  if (!commands.length) throw new CliError(`${pkg} has no commands to run.`, "");
  return { files: files.map((f) => ({ rel: `node_modules/${f.rel}`, abs: f.abs, exec: f.exec })), commands, log };
}

async function prepareBinary(spec: ToolSpec, p: Platform, dir: string): Promise<Prepared> {
  const name = spec.binary as string;
  const d = spec.downloads?.[p.id];
  if (!d) throw new CliError(`${name} has no download for ${p.id}.`, `It has: ${Object.keys(spec.downloads ?? {}).join(", ")}`);
  const res = await fetch(d.url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new CliError(`Couldn't download ${name}: HTTP ${res.status}`, d.url);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_BYTES) throw new CliError(`${name} is too big (${Math.round(data.length / 1e6)} MB).`, "");
  const sum = createHash("sha256").update(data).digest("hex");
  if (sum !== d.sha256.toLowerCase())
    throw new CliError(`${name} doesn't match its SHA-256, so it wasn't used.`, `expected ${d.sha256}\ngot      ${sum}\n${d.url}`);
  const log = [`Downloaded ${name} for ${p.id} and checked its SHA-256.`];
  let file = join(dir, "download");
  await writeFile(file, data);
  if (d.path) {
    const out = join(dir, "x");
    await mkdir(out);
    const r = await run("tar", ["-xf", file, "-C", out], dir);
    if (r.code !== 0) throw new CliError(`Couldn't unpack ${name}`, r.out.trim());
    file = join(out, d.path);
    if (!(await stat(file).catch(() => null))?.isFile()) throw new CliError(`${d.path} isn't in the archive.`, d.url);
  }
  return { files: [{ rel: name, abs: file, exec: true }], commands: [{ name, target: name, node: false }], log };
}

/** Fetch a tool into `dir` for the sandbox's platform. */
export function prepare(spec: ToolSpec, p: Platform, dir: string): Promise<Prepared> {
  const problem = check(spec);
  if (problem) throw new CliError(problem, "");
  return spec.npm ? prepareNpm(spec.npm, p, dir) : prepareBinary(spec, p, dir);
}

/** The launcher in ~/.local/bin; its second line marks it as the console's. */
export function launcher(tool: string, c: Prepared["commands"][number]): string {
  const target = `${TOOLS_DIR}/${tool}/${c.target}`;
  return `#!/bin/sh\n# sandbox-console tool ${tool}\nexec ${c.node ? "node " : ""}"${target}" "$@"\n`;
}

// ---- in the sandbox

// $1 the unpacked tool dir, $2 name. Launchers are in $1/.launchers. A command
// that exists in ~/.local/bin and isn't one of ours is left alone (and fails).
export const INSTALL_TOOL = `
src=$1 name=$2
tools=${TOOLS_DIR} bin=${BIN_DIR}
mkdir -p "$tools" "$bin"
for l in "$src/.launchers"/*; do
  c=\${l##*/}
  if [ -e "$bin/$c" ] && ! grep -q "^# sandbox-console tool " "$bin/$c" 2>/dev/null; then
    echo "$bin/$c already exists and isn't from the console." >&2; exit 3
  fi
done
if [ -d "$tools/$name" ]; then
  for c in $(cat "$tools/$name/.commands" 2>/dev/null); do rm -f "$bin/$c"; done
  rm -rf "$tools/$name"
fi
for l in "$src/.launchers"/*; do c=\${l##*/}; mv -f "$l" "$bin/$c"; chmod 755 "$bin/$c"; done
rmdir "$src/.launchers"
mv "$src" "$tools/$name"
for rc in "${HOME}/.profile" "${HOME}/.bashrc"; do
  grep -q "sandbox-console:path" "$rc" 2>/dev/null || printf '\\n# sandbox-console:path\\ncase ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac\\n' >> "$rc"
done
`;

export const REMOVE_TOOL = `
name=$1
tools=${TOOLS_DIR} bin=${BIN_DIR}
[ -d "$tools/$name" ] || exit 0
for c in $(cat "$tools/$name/.commands" 2>/dev/null); do
  grep -q "^# sandbox-console tool $name\\$" "$bin/$c" 2>/dev/null && rm -f "$bin/$c"
done
rm -rf "$tools/$name"
`;
