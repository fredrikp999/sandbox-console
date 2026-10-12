// Shape checks for browser -> bridge messages. The browser is authenticated,
// but nothing it sends goes to the CLI or an agent without being checked here.
import type { ClientMessage } from "../shared/protocol.ts";

type Field = "s" | "s?" | "n" | "s|null";

const SPEC: Record<ClientMessage["type"], Record<string, Field>> = {
  list_sandboxes: {},
  create_sandbox: { reqId: "s", name: "s", agent: "s", workdir: "s" },
  delete_sandbox: { reqId: "s", name: "s" },
  set_sandbox_agent: { name: "s", agent: "s" },
  open_session: { reqId: "s", sandbox: "s", agent: "s", cwd: "s", model: "s?", loadSessionId: "s?" },
  new_session: { reqId: "s", sessionId: "s" },
  close_session: { sessionId: "s" },
  list_past_sessions: { reqId: "s", sessionId: "s" },
  prompt: { sessionId: "s", text: "s" },
  cancel: { sessionId: "s" },
  set_option: { reqId: "s", sessionId: "s", configId: "s", value: "s" },
  permission_answer: { sessionId: "s", requestId: "s", optionId: "s|null" },
  subscribe: { sessionId: "s", sinceSeq: "n" },
  network: { reqId: "s", sessionId: "s" },
};

const MAX_STRING = 200_000; // prompts can be long; everything else is short

function ok(v: unknown, f: Field): boolean {
  switch (f) {
    case "s":
      return typeof v === "string" && v.length <= MAX_STRING;
    case "s?":
      return v === undefined || v === null || (typeof v === "string" && v.length <= MAX_STRING);
    case "s|null":
      return v === null || (typeof v === "string" && v.length <= MAX_STRING);
    case "n":
      return typeof v === "number" && Number.isFinite(v);
  }
}

/** Returns the message if it has the right shape, otherwise throws. Unknown fields are dropped. */
export function parseClientMessage(raw: string): ClientMessage {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error("Bad message from the browser: not JSON");
  }
  const spec = m && typeof m === "object" && typeof m.type === "string" ? SPEC[m.type as ClientMessage["type"]] : undefined;
  if (!spec || !Object.hasOwn(SPEC, m.type)) throw new Error(`Bad message from the browser: unknown type ${String(m?.type)}`);
  const out: Record<string, unknown> = { type: m.type };
  for (const [k, f] of Object.entries(spec)) {
    if (!ok(m[k], f)) throw Object.assign(new Error(`Bad message from the browser: ${m.type}.${k}`), { reqId: typeof m.reqId === "string" ? m.reqId : undefined });
    if (m[k] !== undefined && m[k] !== null) out[k] = m[k];
    else if (f === "s|null") out[k] = null;
  }
  return out as ClientMessage;
}

/** Sandbox names as OpenShell and sandbox.sh make them. Never starts with "-", so it can't be read as a flag. */
export const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Names the console itself creates. */
export const NEW_SANDBOX_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
