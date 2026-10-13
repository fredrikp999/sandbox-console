// Sandbox Console bridge: serves the UI on 127.0.0.1 and relays ACP between
// browser tabs (WebSocket) and agents in OpenShell sandboxes (stdio).
//
//   npx tsx server/index.ts [--port N] [--open] [--dev]
//
// Access control (DESIGN.md section 8): a random token per start, printed as
// http://127.0.0.1:<port>/#token=…. The page keeps it in localStorage, which is
// scoped to this exact origin (port included); cookies are not, so the bridge
// uses none. The token travels as a WebSocket subprotocol and as a Bearer
// header on /api/*. The static UI itself holds no secrets and is public.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer } from "ws";
import { Bridge } from "./bridge.ts";
import { type Bundle, makeBundle } from "./bundle.ts";
import { ROOT } from "./config.ts";
import * as files from "./files.ts";
import type { CliError } from "./openshell.ts";
import type { Thread } from "./session.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const HOST = "127.0.0.1";
const PORT = Number(opt("--port") ?? process.env.CONSOLE_PORT ?? 7801);
const DEV = flag("--dev");
const DEV_PORT = 5173;
const WEB = join(ROOT, "dist", "web");
const TOKEN = process.env.CONSOLE_TOKEN || randomBytes(24).toString("base64url");
if (!/^[A-Za-z0-9_-]{8,}$/.test(TOKEN)) {
  console.error("CONSOLE_TOKEN must be at least 8 characters of A-Z, a-z, 0-9, _ or -.");
  process.exit(1);
}
/** WebSocket subprotocols: the fixed one we answer with, and the one carrying the token. */
const WS_PROTOCOL = "sandbox-console";
const WS_TOKEN_PREFIX = "token.";

// Requests must name this server in Host (blocks DNS rebinding) and, for the
// WebSocket, come from its own pages (Origin).
const ports = DEV ? [PORT, DEV_PORT] : [PORT];
const HOSTS = new Set(ports.flatMap((p) => [`${HOST}:${p}`, `localhost:${p}`]));
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    // blob: is for previewing a file from the sandbox in the Files tab: images, audio and video play
    // from a local copy, and nothing from the sandbox can run as script.
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function same(a: string | undefined, b: string) {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: IncomingMessage) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return same(m?.[1], TOKEN);
}

function wsToken(req: IncomingMessage) {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
  return offered.includes(WS_PROTOCOL) && offered.some((p) => p.startsWith(WS_TOKEN_PREFIX) && same(p.slice(WS_TOKEN_PREFIX.length), TOKEN));
}

function reply(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8") {
  if (res.headersSent) return void res.destroy();
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(body);
}

const bridge = new Bridge();

/** Header values must be Latin-1; branch names come from the sandbox and can be anything. */
const headerSafe = (v: string) => encodeURIComponent(v);

async function serveBundle(url: URL, res: ServerResponse) {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  let session: Thread;
  try {
    session = bridge.sessionFor(sessionId);
  } catch (e) {
    return reply(res, 404, JSON.stringify({ message: (e as Error).message }), "application/json");
  }
  const dir = url.searchParams.get("dir") || session.cwd;
  if (!dir.startsWith("/")) {
    return reply(res, 400, JSON.stringify({ message: "The directory must be an absolute path inside the sandbox." }), "application/json");
  }
  let b: Bundle;
  try {
    b = await makeBundle(session.sandbox, dir);
  } catch (e) {
    const err = e as CliError;
    return reply(
      res,
      err.message === "Nothing to bundle" ? 409 : 500,
      JSON.stringify({ message: err.message, detail: err.detail, hint: err.hint }),
      "application/json",
    );
  }
  // From here on the local copy is ours to remove, whatever happens.
  res.on("close", () => void b.cleanup());
  try {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${b.filename}"`,
      "Content-Length": statSync(b.path).size,
      "X-Bundle-Branch": headerSafe(b.branch),
      "X-Bundle-Commits": String(b.commits),
      "X-Bundle-Base": headerSafe(b.base),
    });
    createReadStream(b.path)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch (e) {
    reply(res, 500, JSON.stringify({ message: `Could not send the bundle: ${(e as Error).message}` }), "application/json");
  }
}

const PREVIEW_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
};
const TEXT_TYPES = new Set([
  ".txt",
  ".md",
  ".json",
  ".log",
  ".csv",
  ".yaml",
  ".yml",
  ".toml",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".xml",
  ".py",
  ".sh",
]);

