import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMessage, SANDBOX_NAME } from "./validate.ts";

test("accepts well-formed messages and drops unknown fields", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "prompt", sessionId: "s", text: "hi", extra: 1 })), { type: "prompt", sessionId: "s", text: "hi" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "permission_answer", sessionId: "s", requestId: "1", optionId: null })).type, "permission_answer");
});

test("rejects wrong types, missing fields and unknown message types", () => {
  assert.throws(() => parseClientMessage("nope"), /not JSON/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "constructor" })), /unknown type/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "prompt", sessionId: "s" })), /prompt\.text/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "subscribe", sessionId: "s", sinceSeq: "0" })), /sinceSeq/);
});

test("sandbox names can't be read as flags", () => {
  for (const bad of ["--all", "-g", "", "a b", "x".repeat(64)]) assert.equal(SANDBOX_NAME.test(bad), false, bad);
  for (const good of ["c1", "c2-acp", "opencode-agent1", "My.box_2"]) assert.equal(SANDBOX_NAME.test(good), true, good);
});
