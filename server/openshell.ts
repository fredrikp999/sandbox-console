// Thin wrapper around the `openshell` CLI. Always spawned without a shell, with
// arguments as an array (DESIGN.md section 9).
import { spawn } from "node:child_process";
import type { NetworkHost } from "../shared/protocol.ts";
import { SANDBOX_NAME } from "./validate.ts";

export const OPENSHELL = process.env.OPENSHELL_BIN ?? "openshell";

export class CliError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A sandbox name that is safe as a positional argument (never read as a flag). */
export function sandboxArg(name: string): string {
  if (!SANDBOX_NAME.test(name)) throw new CliError(`Invalid sandbox name ${JSON.stringify(name)}`, "");
  return name;
}

/** Run `openshell <args>` and collect its output. Rejects only if it can't start or times out. */
export function run(args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSHELL, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new CliError(`openshell ${args.join(" ")} timed out after ${timeoutMs / 1000}s`, stderr, "Is the gateway running? Check `openshell status`."),
      );
    }, timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new CliError(
          e.code === "ENOENT" ? "`openshell` was not found in PATH" : `cannot start openshell: ${e.message}`,
          "",
          "Install OpenShell (see the openshell-configs README), or set OPENSHELL_BIN.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Like run(), but rejects with the CLI's own message when it exits non-zero. */
export async function runOk(args: string[], timeoutMs?: number): Promise<string> {
  const r = await run(args, timeoutMs);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim() || `exit code ${r.code}`;
    const gatewayTrouble = /connect|unavailable|gateway|transport|timed out|tls/i.test(msg);
    throw new CliError(`openshell ${args.slice(0, 2).join(" ")} failed`, msg, gatewayTrouble ? "Check `openshell status`." : undefined);
  }
  return r.stdout;
}

async function json<T>(args: string[]): Promise<T> {
  const out = await runOk([...args, "-o", "json"]);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new CliError(`openshell ${args.join(" ")} did not return JSON`, out.slice(0, 500));
  }
}

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface RawSandbox {
  id: string;
  name: string;
  phase: string;
  created_at: string;
  conditions?: Condition[];
  policy?: { network_policies?: Record<string, unknown> };
}

export async function listSandboxes(): Promise<RawSandbox[]> {
  const r = await json<{ sandboxes?: RawSandbox[] }>(["sandbox", "list"]);
  return r.sandboxes ?? [];
}

export function getSandbox(name: string): Promise<RawSandbox> {
  return json<RawSandbox>(["sandbox", "get", sandboxArg(name)]);
}

export function readyMessage(s: RawSandbox): string | undefined {
  const c = s.conditions?.find((c) => c.type === "Ready");
  return c && c.status !== "True" ? c.message || c.reason : undefined;
}

export interface Status {
  gateway?: string;
  status?: string;
  version?: string;
}

export function status(): Promise<Status> {
  return json<Status>(["status"]);
}

export interface CreateOptions {
  name: string;
  image: string;
  provider?: string;
  policy?: string;
}

/** Same call as sandbox.sh: the sandbox runs `sleep infinity` and is reused. */
export function createSandbox(o: CreateOptions): Promise<string> {
  const args = ["sandbox", "create", "--name", sandboxArg(o.name), "--from", o.image];
  if (o.provider) args.push("--provider", o.provider);
  if (o.policy) args.push("--policy", o.policy);
  args.push("--detach", "--", "sleep", "infinity");
  return runOk(args, 120_000);
}

export function deleteSandbox(name: string): Promise<string> {
  return runOk(["sandbox", "delete", sandboxArg(name)], 120_000);
}

/** Run a shell script in the sandbox, with arguments passed as $1, $2, ... (as bundle.sh does). */
export function execScript(sandbox: string, script: string, args: string[], timeoutMs = 120_000) {
  return run(["sandbox", "exec", sandboxArg(sandbox), "--no-tty", "--no-login-shell", "--", "sh", "-c", script, "sh", ...args], timeoutMs);
}

/** Upload one local file into a directory in the sandbox (give it with a trailing slash). */
export function upload(sandbox: string, localFile: string, remoteDir: string) {
  return runOk(["sandbox", "upload", sandboxArg(sandbox), localFile, remoteDir], 300_000);
}

export function download(sandbox: string, remotePath: string, localDir: string) {
  return runOk(["sandbox", "download", sandboxArg(sandbox), remotePath, localDir], 300_000);
}

// ---- network events from `openshell logs`

// [1791696029.196] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/local/bin/opencode(0) -> openrouter.ai:443 [policy:...]
// [1791697645.484] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/opencode(0) -> models.opencode.ai:443 [reason:...]
const NET_LINE = /^\[(\d+(?:\.\d+)?)\]\s.*\bNET:OPEN\s+\[[^\]]*\]\s+(ALLOWED|DENIED)\s+(\S+?)(?:\(\d+\))?\s+->\s+([^\s:]+):(\d+)/;

export function parseNetworkLog(text: string, sinceMs = 0): NetworkHost[] {
  const hosts = new Map<string, NetworkHost>();
  for (const line of text.split("\n")) {
    const m = NET_LINE.exec(line);
    if (!m) continue;
    if (Number(m[1]) * 1000 < sinceMs) continue;
    const [, , verdict, binary, host] = m;
    let h = hosts.get(host);
    if (!h) {
      h = { host, allowed: 0, denied: 0, binaries: [] };
      hosts.set(host, h);
    }
    if (verdict === "ALLOWED") h.allowed++;
    else h.denied++;
    if (!h.binaries.includes(binary)) h.binaries.push(binary);
  }
  return [...hosts.values()].sort((a, b) => b.denied - a.denied || b.allowed + b.denied - (a.allowed + a.denied));
}

export async function networkSince(sandbox: string, sinceMs: number): Promise<NetworkHost[]> {
  const secs = Math.max(1, Math.ceil((Date.now() - sinceMs) / 1000) + 5);
  const out = await runOk(["logs", sandboxArg(sandbox), "-n", "5000", "--since", `${secs}s`, "--source", "sandbox"]);
  return parseNetworkLog(out, sinceMs);
}
