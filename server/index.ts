// Sandbox Console bridge: serves the UI on 127.0.0.1 and relays ACP between
// browser tabs (WebSocket) and agents in OpenShell sandboxes (stdio).
//
//   npx tsx server/index.ts [--port N] [--open] [--dev]
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import { makeBundle } from "./bundle.ts";
import { ROOT } from "./config.ts";
import { Console } from "./console.ts";
import { CliError } from "./openshell.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const HOST = "127.0.0.1";
const PORT = Number(opt("--port") ?? process.env.CONSOLE_PORT ?? 7801);
const DEV = flag("--dev");
const WEB = join(ROOT, "dist", "web");
// A random token per start. Without it, other local users or any web page could
// drive your agents over the WebSocket (DESIGN.md section 8).
const TOKEN = process.env.CONSOLE_TOKEN || randomBytes(24).toString("base64url");
const COOKIE = "sc_token";
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
if (DEV) ORIGINS.add("http://127.0.0.1:5173").add("http://localhost:5173");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
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

function cookieToken(req: IncomingMessage) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return undefined;
}

function authed(req: IncomingMessage) {
  return same(cookieToken(req), TOKEN);
}

function reply(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(body);
}

const app = new Console();

async function serveBundle(url: URL, res: ServerResponse) {
  const sessionId = url.searchParams.get("sessionId") ?? "";
  let session;
  try {
    session = app.sessionFor(sessionId);
  } catch (e) {
    return reply(res, 404, (e as Error).message);
  }
  const dir = url.searchParams.get("dir") || session.cwd;
  try {
    const b = await makeBundle(session.sandbox, dir);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${b.filename}"`,
      "Content-Length": statSync(b.path).size,
      "X-Bundle-Branch": b.branch,
      "X-Bundle-Commits": String(b.commits),
      "X-Bundle-Base": b.base,
    });
    createReadStream(b.path).pipe(res).on("close", () => void b.cleanup());
  } catch (e) {
    const err = e as CliError;
    reply(
      res,
      err.message === "Nothing to bundle" ? 409 : 500,
      JSON.stringify({ message: err.message, detail: err.detail, hint: err.hint }),
      "application/json",
    );
  }
}

function serveStatic(url: URL, res: ServerResponse) {
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (path === "/" || !extname(path)) path = "/index.html";
  const file = join(WEB, path);
  if (!file.startsWith(WEB) || !existsSync(file)) {
    if (!existsSync(join(WEB, "index.html"))) {
      return reply(res, 503, "The UI isn't built yet. Run `npm run build` (or use ./console.sh), then reload.");
    }
    return reply(res, 404, "Not found");
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...SECURITY_HEADERS,
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  // First visit: the token comes in the URL. Move it into an HttpOnly cookie and
  // drop it from the address bar.
  const t = url.searchParams.get("token");
  if (t !== null) {
    if (!same(t, TOKEN)) return reply(res, 403, "Wrong token. Use the URL the console printed when it started.");
    url.searchParams.delete("token");
    res.writeHead(302, {
      "Set-Cookie": `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
      Location: url.pathname + url.search,
      ...SECURITY_HEADERS,
    });
    return res.end();
  }
  if (!authed(req)) {
    return reply(res, 401, "Open the console with the URL it printed at start-up (it carries the access token).");
  }
  if (req.method === "GET" && url.pathname === "/api/bundle") return void serveBundle(url, res);
  if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "Method not allowed");
  serveStatic(url, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const origin = req.headers.origin;
  if (url.pathname !== "/ws" || !authed(req) || !origin || !ORIGINS.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => app.attach(ws));
});

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is in use. Start with --port N.` : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  app.start();
  const url = `http://${HOST}:${DEV ? 5173 : PORT}/?token=${TOKEN}`;
  console.log(`Sandbox Console is running.\n\n  ${url}\n`);
  if (!app.policy) console.log("note: no policies/vscode-terminal.yaml found; set OPENSHELL_CONFIGS to your openshell-configs checkout.");
  if (flag("--open") && !flag("--no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
});

const shutdown = () => {
  app.stop();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
