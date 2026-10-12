import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNetworkLog } from "./openshell.ts";

const LOG = `[1791696023.977] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] host.containers.internal:17670
[1791696029.196] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] ALLOWED /usr/local/bin/opencode(0) -> openrouter.ai:443 [policy:_provider_openrouter engine:opa]
[1791696029.220] [sandbox] [OCSF ] [ocsf] HTTP:POST [INFO] ALLOWED POST http://openrouter.ai:443/api/v1/chat/completions [policy:_provider_openrouter engine:l7]
[1791697645.483] [sandbox] [OCSF ] [ocsf] NET:REFUSE [MED] DENIED models.opencode.ai [reason:policy_dns_ineligible]
[1791697645.484] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/opencode(0) -> models.opencode.ai:443 [reason:transparent_tcp_policy_denied]
[1791697645.714] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/local/bin/opencode(0) -> models.opencode.ai:443 [reason:transparent_tcp_policy_denied]
[1791697645.740] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(12) -> pypi.org:443 [reason:x]`;

test("counts allowed and denied connections per host, denied first", () => {
  const hosts = parseNetworkLog(LOG);
  assert.deepEqual(
    hosts.map((h) => [h.host, h.allowed, h.denied]),
    [
      ["models.opencode.ai", 0, 2],
      ["pypi.org", 0, 1],
      ["openrouter.ai", 1, 0],
    ],
  );
  assert.deepEqual(hosts.find((h) => h.host === "pypi.org")!.binaries, ["/usr/bin/curl"]);
});

test("ignores lines before the session started", () => {
  const hosts = parseNetworkLog(LOG, 1791697645_600);
  assert.deepEqual(
    hosts.map((h) => [h.host, h.denied]),
    [
      ["models.opencode.ai", 1],
      ["pypi.org", 1],
    ],
  );
});
