import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRules } from "./rules.ts";

const SAMPLE = `Network Rules:  (version 3, 3 chunks)

  Chunk: 329ecc4c-c76f-418d-bd5b-c5915a12665a
  Status: pending
  Rule: allow_mobile_events_data_microsoft_com_443
  Binary: /sandbox/.vscode-server/server/node
  Confidence: 75%
  Rationale: Allow node to connect to mobile.events.data.microsoft.com:443 (HTTPS).
  Prover: prover: no new findings
  Candidate: 387cd66eb497
  Endpoints: mobile.events.data.microsoft.com:443 [L4]
  Binaries: /sandbox/.vscode-server/server/node
  Hits: 10 (first seen 2026-10-13 05:49:45, last seen 2026-10-13 05:52:19)

  Chunk: 36b80081-1111-2222-3333-444455556666
  Status: pending
  Rule: allow_github_com_443
  Binary: /usr/lib/git-core/git-remote-http
  Confidence: 65%
  Rationale: Allow git-remote-http to connect to github.com:443 (HTTPS).
  Endpoints: github.com:443 [L4], codeload.github.com:443
  Binaries: /usr/lib/git-core/git-remote-http

  Chunk: not-an-id; rm -rf
  Status: pending
`;

test("rule proposals are parsed from `openshell rule get`", () => {
  const [node, git, ...rest] = parseRules(SAMPLE);
  assert.equal(rest.length, 0, "a chunk without a valid id is dropped");
  assert.equal(node.id, "329ecc4c-c76f-418d-bd5b-c5915a12665a");
  assert.deepEqual(node.endpoints, [{ host: "mobile.events.data.microsoft.com", port: 443, mode: "L4" }]);
  assert.equal(node.confidence, 75);
  assert.equal(node.hits, 10);
  assert.equal(node.firstSeen, "2026-10-13 05:49:45");
  assert.equal(node.shared, true);
  assert.equal(git.hits, undefined);
  assert.equal(git.shared, false);
  assert.deepEqual(
    git.endpoints.map((e) => `${e.host}:${e.port}`),
    ["github.com:443", "codeload.github.com:443"],
  );
  assert.deepEqual(parseRules("No pending rules.\n"), []);
});
