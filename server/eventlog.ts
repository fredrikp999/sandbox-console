// Keeping a session's event log bounded without breaking replay.
import type { SessionEvent } from "../shared/protocol.ts";

const TEXT_CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

function textChunk(e: SessionEvent): string | null {
  if (e.type !== "event") return null;
  const u: any = e.update;
  return TEXT_CHUNKS.has(u?.sessionUpdate) && u.content?.type === "text" ? u.sessionUpdate : null;
}

/**
 * Merge each run of consecutive streamed text chunks of the same kind into one
 * event, which keeps the seq and time of the run's last chunk. A tab replaying
 * from before the run gets the same text as before, in one piece. (A tab that
 * resumes from the middle of a merged run gets the run's start again; that only
 * happens to a tab that was away while the log hit its limit.)
 */
export function compact(log: SessionEvent[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const e of log) {
    const kind = textChunk(e);
    const prev = out[out.length - 1];
    if (kind && prev && textChunk(prev) === kind) {
      const p = prev as Extract<SessionEvent, { type: "event" }>;
      const u: any = (e as Extract<SessionEvent, { type: "event" }>).update;
      const text = (p.update as any).content.text + u.content.text;
      out[out.length - 1] = { ...e, update: { ...u, content: { ...u.content, text } } } as SessionEvent;
    } else out.push(e);
  }
  return out;
}

/** Apply the limit: compact first; only if that isn't enough, drop the oldest events. */
export function bound(log: SessionEvent[], max: number): SessionEvent[] {
  if (log.length <= max) return log;
  let next = compact(log);
  // Leave headroom so this doesn't run again on the very next event.
  const target = Math.floor(max * 0.8);
  if (next.length > target) next = next.slice(next.length - target);
  return next;
}
