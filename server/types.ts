// Sandbox types (server/sandbox-types.json): an openshell-configs image with
// everything installed when it was built, and the policy that goes with it. This
// is where system packages, browsers and the like belong. The sandbox user isn't
// root and can't install them, and opening a package registry to the sandbox
// would open it to the agent too.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, ImageBuild, SandboxType } from "../shared/protocol.ts";
import { ROOT } from "./config.ts";

/** The container engine openshell-configs builds with (its Makefile reads ENGINE too). */
export const ENGINE = process.env.ENGINE ?? "podman";
const KEEP_LINES = 400;

export interface TypeConfig {
  id: string;
  label: string;
  description: string;
  agent: AgentId;
  image: string;
  policy?: string;
  build?: string;
}

export function loadTypes(): TypeConfig[] {
  const file = process.env.CONSOLE_TYPES ?? join(ROOT, "server", "sandbox-types.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Omit<TypeConfig, "id">>;
    return Object.entries(raw).map(([id, t]) => ({ id, ...t, label: t.label ?? id, description: t.description ?? "" }));
  } catch (e) {
    console.warn(`warning: cannot read ${file}: ${(e as Error).message}`);
    return [];
  }
}

/** The policy file for a type, if openshell-configs has it. */
export function policyPath(t: TypeConfig, configs: string | undefined): string | undefined {
  if (!t.policy || !configs) return undefined;
  const p = join(configs, "policies", t.policy);
  return existsSync(p) ? p : undefined;
}

function exitCode(cmd: string, args: string[], timeoutMs = 20_000): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** `image inspect` works the same in Podman and Docker: 0 if the image is there. */
export async function imageState(image: string): Promise<SandboxType["imageState"]> {
  if (image.startsWith("-")) return "unknown";
  const code = await exitCode(ENGINE, ["image", "inspect", "--format", "{{.Id}}", image]);
  return code === 0 ? "present" : code === null ? "unknown" : "missing";
}

export async function describe(types: TypeConfig[], configs: string | undefined): Promise<SandboxType[]> {
  return Promise.all(
    types.map(async (t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      agent: t.agent,
      image: t.image,
      policy: policyPath(t, configs) ? (t.policy ?? null) : null,
      build: t.build,
      imageState: await imageState(t.image),
    })),
  );
}

/** Make targets are names from our own registry, but check anyway: they become an argument. */
const TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Build an image with openshell-configs' Makefile. Runs on this machine with
 * network access, like you running `make <target>` there. Output goes to
 * `onUpdate`, a few times a second at most.
 */
export function build(t: TypeConfig, configs: string, onUpdate: (b: ImageBuild) => void): ImageBuild {
  if (!t.build || !TARGET.test(t.build)) throw new Error(`${t.label} has no make target to build its image.`);
  const b: ImageBuild = {
    sandboxType: t.id,
    target: t.build,
    state: "running",
    lines: [`$ make ${t.build}   (in ${configs})`],
    startedAt: Date.now(),
  };
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    onUpdate({ ...b, lines: [...b.lines] });
  };
  const soon = () => {
    timer ??= setTimeout(flush, 300);
  };
  let partial = "";
  const add = (chunk: string) => {
    const parts = (partial + chunk).split(/\r?\n|\r/);
    partial = parts.pop() ?? "";
    b.lines.push(...parts.filter((l) => l.trim()));
    if (b.lines.length > KEEP_LINES) b.lines.splice(1, b.lines.length - KEEP_LINES);
    soon();
  };
  const child = spawn("make", [t.build], { cwd: configs, env: { ...process.env, ENGINE }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8").on("data", add);
  child.stderr.setEncoding("utf8").on("data", add);
  const done = (ok: boolean, line: string) => {
    if (b.state !== "running") return;
    if (partial.trim()) b.lines.push(partial);
    b.lines.push(line);
    b.state = ok ? "done" : "failed";
    if (timer) clearTimeout(timer);
    flush();
  };
  child.on("error", (e: NodeJS.ErrnoException) =>
    done(false, e.code === "ENOENT" ? "make was not found in PATH." : `Cannot start make: ${e.message}`),
  );
  child.on("close", (code) => done(code === 0, code === 0 ? `Built ${t.image}.` : `make exited with code ${code}.`));
  return b;
}
