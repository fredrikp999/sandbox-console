import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMessage, SANDBOX_NAME } from "./validate.ts";

test("accepts well-formed messages and drops unknown fields", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "prompt", sessionId: "s", text: "hi", extra: 1 })), {
    type: "prompt",
    sessionId: "s",
    text: "hi",
  });
  assert.deepEqual(
    parseClientMessage(JSON.stringify({ type: "permission_answer", sessionId: "s", requestId: "1", optionId: null })).type,
    "permission_answer",
  );
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

test("images in a prompt: a few, known types, base64, and nothing else rides along", () => {
  const img = { mimeType: "image/png", data: "iVBORw0KGgo=", thumb: "/9j/4AAQ", note: "dropped" };
  const ok = parseClientMessage(JSON.stringify({ type: "prompt", sessionId: "s", text: "", images: [img] })) as { images: object[] };
  assert.deepEqual(ok.images, [{ mimeType: "image/png", data: "iVBORw0KGgo=", thumb: "/9j/4AAQ" }]);
  const bad = (images: unknown) =>
    assert.throws(() => parseClientMessage(JSON.stringify({ type: "prompt", sessionId: "s", text: "x", images })), /prompt\.images/);
  bad("not a list");
  bad([{ ...img, mimeType: "image/svg+xml" }]);
  bad([{ ...img, mimeType: "text/html" }]);
  bad([{ ...img, data: "not base64!" }]);
  bad([{ ...img, data: "" }]);
  bad([{ ...img, thumb: "x".repeat(130_000) }]);
  bad(Array(5).fill(img));
  bad([null]);
  // None is fine, and an empty list is no images.
  assert.equal("images" in parseClientMessage(JSON.stringify({ type: "prompt", sessionId: "s", text: "x", images: [] })), false);
});
