// A catalog of agents, skills and context files on this machine, and putting them
// into a sandbox's home directory where its agent looks for them.
//
// Sources, first one wins for a name: your catalog folder (CONSOLE_CATALOG), the
// examples in catalog/, and what you already use with Claude Code and OpenCode on
// this machine (~/.claude, ~/.agents, ~/.config/opencode). Nothing is read from
// the sandbox except which names are there.
//
// Agents and skills become files the agent owns (~/.claude/agents/<name>.md,
// ~/.claude/skills/<name>/). Context files are added to the agent's global
// instructions (~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md) between marker
// lines, so they can be updated or taken out again without touching the rest.
// Tools (command-line programs) are fetched on this machine; see tools.ts.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogItem, CatalogKind, InstalledItem } from "../shared/protocol.ts";
import { ROOT } from "./config.ts";
import { CliError, execScript, upload } from "./openshell.ts";
import * as tools from "./tools.ts";

export const USER_CATALOG = process.env.CONSOLE_CATALOG ?? join(homedir(), ".config", "sandbox-console", "catalog");
export const KINDS: CatalogKind[] = ["agent", "skill", "context", "tool"];
/** Names that are safe as a file name and in a shell argument. */
export const ITEM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BYTES = 10_000_000;
const MAX_FILES = 2_000;
const MAX_DEPTH = 8;
const MAX_PREVIEW = 60_000;
const SKIP = new Set([".git", "node_modules", ".DS_Store", "__pycache__"]);

/** Where an agent looks for each kind, in the sandbox ($HOME is /sandbox). */
export type Layout = "claude" | "opencode";
const HOME = "/sandbox";
export const PLACES: Record<Layout, Record<CatalogKind, string>> = {
  claude: { agent: `${HOME}/.claude/agents`, skill: `${HOME}/.claude/skills`, context: `${HOME}/.claude/CLAUDE.md`, tool: tools.TOOLS_DIR },
  opencode: {
    agent: `${HOME}/.config/opencode/agents`,
    skill: `${HOME}/.config/opencode/skills`,
    context: `${HOME}/.config/opencode/AGENTS.md`,
    tool: tools.TOOLS_DIR,
  },
};

interface Source {
  label: string;
  dirs: Partial<Record<CatalogKind, string[]>>;
  /** The agent format its agent files are written in. */
  format: Layout;
}

function sources(): Source[] {
  const h = homedir();
  return [
    {
      label: "Your catalog",
      dirs: {
        agent: [join(USER_CATALOG, "agents")],
        skill: [join(USER_CATALOG, "skills")],
        context: [join(USER_CATALOG, "context")],
        tool: [join(USER_CATALOG, "tools")],
      },
      format: "claude",
    },
    {
      label: "Built in",
      dirs: {
        agent: [join(ROOT, "catalog", "agents")],
        skill: [join(ROOT, "catalog", "skills")],
        context: [join(ROOT, "catalog", "context")],
        tool: [join(ROOT, "catalog", "tools")],
      },
      format: "claude",
    },
    { label: "~/.claude", dirs: { agent: [join(h, ".claude", "agents")], skill: [join(h, ".claude", "skills")] }, format: "claude" },
    { label: "~/.agents", dirs: { skill: [join(h, ".agents", "skills")] }, format: "claude" },
    {
      label: "~/.config/opencode",
      dirs: {
        agent: [join(h, ".config", "opencode", "agents"), join(h, ".config", "opencode", "agent")],
        skill: [join(h, ".config", "opencode", "skills")],
      },
      format: "opencode",
    },
  ];
}

// ---- frontmatter

export interface Front {
  /** Top-level keys in order, each with its value lines (the first is after the colon). */
  keys: Map<string, string[]>;
  body: string;
}

export function parseFront(text: string): Front {
  const keys = new Map<string, string[]>();
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { keys, body: text };
  let cur: string[] | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (k) {
      cur = [k[2]];
      keys.set(k[1], cur);
    } else if (cur) cur.push(line);
  }
  return { keys, body: text.slice(m[0].length) };
}

