// Port forwards from this machine into a sandbox (`openshell forward`), so you can
// open something the agent serves there, like the HyperFrames Studio, in your
// browser. The port number is the same on both sides, and only 127.0.0.1 is bound
// here. Presets are in server/ports.json; the ports actually listening in the
// sandbox are read from /proc, with the program behind each.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListeningPort, PortForward, PortPreset } from "../shared/protocol.ts";
import { ROOT } from "./config.ts";
import { CliError, execScript, OPENSHELL, run, runOk, sandboxArg } from "./openshell.ts";

interface PresetConfig extends PortPreset {
  /** Only for these sandbox types, unless a listening program matches. */
  types?: string[];
  /** Text in the command line of a program that serves this. */
  match?: string;
}

export function loadPresets(): PresetConfig[] {
  const file = process.env.CONSOLE_PORTS ?? join(ROOT, "server", "ports.json");
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as PresetConfig[]).filter((p) => validPort(p.port));
  } catch (e) {
    console.warn(`warning: cannot read ${file}: ${(e as Error).message}`);
    return [];
  }
}

/** Ports below 1024 need root to bind here, and 0 isn't a port. */
export const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535;

/** The presets that apply to a sandbox of `type` with these programs listening. */
export function presetsFor(all: PresetConfig[], type: string | undefined, listening: ListeningPort[]): PortPreset[] {
  return all
    .filter((p) => !p.types || (type && p.types.includes(type)) || listening.some((l) => p.match && l.command?.includes(p.match)))
    .map(({ port, label, hint }) => ({ port, label, hint }));
}

// ---- what's forwarded

interface RawForward {
  alive?: boolean;
  bind_address?: string;
  pid?: number;
  port?: number;
  sandbox?: string;
}

export async function list(): Promise<PortForward[]> {
  const out = await runOk(["forward", "list", "-o", "json"]);
  let raw: RawForward[];
  try {
    raw = JSON.parse(out || "[]");
  } catch {
    // An older CLI without JSON output, or a message instead of a list.
    return [];
  }
  return raw
    .filter((f) => validPort(f.port) && typeof f.sandbox === "string")
    .map((f) => ({ sandbox: f.sandbox as string, port: f.port as number, bind: f.bind_address ?? "127.0.0.1", alive: f.alive !== false }));
}

// ---- what's listening in the sandbox

// Listening TCP sockets (state 0A), then the command line of every process. The
// sandbox doesn't let one process read another's file descriptors, so a port
// can't be traced to its socket's owner; instead a program is matched to a port
// by the port in its command line (--port 3102, :8080), or by a preset (the
// HyperFrames Studio on 3002).
const LISTENING = `
for f in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$f" ] && awk 'NR > 1 && $4 == "0A" { n = split($2, a, ":"); print "L", a[n] }' "$f"
done
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] && c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null) && [ -n "$c" ] && printf 'C %s\\n' "$c"
done 2>/dev/null
exit 0
`;

/** Shorten a command line to what tells you what it is: drop interpreters and paths. */
export function describeCommand(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  const base = (w: string) => w.split("/").pop() ?? w;
  let i = 0;
  while (i < words.length - 1 && /^(node|python3?|bun|deno|sh|bash|npx|npm|exec)$/.test(base(words[i]))) i++;
  if (words[i] === "-m" && i < words.length - 1) i++; // python -m <module>
  return [base(words[i]), ...words.slice(i + 1)].join(" ").slice(0, 120);
}

/** Which program serves `port`, judging by command lines. */
export function programFor(port: number, commands: string[], presets: PresetConfig[]): string | undefined {
  const explicit = new RegExp(`(?:--port[= ]|-p |:)${port}(?!\\d)`);
  const hit = commands.find((c) => explicit.test(c));
  if (hit) return describeCommand(hit);
  for (const p of presets) {
    if (p.port !== port || !p.match) continue;
    const m = commands.find((c) => c.includes(p.match as string) && !/(?:--port[= ]|-p )\d/.test(c));
    if (m) return describeCommand(m);
  }
  return undefined;
}

export async function listening(sandbox: string, presets: PresetConfig[]): Promise<ListeningPort[]> {
  const r = await execScript(sandbox, LISTENING, [], 30_000);
  if (r.code !== 0) throw new CliError("Couldn't see which ports are open in the sandbox", (r.stderr || r.stdout).trim());
  const found = new Set<number>();
  const commands: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("L ")) {
      const port = Number.parseInt(line.slice(2).trim(), 16);
      if (validPort(port)) found.add(port);
    } else if (line.startsWith("C ")) commands.push(line.slice(2).trim());
  }
  return [...found].sort((a, b) => a - b).map((port) => ({ port, command: programFor(port, commands, presets) }));
}

// ---- starting and stopping

/** Who has `port` on this machine, if anyone (so a clash can be explained). */
async function hostUser(port: number): Promise<string | null> {
  const free = await new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
  if (free) return null;
  const who = await new Promise<string>((resolve) => {
    const child = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.on("error", () => resolve(""));
    child.on("close", () => {
      const pid = /^p(\d+)/m.exec(out)?.[1];
      const name = /^c(.+)$/m.exec(out)?.[1];
      resolve(pid ? `${name ?? "a program"} (pid ${pid})` : "");
    });
  });
  return who || "another program";
}

export async function start(sandbox: string, port: number, log: string[]) {
  if (!validPort(port)) throw new CliError("Choose a port from 1024 to 65535.", "");
  const taken = await hostUser(port);
  if (taken) {
    throw new CliError(
      `Port ${port} is already in use on this machine, by ${taken}.`,
      "",
      "Stop that program, or serve on another port in the sandbox and forward that one.",
    );
  }
  await startInBackground(["forward", "start", String(port), sandboxArg(sandbox), "-d"]);
  log.push(`Forwarding http://127.0.0.1:${port}/ to port ${port} in ${sandbox}.`);
}

/**
 * `forward start -d` leaves a process running that keeps the command's stdout and
 * stderr open, so waiting for them to close would wait as long as the forward
 * runs (sandbox.sh sends them to /dev/null for the same reason). Its output goes
 * to a file instead, and the command is done when it exits.
 */
function startInBackground(args: string[], timeoutMs = 30_000): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-console-forward-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  const output = () => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSHELL, args, { stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CliError(`openshell ${args.slice(0, 2).join(" ")} timed out`, output(), "Is the gateway running? Check `openshell status`."));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      output();
      reject(new CliError(`cannot start openshell: ${e.message}`, ""));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const out = output();
      if (code === 0) resolve();
      else reject(new CliError(`openshell ${args.slice(0, 2).join(" ")} failed`, out || `exit code ${code}`));
    });
  });
}

export async function stop(sandbox: string, port: number, log: string[]) {
  if (!validPort(port)) throw new CliError("Not a port.", "");
  const r = await run(["forward", "stop", String(port), sandboxArg(sandbox)], 30_000);
  if (r.code !== 0) throw new CliError(`Couldn't stop forwarding port ${port}`, (r.stderr || r.stdout).trim());
  log.push(`Stopped forwarding port ${port}.`);
}
