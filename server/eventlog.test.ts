import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../shared/protocol.ts";
import { bound, compact } from "./eventlog.ts";

let seq = 0;
const chunk = (kind: string, text: string) =>
  ({ type: "event", sessionId: "s", seq: ++seq, ts: seq, update: { sessionUpdate: kind, content: { type: "text", text } } }) as SessionEvent;
const other = () => ({ type: "turn_start", sessionId: "s", seq: ++seq, ts: seq }) as SessionEvent;

test("compact merges runs of the same chunk kind and keeps the last seq", () => {
  const log = [chunk("agent_thought_chunk", "a"), chunk("agent_message_chunk", "Hel"), chunk("agent_message_chunk", "lo"), other(), chunk("agent_message_chunk", "!")];
  const out = compact(log);
  assert.deepEqual(out.map((e) => (e.type === "event" ? (e.update as any).content.text : e.type)), ["a", "Hello", "turn_start", "!"]);
  assert.equal(out[1].seq, log[2].seq);
});

test("bound compacts before it drops anything", () => {
  const log = Array.from({ length: 50 }, (_, i) => chunk("agent_message_chunk", String(i % 10)));
  const out = bound([other(), ...log], 40);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, "turn_start");
  assert.equal((out[1] as any).update.content.text.length, 50);
});

test("bound drops the oldest events when compaction isn't enough", () => {
  const log = Array.from({ length: 50 }, () => other());
  const out = bound(log, 40);
  assert.equal(out.length, 32);
  assert.equal(out.at(-1)!.seq, log.at(-1)!.seq);
});