/** A scalar value: plain, quoted, or a folded/literal block. */
export function scalar(f: Front, key: string): string | undefined {
  const v = f.keys.get(key);
  if (!v) return undefined;
  const [first, ...rest] = v;
  const head = first.trim();
  if (/^[>|][-+]?$/.test(head) || (!head && rest.length)) {
    const lines = rest.map((l) => l.trim());
    return (head.startsWith("|") ? lines.join("\n") : lines.filter(Boolean).join(" ")).trim();
  }
  if (head.startsWith('"')) {
    try {
      return JSON.parse(head);
    } catch {
      return head.slice(1, -1);
    }
  }
  if (head.startsWith("'") && head.endsWith("'")) return head.slice(1, -1).replaceAll("''", "'");
  return [head, ...rest.map((l) => l.trim())].filter(Boolean).join(" ");
}

const quote = (s: string) => JSON.stringify(s);

/** Claude Code tool names that OpenCode governs with a permission. */
const OPENCODE_PERMISSION: Record<string, string[]> = {
  edit: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  bash: ["Bash"],
  webfetch: ["WebFetch"],
};

/**
 * An agent file for `to`, from one written for `from`. Claude Code wants `name` and
 * `description`; OpenCode takes the name from the file and wants `mode: subagent`.
 * Models are named differently by the two, so a model is only kept within one format.
 */
export function convertAgent(text: string, name: string, from: Layout, to: Layout): string {
  if (from === to) return text;
  const f = parseFront(text);
  const description = scalar(f, "description") ?? name;
  const body = f.body.replace(/^\s*\n/, "");
  if (to === "claude") return `---\nname: ${name}\ndescription: ${quote(description)}\n---\n\n${body}`;
  const out = [`description: ${quote(description)}`, "mode: subagent"];
  const tools = scalar(f, "tools");
  if (tools) {
    const listed = new Set(tools.split(/[\s,]+/).filter(Boolean));
    const denied = Object.entries(OPENCODE_PERMISSION).filter(([, names]) => !names.some((n) => listed.has(n)));
    if (denied.length) out.push("permission:", ...denied.map(([k]) => `  ${k}: deny`));
  }
  return `---\n${out.join("\n")}\n---\n\n${body}`;
}

// ---- reading the catalog

interface FileEntry {
  rel: string;
  abs: string;
  mode: number;
  size: number;
}

/** Every file under a skill's directory, following symlinks; skips VCS and dependency folders and dotfiles. */
async function walk(dir: string, rel = "", depth = 0, acc: FileEntry[] = []): Promise<FileEntry[]> {
  if (depth > MAX_DEPTH) throw new Error("folders nested too deep");
  for (const e of (await readdir(dir)).sort()) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const abs = join(dir, e);
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    const r = rel ? `${rel}/${e}` : e;
    if (s.isDirectory()) await walk(abs, r, depth + 1, acc);
    else if (s.isFile()) {
      acc.push({ rel: r, abs, mode: s.mode, size: s.size });
      if (acc.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
    }
  }
  return acc;
}

async function hashFiles(files: FileEntry[]): Promise<string> {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.rel}\0${f.mode & 0o111 ? "x" : "-"}\0`).update(await readFile(f.abs));
  return h.digest("hex").slice(0, 16);
}

export interface Entry extends CatalogItem {
  /** Where it is on this machine. */
  path: string;
  format: Layout;
}

async function dirEntries(dir: string) {
  return (await readdir(dir).catch(() => [] as string[])).sort();
}

function describe(f: Front): string {
  const d = scalar(f, "description");
  if (d) return d;
  // Context files usually have none: the first line of text, else the first heading.
  const lines = f.body.split("\n").map((l) => l.trim());
  return lines.find((l) => l && !l.startsWith("#") && !l.startsWith("<!--")) ?? lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? "";
}

async function readTool(dir: string, entry: string, src: Source): Promise<Entry | null> {
  const name = entry.replace(/\.json$/, "");
  if (!entry.endsWith(".json") || !ITEM_NAME.test(name)) return null;
  const path = join(dir, entry);
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const item: Entry = {
    id: `tool:${name}`,
    kind: "tool",
    name,
    description: "",
    source: src.label,
    path,
    format: src.format,
    files: 1,
    bytes: text.length,
    hash: "",
  };
  try {
    const spec = JSON.parse(text) as tools.ToolSpec;
    item.description = String(spec.description ?? spec.npm ?? spec.binary ?? "").slice(0, 400);
    item.problem = tools.check(spec);
    item.hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  } catch (e) {
    item.problem = `Not valid JSON: ${(e as Error).message}`;
  }
  return item;
}

async function readItem(kind: CatalogKind, dir: string, entry: string, src: Source): Promise<Entry | null> {
  if (kind === "tool") return readTool(dir, entry, src);
  const name = kind === "skill" ? entry : entry.replace(/\.md$/, "");
  if (kind !== "skill" && !entry.endsWith(".md")) return null;
  if (!ITEM_NAME.test(name)) return null;
  const path = join(dir, entry);
  const s = await stat(path).catch(() => null);
  if (!s || (kind === "skill" ? !s.isDirectory() : !s.isFile())) return null;
  const main = kind === "skill" ? join(path, "SKILL.md") : path;
  const text = await readFile(main, "utf8").catch(() => null);
  if (text === null) return null;
  const item: Entry = {
    id: `${kind}:${name}`,
    kind,
    name,
    description: describe(parseFront(text)).slice(0, 400),
    source: src.label,
    path,
    format: src.format,
    files: 1,
    bytes: s.size,
    hash: "",
  };
  try {
    const files = kind === "skill" ? await walk(path) : [{ rel: entry, abs: path, mode: s.mode, size: s.size }];
    item.files = files.length;
    item.bytes = files.reduce((n, f) => n + f.size, 0);
    if (item.bytes > MAX_BYTES) item.problem = `Too big to copy in (${Math.round(item.bytes / 1e6)} MB; the limit is ${MAX_BYTES / 1e6} MB).`;
    else item.hash = await hashFiles(files);
  } catch (e) {
    item.problem = `Can't be copied in: ${(e as Error).message}.`;
  }
  return item;
}

