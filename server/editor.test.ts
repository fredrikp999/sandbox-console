import assert from "node:assert/strict";
import { test } from "node:test";
import { openEditor, withServerSetting } from "./editor.ts";

test("the server setting goes in once, after the first brace, comments and all", () => {
  const text = '// mine\n{\n  "editor.fontSize": 14\n}\n';
  const out = withServerSetting(text) ?? "";
  assert.equal(out, '// mine\n{\n  "remote.SSH.localServerDownload": "always",\n  "editor.fontSize": 14\n}\n');
  assert.equal(withServerSetting(out), out);
  assert.equal(withServerSetting(""), '{\n  "remote.SSH.localServerDownload": "always",\n}\n');
  assert.equal(withServerSetting("not json"), null);
});

test("folders that could leave the path in the URI are refused before anything runs", async () => {
  for (const f of ["sandbox", "/sandbox/../etc", "/a b", "/x?y", "/x#y", "/x%2f"]) {
    await assert.rejects(openEditor("vscode", "demo", f), /Can't open/);
  }
});
