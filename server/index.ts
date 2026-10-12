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
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { WebSocketServer } from "ws";
import { Bridge } from "./bridge.ts";
import { type Bundle, makeBundle } from "./bundle.ts";
import { ROOT } from "./config.ts";
import type { CliError } from "./openshell.ts";
import type { Session } from "./session.ts";

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
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
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
  let session: Session;
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
    if (req.method !== "GET") return reply(res, 405, "Method not allowed");
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
  maxPayload: 4 * 1024 * 1024,
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