/** What the browser should treat a file from the sandbox as: media it can play, text it can show, else opaque bytes. HTML is plain text here. */
function typeFor(name: string) {
  const ext = extname(name).toLowerCase();
  return PREVIEW_TYPES[ext] ?? (TEXT_TYPES.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

function failure(res: ServerResponse, e: unknown, fallback = 500) {
  const err = e as CliError & { status?: number };
  reply(res, err.status ?? fallback, JSON.stringify({ message: err.message, detail: err.detail, hint: err.hint }), "application/json");
}

async function serveFile(url: URL, res: ServerResponse) {
  let d: files.Download;
  try {
    const sandbox = bridge.readySandbox(url.searchParams.get("sandbox") ?? "");
    d = await files.fetchOut(sandbox, files.cleanPath(url.searchParams.get("path")));
  } catch (e) {
    return failure(res, e);
  }
  res.on("close", () => void d.cleanup());
  try {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": typeFor(d.name),
      "Cache-Control": "no-store",
      "Content-Length": d.size,
      // Percent-encoded: names come from the sandbox and may not be Latin-1.
      "X-File-Name": headerSafe(d.name),
    });
    createReadStream(d.file)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch (e) {
    failure(res, e);
  }
}

/** PUT /api/upload?sandbox=&dir=&name=[&overwrite=1]: the body is the file. */
async function serveUpload(req: IncomingMessage, url: URL, res: ServerResponse) {
  // Not a cookie, so another site can't borrow it, but a browser's own Origin says where this came from.
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return failure(res, files.refused(403, "Not from this console's page."));
  let dir: string | undefined;
  try {
    const length = Number(req.headers["content-length"]);
    if (!Number.isFinite(length) || length < 0) throw files.refused(411, "The upload needs a Content-Length.");
    if (length > files.MAX_UPLOAD)
      throw files.refused(413, `Too big to upload here (${Math.round(length / 1e6)} MB; the limit is ${files.MAX_UPLOAD / 1e6} MB).`);
    const sandbox = bridge.readySandbox(url.searchParams.get("sandbox") ?? "");
    const folder = files.cleanPath(url.searchParams.get("dir"));
    const name = files.cleanName(url.searchParams.get("name"));
    if (url.searchParams.get("overwrite") !== "1" && (await files.exists(sandbox, `${folder}/${name}`))) {
      throw files.refused(409, `${name} already exists in ${folder}.`);
    }
    dir = mkdtempSync(join(tmpdir(), "sandbox-console-upload-"));
    const local = join(dir, name);
    let seen = 0;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        cb(seen > length ? new Error("The body is longer than its Content-Length.") : null, chunk);
      },
    });
    await pipeline(req, guard, createWriteStream(local));
    if (seen !== length) throw files.refused(400, "The upload was cut short.");
    await files.putIn(sandbox, local, folder);
    reply(res, 200, JSON.stringify({ ok: true, path: `${folder}/${name}`, size: seen }), "application/json");
  } catch (e) {
    req.resume();
    failure(res, e, 500);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function serveStatic(req: IncomingMessage, url: URL, res: ServerResponse) {
  let path: string;
  try {
    path = normalize(decodeURIComponent(url.pathname));
  } catch {
    return reply(res, 400, "Bad URL");
  }
  if (path === "/" || !extname(path)) path = "/index.html";
  const file = join(WEB, path);
  if (!file.startsWith(WEB + sep) || !existsSync(file) || !statSync(file).isFile()) {
    if (!existsSync(join(WEB, "index.html"))) {
      return reply(res, 503, "The UI isn't built yet. Run `npm run build` (or use ./console.sh), then reload.");
    }
    return reply(res, 404, "Not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Length": statSync(file).size,
    "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...SECURITY_HEADERS,
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  if (!HOSTS.has(req.headers.host ?? "")) return reply(res, 421, "Wrong Host header.");
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    if (!bearer(req)) return reply(res, 401, JSON.stringify({ message: "Missing or wrong access token." }), "application/json");
    if (url.pathname === "/api/upload" && req.method === "PUT") return void serveUpload(req, url, res);
    if (req.method !== "GET") return reply(res, 405, "Method not allowed");
    if (url.pathname === "/api/file") return void serveFile(url, res);
    if (url.pathname === "/api/ping") return reply(res, 200, "{}", "application/json");
    if (url.pathname === "/api/bundle") return void serveBundle(url, res);
    return reply(res, 404, "Not found");
  }
  if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "Method not allowed");
  serveStatic(req, url, res);
}

const server = createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    // Never let one bad request take down the bridge and every agent session with it.
    console.error(`request ${req.method} ${req.url} failed: ${(e as Error).message}`);
    reply(res, 500, "Internal error");
  }
});

const wss = new WebSocketServer({
  noServer: true,
  // A prompt can carry a few images (about 6 MB of base64 each at most; see validate.ts).
  maxPayload: 28 * 1024 * 1024,
  handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
});
server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  let path = "";
  try {
    path = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  } catch {
    /* refused below */
  }
  if (path !== "/ws" || !HOSTS.has(req.headers.host ?? "") || !origin || !ORIGINS.has(origin) || !wsToken(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => bridge.attach(ws));
});

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is in use. Start with --port N.` : e.message);
  process.exit(1);
});

/**
 * Open the console in the browser without putting the token on a command line,
 * where other local users could read it with `ps`: write a private launcher
 * page (mode 0600, in a 0700 directory) that forwards to the URL, and open that.
 */
function openBrowser(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-console-"));
  const file = join(dir, "open.html");
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>Sandbox Console</title><script>location.replace(${JSON.stringify(url)})</script>`,
    { mode: 0o600 },
  );
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [file], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 60_000).unref();
}

server.listen(PORT, HOST, () => {
  bridge.start();
  const url = `http://${HOST}:${DEV ? DEV_PORT : PORT}/#token=${TOKEN}`;
  console.log(`Sandbox Console is running.\n\n  ${url}\n`);
  if (!bridge.policy) console.log("note: no policies/vscode-terminal.yaml found; set OPENSHELL_CONFIGS to your openshell-configs checkout.");
  if (flag("--open") && !flag("--no-open")) openBrowser(url);
});

const shutdown = () => {
  bridge.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
