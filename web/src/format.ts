import type { ActivityState, AgentInfo, SandboxRow } from "../../shared/protocol.ts";

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function tokens(n: number | undefined): string {
  if (n === undefined || n === null) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function agentLabel(agents: AgentInfo[], id: string | null | undefined): string {
  return agents.find((a) => a.id === id)?.label ?? id ?? "Unknown agent";
}

export interface Status {
  pill: string;
  tone: "ok" | "warn" | "idle" | "bad" | "accent";
  meta: string;
  rank: number;
}

const SESSION: Record<ActivityState, Omit<Status, "meta">> = {
  waiting: { pill: "Waiting", tone: "warn", rank: 0 },
  working: { pill: "Working", tone: "ok", rank: 1 },
  starting: { pill: "Starting", tone: "accent", rank: 1 },
  idle: { pill: "Idle", tone: "idle", rank: 2 },
  dead: { pill: "Ready", tone: "idle", rank: 2 },
};

/** Pill, colour and meta line for a sandbox row (DESIGN.md section 5, Left). */
export function sandboxStatus(s: SandboxRow, agents: AgentInfo[], now = Date.now()): Status {
  if (s.phase !== "Ready") {
    return { pill: s.phase, tone: s.phase === "Error" ? "bad" : "accent", meta: s.message ?? s.phase, rank: 3 };
  }
  const sess = s.session;
  if (!sess) return { pill: "Ready", tone: "idle", meta: "No open session", rank: 2 };
  const base = SESSION[sess.state];
  const label = agentLabel(agents, sess.agent);
  const meta =
    sess.state === "waiting"
      ? "Needs approval"
      : sess.state === "starting"
        ? `Starting ${label}…`
        : sess.state === "dead"
          ? "Agent exited"
          : `${label} · ${ago(sess.lastActivity, now)}`;
  return { ...base, meta };
}

export function dotClass(tone: Status["tone"]) {
  return tone === "ok" ? "dot ok" : `dot ${tone === "accent" ? "idle" : tone}`;
}

export function shortId(id: string) {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-7)}` : id;
}

export function basename(p: string) {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** Path relative to the session directory, for the file list. */
export function relPath(path: string, cwd: string) {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}
