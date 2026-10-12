// JSON-RPC 2.0 over a child process's stdin and stdout, one JSON object per
// line: the ACP stdio transport. Ported from acp_client.py, which proved it
// against OpenCode. We keep our own small transport rather than the SDK's
// connection class so that:
//   - requests we don't serve (fs/*, terminal/*) are refused with -32601,
//   - non-JSON lines on stdout go to the stderr tail instead of being answered,
//   - payloads are relayed as the agent sent them, without schema validation.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class TransportClosed extends Error {}

// Params arrive as the agent sent them: the handlers check what they use.
type IncomingRequest = (method: string, params: unknown) => Promise<unknown>;
type IncomingNotification = (method: string, params: unknown) => void;

/** A JSON-RPC message off the wire, before anything about it is trusted. */
interface WireMessage {
  id?: number | string;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export const METHOD_NOT_FOUND = -32601;

export class JsonRpcPeer {
  private nextId = 0;
  private pending = new Map<number | string, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  readonly stderrTail: string[] = [];

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onRequest: IncomingRequest,
    private readonly onNotification: IncomingNotification,
    private readonly tailSize = 50,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => this.tail(line));
    child.on("close", () => this.shutdown());
    child.stdin.on("error", () => this.shutdown());
  }

  private tail(line: string) {
    this.stderrTail.push(line);
    if (this.stderrTail.length > this.tailSize) this.stderrTail.shift();
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new TransportClosed(`agent exited during ${p.method}`));
    this.pending.clear();
  }

  private send(msg: object) {
    if (this.closed) throw new TransportClosed("agent process has exited");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  }

  private handleLine(raw: string) {
    const line = raw.trim();
    if (!line) return;
    let msg: WireMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      // A banner or shell output on stdout. Keep it for error reports.
      this.tail(`(stdout, not JSON) ${line}`);
      return;
    }
    if (msg == null || typeof msg !== "object") return;

    if (typeof msg.method === "string" && msg.id !== undefined) {
      const id = msg.id;
      this.onRequest(msg.method, msg.params ?? {}).then(
        (result) => !this.closed && this.send({ id, result: result ?? null }),
        (err: Error) =>
          !this.closed &&
          this.send({
            id,
            error: {
              code: err instanceof RpcError && err.code !== undefined ? err.code : -32603,
              message: String(err?.message ?? err),
            },
          }),
      );
    } else if (typeof msg.method === "string") {
      this.onNotification(msg.method, msg.params ?? {});
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = msg.error;
        p.reject(new RpcError(p.method, e.code, e.message ?? "unknown error", e.data));
      } else p.resolve(msg.result ?? {});
    }
  }

  /**
   * Send a request and wait for its result. `T` is what the agent should answer
   * with per the ACP schema; it isn't validated, so callers treat fields as optional.
   */
  request<T>(method: string, params: object, timeoutMs?: number): Promise<Partial<T>> {
    const id = ++this.nextId;
    return new Promise<Partial<T>>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve((v ?? {}) as Partial<T>);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new RpcError(method, undefined, `no answer to ${method} after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }
      try {
        this.send({ id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params: object) {
    this.send({ method, params });
  }

  get isClosed() {
    return this.closed;
  }
}