let cached: { at: number; items: Promise<Entry[]> } | null = null;

/** The whole catalog, read again when it's more than a few seconds old. */
export function list(): Promise<Entry[]> {
  if (!cached || Date.now() - cached.at > 3_000) {
    cached = { at: Date.now(), items: readAll() };
    cached.items.catch(() => (cached = null));
  }
  return cached.items;
}

/** A name found in more than one source comes from the first. */
async function readAll(): Promise<Entry[]> {
  const out = new Map<string, Entry>();
  for (const src of sources()) {
    for (const kind of KINDS) {
      for (const dir of src.dirs[kind] ?? []) {
        for (const e of await dirEntries(dir)) {
          const item = await readItem(kind, dir, e, src).catch(() => null);
          if (item && !out.has(item.id)) out.set(item.id, item);
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));
}

export async function find(kind: CatalogKind, name: string): Promise<Entry> {
  const item = (await list()).find((i) => i.kind === kind && i.name === name);
  if (!item) throw new CliError(`There's no ${kind} called ${name} in the catalog.`, "", "Reload the catalog; it may have been moved or renamed.");
  return item;
}

/** The main file, as it would be installed for `layout`. */
export async function preview(item: Entry, layout: Layout): Promise<string> {
  if (item.kind === "tool") return readFile(item.path, "utf8");
  const main = item.kind === "skill" ? join(item.path, "SKILL.md") : item.path;
  let text = await readFile(main, "utf8");
  if (item.kind === "agent") text = convertAgent(text, item.name, item.format, layout);
  if (item.kind === "context") text = contextBody(text);
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n\n… (cut short)` : text;
}

/** A context file without its frontmatter, which only describes it for the catalog. */
function contextBody(text: string) {
  return parseFront(text).body.trim();
}

// ---- tar, so a skill with many files goes in with one upload

function tarHeader(name: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(512);
  let path = Buffer.from(name);
  let prefix = Buffer.alloc(0);
  if (path.length > 100) {
    const cut = name.lastIndexOf("/", name.length - 1);
    const p = Buffer.from(name.slice(0, cut));
    const n = Buffer.from(name.slice(cut + 1));
    if (cut < 0 || p.length > 155 || n.length > 100) throw new CliError(`The path ${name} is too long to copy in.`, "");
    path = n;
    prefix = p;
  }
  const oct = (n: number, len: number) => `${n.toString(8).padStart(len - 1, "0")}\0`;
  path.copy(h, 0);
  h.write(oct(mode, 8), 100);
  h.write(oct(0, 8), 108);
  h.write(oct(0, 8), 116);
  h.write(oct(size, 12), 124);
  h.write(oct(Math.floor(Date.now() / 1000), 12), 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  prefix.copy(h, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

export function tar(files: { rel: string; data: Buffer; exec?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const segs = f.rel.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/");
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(tarHeader(`${d}/`, 0, 0o755, "5"));
      }
    }
    parts.push(tarHeader(f.rel, f.data.length, f.exec ? 0o755 : 0o644, "0"), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The files to put in, laid out as `<name>.md`, `<name>/...` or `context.md`. */
async function payload(item: Entry, layout: Layout) {
  if (item.kind === "skill") {
    const files = await walk(item.path);
    return Promise.all(files.map(async (f) => ({ rel: `${item.name}/${f.rel}`, data: await readFile(f.abs), exec: !!(f.mode & 0o111) })));
  }
  const text = await readFile(item.path, "utf8");
  if (item.kind === "agent") return [{ rel: `${item.name}.md`, data: Buffer.from(convertAgent(text, item.name, item.format, layout)) }];
  return [{ rel: "context.md", data: Buffer.from(`${contextBody(text)}\n`) }];
}

// ---- in the sandbox

/** The lines a console-managed context block starts and ends with. */
export const marker = (edge: "begin" | "end", name: string) => `<!-- sandbox-console:${edge} ${name} -->`;

// Removes the block for $name from $file (and trailing blank lines), into $file.new.
const STRIP = `
strip() {
  if [ -f "$1" ]; then
    awk -v b="<!-- sandbox-console:begin $2 -->" -v e="<!-- sandbox-console:end $2 -->" '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      !skip { l[++n] = $0 }
      END { while (n > 0 && l[n] ~ /^[ \\t]*$/) n--; for (i = 1; i <= n; i++) print l[i] }' "$1" > "$1.new"
  else
    : > "$1.new"
  fi
}`;

// $1 tar, $2 kind, $3 name, $4 where (a directory, or the context file).
const INSTALL = `set -e
${STRIP}
tar=$1 kind=$2 name=$3 dest=$4
tmp=$(mktemp -d "${HOME}/.sandbox-console.XXXXXX")
trap 'rm -rf "$tmp" "$tar"' EXIT
tar -xf "$tar" -C "$tmp"
case $kind in
  agent)
    mkdir -p "$dest"
    mv -f "$tmp/$name.md" "$dest/$name.md" ;;
  skill)
    mkdir -p "$dest"
    rm -rf "$dest/$name"
    mv "$tmp/$name" "$dest/$name" ;;
  context)
    mkdir -p "$(dirname "$dest")"
    strip "$dest" "$name"
    [ -s "$dest.new" ] && printf '\\n' >> "$dest.new"
    { echo "<!-- sandbox-console:begin $name -->"; cat "$tmp/context.md"; echo "<!-- sandbox-console:end $name -->"; } >> "$dest.new"
    mv -f "$dest.new" "$dest" ;;
