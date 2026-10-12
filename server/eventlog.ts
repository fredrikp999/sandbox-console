// Keeping a session's event log bounded without breaking replay.
import type { SessionEvent } from "../shared/protocol.ts";

const TEXT_CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

type EventEntry = Extract<SessionEvent, { type: "event" }>;
interface TextChunk {
  sessionUpdate: string;
  content: { type: "text"; text: string };
}

/** The update, if this entry is a streamed text chunk. */
function textChunk(e: SessionEvent): TextChunk | null {
  if (e.type !== "event") return null;
  const u = e.update as Partial<TextChunk>;
  return u.sessionUpdate && TEXT_CHUNKS.has(u.sessionUpdate) && u.content?.type === "text" ? (u as TextChunk) : null;
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
    const chunk = textChunk(e);
    const prev = out.length ? textChunk(out[out.length - 1]) : null;
    if (chunk && prev && prev.sessionUpdate === chunk.sessionUpdate) {
      const merged = { ...chunk, content: { ...chunk.content, text: prev.content.text + chunk.content.text } };
      out[out.length - 1] = { ...(e as EventEntry), update: merged as EventEntry["update"] };
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
