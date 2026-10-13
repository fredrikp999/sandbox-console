// Network rules OpenShell proposes when something in the sandbox is denied
// (`openshell rule get --status pending`). The console lists them next to what was
// blocked and lets you approve or reject each one. Nothing is approved by itself:
// an approval widens the sandbox, so it's always your click on one chunk.
import type { RuleProposal } from "../shared/protocol.ts";
import { CliError, run, runOk, sandboxArg } from "./openshell.ts";

/** Chunk ids are UUIDs; they become an argument, so check them. */
export const CHUNK_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;

/** Programs that many things run as, so allowing one lets the agent use the access too. */
const SHARED_BINARIES = new Set([
  "node",
  "python",
  "python3",
  "sh",
  "bash",
  "dash",
  "curl",
  "wget",
  "git",
  "npm",
  "npx",
  "ruby",
  "perl",
  "deno",
  "bun",
]);

/** Parse `openshell rule get` output into proposals. Unknown lines are ignored. */
export function parseRules(text: string): RuleProposal[] {
  const out: RuleProposal[] = [];
  for (const block of text.split(/\n(?=\s*Chunk:)/)) {
    const field = (name: string) => new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, "m").exec(block)?.[1].trim();
    const id = field("Chunk");
    if (!id || !CHUNK_ID.test(id)) continue;
    const endpoints = (field("Endpoints") ?? "")
      .split(/,\s*/)
      .map((e) => /^([^\s:]+):(\d+)(?:\s*\[([^\]]*)\])?/.exec(e.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ host: m[1], port: Number(m[2]), mode: m[3] || undefined }));
    const binaries = (field("Binaries") ?? field("Binary") ?? "").split(/,\s*/).filter(Boolean);
    const hits = /^(\d+)(?:\s*\(first seen ([^,]+), last seen ([^)]+)\))?/.exec(field("Hits") ?? "");
    out.push({
      id,
      status: field("Status") ?? "pending",
      rule: field("Rule") ?? "",
      endpoints,
      binaries,
      confidence: Number.parseInt(field("Confidence") ?? "", 10) || undefined,
      rationale: field("Rationale") ?? "",
      hits: hits ? Number(hits[1]) : undefined,
      firstSeen: hits?.[2],
      lastSeen: hits?.[3],
      shared: binaries.some((b) => SHARED_BINARIES.has(b.split("/").pop() ?? b)),
    });
  }
  return out;
}

export async function pending(sandbox: string): Promise<RuleProposal[]> {
  const r = await run(["rule", "get", sandboxArg(sandbox), "--status", "pending"], 30_000);
  if (r.code !== 0) throw new CliError("Couldn't read the proposed rules", (r.stderr || r.stdout).trim());
  return parseRules(r.stdout).filter((p) => p.status === "pending");
}

export async function approve(sandbox: string, chunkId: string, log: string[]) {
  if (!CHUNK_ID.test(chunkId)) throw new CliError("Not a rule id.", chunkId);
  await runOk(["rule", "approve", sandboxArg(sandbox), "--chunk-id", chunkId], 60_000);
  log.push("Allowed. The sandbox's policy now includes it.");
}

export async function reject(sandbox: string, chunkId: string, log: string[]) {
  if (!CHUNK_ID.test(chunkId)) throw new CliError("Not a rule id.", chunkId);
  await runOk(["rule", "reject", sandboxArg(sandbox), "--chunk-id", chunkId, "--reason", "Rejected in the console"], 60_000);
  log.push("Rejected. It will be proposed again if something tries that connection again.");
}
