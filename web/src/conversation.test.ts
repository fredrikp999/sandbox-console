import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../../shared/protocol.ts";
import { fold, type PermissionItem, permissionSubject, type ToolItem } from "./conversation.ts";

let seq = 0;
const ev = (e: any): SessionEvent => ({ sessionId: "s", seq: ++seq, ts: 1000 * seq, ...e });
const up = (update: any) => ev({ type: "event", update });

test("streams chunks into one agent message and folds thoughts separately", () => {
  const c = fold([
    ev({ type: "user_message", text: "hi" }),
    up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
    up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } }),
    up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } }),
  ]);
  assert.deepEqual(c.items, [
    { kind: "user", text: "hi" },
    { kind: "thought", text: "hmm" },
    { kind: "agent", text: "Hello" },
  ]);
});

test("replaces the plan in place within a turn", () => {
  const c = fold([
    ev({ type: "turn_start" }),
    up({ sessionUpdate: "plan", entries: [{ content: "a", status: "in_progress", priority: "medium" }] }),
    up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }),
    up({ sessionUpdate: "plan", entries: [{ content: "a", status: "completed", priority: "medium" }] }),
  ]);
  assert.equal(c.items.filter((i) => i.kind === "plan").length, 1);
  assert.equal((c.items[0] as any).entries[0].status, "completed");
});

test("merges tool updates, keeps rawInput, tracks duration and diff line counts once", () => {
  const diff = { type: "diff", path: "/sandbox/a.py", oldText: "x\n", newText: "x\ny\nz\n" };
  const c = fold([
    up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "edit", kind: "edit", status: "pending", rawInput: {} }),
    up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", rawInput: { filePath: "/sandbox/a.py" }, content: [diff] }),
    up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [diff] }),
  ]);
  const t = c.items[0] as ToolItem;
  assert.equal(c.items.length, 1);
  assert.equal(t.status, "completed");
  assert.equal(t.rawInput?.filePath, "/sandbox/a.py");
  assert.equal(t.endedAt! - t.startedAt, 2000);
  assert.deepEqual([c.files["/sandbox/a.py"].added, c.files["/sandbox/a.py"].removed], [2, 0]);
});

test("edits without a diff still list the file", () => {
  const c = fold([
    up({ sessionUpdate: "tool_call", toolCallId: "w", title: "write", kind: "edit", status: "pending", locations: [] }),
    up({ sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed", locations: [{ path: "/sandbox/p.txt" }] }),
  ]);
  assert.equal(c.files["/sandbox/p.txt"].counted, false);
});

test("permission card describes the command and resolves to a grey line", () => {
  const c = fold([
    up({ sessionUpdate: "tool_call", toolCallId: "b", title: "bash", kind: "execute", status: "pending", rawInput: { command: "pytest -q" } }),
    ev({
      type: "permission_request",
      requestId: "1",
      toolCall: { toolCallId: "b" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
      ],
    }),
    ev({ type: "permission_resolved", requestId: "1", optionId: "always", label: "Always allow" }),
  ]);
  const p = c.items[1] as PermissionItem;
  assert.deepEqual(permissionSubject(p, c), { question: "The agent wants to run a command", text: "pytest -q" });
  assert.deepEqual(p.resolved, { optionId: "always", label: "Always allow" });
  assert.deepEqual(c.always, ["pytest -q"]);
});

test("reports non-normal stop reasons only", () => {
  const c = fold([
    ev({ type: "turn_start" }),
    ev({ type: "turn_end", stopReason: "end_turn" }),
    ev({ type: "turn_start" }),
    ev({ type: "turn_end", stopReason: "cancelled" }),
  ]);
  assert.deepEqual(
    c.items.map((i) => i.kind),
    ["turn_end"],
  );
});