esac
`;

// $1 kind, $2 name, $3 where.
const REMOVE = `set -e
${STRIP}
kind=$1 name=$2 dest=$3
case $kind in
  agent) rm -f "$dest/$name.md" ;;
  skill) rm -rf "$dest/$name" ;;
  context)
    [ -f "$dest" ] || exit 0
    strip "$dest" "$name"
    if [ -s "$dest.new" ]; then mv -f "$dest.new" "$dest"; else rm -f "$dest.new" "$dest"; fi ;;
esac
`;

// $1 the uploaded tar, $2 the tool's name.
const INSTALL_TOOL = `set -e
tar=$1
tmp=$(mktemp -d "${HOME}/.sandbox-console.XXXXXX")
trap 'rm -rf "$tmp" "$tar"' EXIT
tar -xf "$tar" -C "$tmp"
set -- "$tmp/$2" "$2"
${tools.INSTALL_TOOL}`;

// $1 agents dir, $2 skills dir, $3 context file, $4 tools dir. Prints "<kind> <name>" lines.
const PRESENT = `
for f in "$1"/*.md; do [ -f "$f" ] && n=\${f##*/} && echo "agent \${n%.md}"; done
for d in "$2"/*/; do [ -f "$d/SKILL.md" ] && d=\${d%/} && echo "skill \${d##*/}"; done
for d in "$4"/*/; do [ -f "$d/.commands" ] && d=\${d%/} && echo "tool \${d##*/}"; done
[ -f "$3" ] && sed -n 's/^<!-- sandbox-console:begin \\(.*\\) -->$/context \\1/p' "$3"
exit 0
`;

function failed(what: string, r: { code: number | null; stdout: string; stderr: string }) {
  return new CliError(what, (r.stderr || r.stdout).trim() || `exit code ${r.code}`);
}

/** Which agents, skills and context blocks are in the sandbox now, by "<kind>:<name>". */
export async function present(sandbox: string, layout: Layout): Promise<string[]> {
  const p = PLACES[layout];
  const r = await execScript(sandbox, PRESENT, [p.agent, p.skill, p.context, p.tool], 60_000);
  if (r.code !== 0) throw failed("Couldn't look in the sandbox", r);
  return r.stdout
    .split("\n")
    .map((l) => /^(agent|skill|context|tool) (\S+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m && ITEM_NAME.test(m[2]))
    .map((m) => `${m[1]}:${m[2]}`);
}

/** Copy an item in, replacing one of the same name. Returns what the console remembers about it. */
export async function install(sandbox: string, item: Entry, layout: Layout, log: string[]): Promise<InstalledItem> {
  if (item.problem) throw new CliError(item.problem, "");
  const dir = await mkdtemp(join(tmpdir(), "sandbox-console-catalog-"));
  try {
    if (item.kind === "tool") {
      await installTool(sandbox, item, dir, log);
      return { kind: item.kind, name: item.name, source: item.source, hash: item.hash, at: Date.now() };
    }
    const file = join(dir, `.sandbox-console-${randomBytes(6).toString("hex")}.tar`);
    await writeFile(file, tar(await payload(item, layout)));
    await upload(sandbox, file, `${HOME}/`);
    const dest = PLACES[layout][item.kind];
    const r = await execScript(sandbox, INSTALL, [`${HOME}/${file.slice(dir.length + 1)}`, item.kind, item.name, dest]);
    if (r.code !== 0) throw failed(`Couldn't put ${item.name} into the sandbox`, r);
    log.push(
      item.kind === "context"
        ? `Added ${item.name} to ${dest}.`
        : `Copied ${item.name} to ${dest}/${item.name}${item.kind === "agent" ? ".md" : "/"}${item.files > 1 ? ` (${item.files} files)` : ""}.`,
    );
    return { kind: item.kind, name: item.name, source: item.source, hash: item.hash, at: Date.now() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fetch a tool here for the sandbox's platform, then copy it in with its launchers. */
async function installTool(sandbox: string, item: Entry, dir: string, log: string[]) {
  const spec = JSON.parse(await readFile(item.path, "utf8")) as tools.ToolSpec;
  const platform = await tools.platform(sandbox);
  const work = join(dir, "fetch");
  await mkdir(work);
  const got = await tools.prepare(spec, platform, work);
  log.push(...got.log);
  const files = await Promise.all(got.files.map(async (f) => ({ rel: `${item.name}/${f.rel}`, data: await readFile(f.abs), exec: f.exec })));
  files.push({ rel: `${item.name}/.commands`, data: Buffer.from(`${got.commands.map((c) => c.name).join("\n")}\n`), exec: false });
  for (const c of got.commands) files.push({ rel: `${item.name}/.launchers/${c.name}`, data: Buffer.from(tools.launcher(item.name, c)), exec: true });
  const file = join(dir, `.sandbox-console-${randomBytes(6).toString("hex")}.tar`);
  await writeFile(file, tar(files));
  await upload(sandbox, file, `${HOME}/`);
  const r = await execScript(sandbox, INSTALL_TOOL, [`${HOME}/${file.slice(dir.length + 1)}`, item.name], 300_000);
  if (r.code !== 0) throw failed(`Couldn't put ${item.name} into the sandbox`, r);
  const names = got.commands.map((c) => c.name).join(", ");
  log.push(`Installed ${item.name} in ${tools.TOOLS_DIR}/${item.name}. Run it as ${names} (in ${tools.BIN_DIR}).`);
}

export async function remove(sandbox: string, kind: CatalogKind, name: string, layout: Layout, log: string[]) {
  if (kind === "tool") {
    const r = await execScript(sandbox, tools.REMOVE_TOOL, [name], 60_000);
    if (r.code !== 0) throw failed(`Couldn't remove ${name} from the sandbox`, r);
    log.push(`Removed ${name} and its commands.`);
    return;
  }
  const dest = PLACES[layout][kind];
  const r = await execScript(sandbox, REMOVE, [kind, name, dest], 60_000);
  if (r.code !== 0) throw failed(`Couldn't remove ${name} from the sandbox`, r);
  log.push(kind === "context" ? `Took ${name} out of ${dest}.` : `Removed ${dest}/${name}${kind === "agent" ? ".md" : "/"}.`);
}
