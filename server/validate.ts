// Shape checks for browser -> bridge messages. The browser is authenticated,
// but nothing it sends goes to the CLI or an agent without being checked here.
import type { ClientMessage } from "../shared/protocol.ts";

type Field = "s" | "s?" | "n" | "s|null" | "images?";

const SPEC: Record<ClientMessage["type"], Record<string, Field>> = {
  list_sandboxes: {},
  create_sandbox: { reqId: "s", name: "s", agent: "s?", sandboxType: "s?", workdir: "s" },
  sandbox_types: { reqId: "s" },
  files: { reqId: "s", sandbox: "s", path: "s" },
  rules: { reqId: "s", sandbox: "s", op: "s?", chunkId: "s?" },
  ports: { reqId: "s", sandbox: "s" },
  forward: { reqId: "s", sandbox: "s", op: "s", port: "n" },
  build_image: { reqId: "s", sandboxType: "s" },
  delete_sandbox: { reqId: "s", name: "s" },
  set_sandbox_agent: { name: "s", agent: "s" },
  open_session: { reqId: "s", sandbox: "s", agent: "s", cwd: "s", model: "s?", loadSessionId: "s?" },
  new_thread: { reqId: "s", sandbox: "s" },
  close_session: { sessionId: "s" },
  delete_thread: { reqId: "s", sessionId: "s" },
  delete_threads: { reqId: "s", sandbox: "s" },
  list_past_sessions: { reqId: "s", sessionId: "s" },
  prompt: { sessionId: "s", text: "s", images: "images?" },
  cancel: { sessionId: "s" },
  set_option: { reqId: "s", sessionId: "s", configId: "s", value: "s" },
  permission_answer: { sessionId: "s", requestId: "s", optionId: "s|null" },
  subscribe: { sessionId: "s", sinceSeq: "n" },
  network: { reqId: "s", sessionId: "s" },
  open_editor: { reqId: "s", sandbox: "s", editor: "s", folder: "s" },
  editor_setting: { reqId: "s", editor: "s" },
  repo: { reqId: "s", sandbox: "s", op: "s", repo: "s?", source: "s?", base: "s?", dest: "s?" },
  catalog: { reqId: "s", op: "s", sandbox: "s?", kind: "s?", name: "s?" },
};

const MAX_STRING = 200_000; // prompts can be long; everything else is short
/** Images in a prompt: a few, each scaled down by the page. */
export const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 6_000_000;
const MAX_THUMB_BASE64 = 120_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function imagesOk(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (!Array.isArray(v) || v.length > MAX_IMAGES) return false;
  return v.every((i) => {
    const o = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
    return (
      typeof o.mimeType === "string" &&
      IMAGE_TYPES.has(o.mimeType) &&
      typeof o.data === "string" &&
      o.data.length > 0 &&
      o.data.length <= MAX_IMAGE_BASE64 &&
      BASE64.test(o.data) &&
      typeof o.thumb === "string" &&
      o.thumb.length <= MAX_THUMB_BASE64 &&
      BASE64.test(o.thumb)
    );
  });
}

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
    case "images?":
      return imagesOk(v);
  }
}

/** Returns the message if it has the right shape, otherwise throws. Unknown fields are dropped. */
export function parseClientMessage(raw: string): ClientMessage {
  // Untrusted input: read as a plain record and check each field below.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Bad message from the browser: not JSON");
  }
  const m = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const type = typeof m.type === "string" && Object.hasOwn(SPEC, m.type) ? (m.type as ClientMessage["type"]) : null;
  if (!type) throw new Error(`Bad message from the browser: unknown type ${String(m.type)}`);
  const out: Record<string, unknown> = { type };
  for (const [k, f] of Object.entries(SPEC[type])) {
    if (!ok(m[k], f)) {
      throw Object.assign(new Error(`Bad message from the browser: ${type}.${k}`), { reqId: typeof m.reqId === "string" ? m.reqId : undefined });
    }
    if (f === "images?") {
      // Rebuilt from the known fields, so nothing else rides along.
      if (Array.isArray(m[k]) && (m[k] as unknown[]).length) {
        out[k] = (m[k] as { mimeType: string; data: string; thumb: string }[]).map(({ mimeType, data, thumb }) => ({ mimeType, data, thumb }));
      }
    } else if (m[k] !== undefined && m[k] !== null) out[k] = m[k];
    else if (f === "s|null") out[k] = null;
  }
  return out as ClientMessage;
}

/** Sandbox names as OpenShell and sandbox.sh make them. Never starts with "-", so it can't be read as a flag. */
export const SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Names the console itself creates. */
export const NEW_SANDBOX_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
