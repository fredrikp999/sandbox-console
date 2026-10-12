// Threads on disk, so the conversations survive a restart of the bridge or an
// exit of the agent. Per thread: `<id>.meta.json` (its info, rewritten whole, small)
// and `<id>.log.jsonl` (the event log, one event per line, only appended to; it is
// rewritten whole only when the in-memory log was compacted).
// Deleted ids are remembered per sandbox, because ACP has no way to delete a
// session in the agent and it would otherwise come back under "earlier threads".
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent, SessionInfo } from "../shared/protocol.ts";

const META = ".meta.json";
const LOG = ".log.jsonl";
const DELETED = "deleted.json";
/** A streaming reply changes the log many times a second; write it once in a while. */
const WRITE_DELAY = 1500;

export interface StoredThread {
  info: SessionInfo;
  log: SessionEvent[];
}

/** What a thread hands over to be saved. */
export interface Snapshot {
  sandbox: string;
  sessionId: string;
  /** Called when the write happens, so it saves the log as it is then. */
  read(): StoredThread & {
    /** The log was compacted since the last read: events already on disk changed. */
    rewritten: boolean;
  };
}

export class ThreadStore {
  private pending = new Map<string, Snapshot>();
  private timer: NodeJS.Timeout | null = null;
  private deleted = new Map<string, Set<string>>();
  /** Last seq on disk per thread, so a write appends only what is new. */
  private written = new Map<string, number>();

  constructor(readonly dir: string) {}

  private sandboxDir(sandbox: string) {
    return join(this.dir, Buffer.from(sandbox).toString("base64url"));
  }

  private threadFile(sandbox: string, sessionId: string, suffix: string) {
    return join(this.sandboxDir(sandbox), Buffer.from(sessionId).toString("base64url") + suffix);
  }

  /** Every saved thread. Unreadable files are skipped. */
  loadAll(): StoredThread[] {
    const out: StoredThread[] = [];
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.dir);
    } catch {
      return out; // first run
    }
    for (const d of dirs) {
      let files: string[] = [];
      try {
        files = readdirSync(join(this.dir, d));
      } catch {
        continue;
      }
      for (const f of files.filter((f) => f.endsWith(META))) {
        try {
          const info = JSON.parse(readFileSync(join(this.dir, d, f), "utf8")) as SessionInfo;
          if (!info?.sessionId || !info.sandbox) continue;
          const text = readFileSync(join(this.dir, d, f.slice(0, -META.length) + LOG), "utf8").split("\n");
          const log: SessionEvent[] = [];
          for (const line of text) {
            if (!line) continue;
            try {
              log.push(JSON.parse(line));
            } catch {
              /* a line cut off by a crash */
            }
          }
          out.push({ info, log });
          this.written.set(`${info.sandbox}\0${info.sessionId}`, log.at(-1)?.seq ?? 0);
        } catch {
          console.warn(`warning: skipping unreadable ${join(d, f)}`);
        }
      }
    }
    return out;
  }

  /** Save this thread soon. */
  schedule(snap: Snapshot) {
    if (this.isDeleted(snap.sandbox, snap.sessionId)) return;
    this.pending.set(`${snap.sandbox}\0${snap.sessionId}`, snap);
    this.timer ??= setTimeout(() => this.flush(), WRITE_DELAY);
    this.timer.unref();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const snap of batch) {
      try {
        const key = `${snap.sandbox}\0${snap.sessionId}`;
        const { info, log, rewritten } = snap.read();
        mkdirSync(this.sandboxDir(snap.sandbox), { recursive: true });
        const logFile = this.threadFile(snap.sandbox, snap.sessionId, LOG);
        const done = this.written.get(key);
        if (done === undefined || rewritten) {
          this.replace(logFile, log.map((e) => `${JSON.stringify(e)}\n`).join(""));
        } else {
          // Seqs rise along the log, so what is new is a tail.
          let i = log.length;
          while (i > 0 && log[i - 1].seq > done) i--;
          if (i < log.length)
            appendFileSync(
              logFile,
              log
                .slice(i)
                .map((e) => `${JSON.stringify(e)}\n`)
                .join(""),
            );
        }
        this.written.set(key, log.at(-1)?.seq ?? 0);
        this.replace(this.threadFile(snap.sandbox, snap.sessionId, META), JSON.stringify(info));
      } catch (e) {
        console.warn(`warning: cannot save thread ${snap.sessionId}: ${(e as Error).message}`);
      }
    }
  }

  private replace(file: string, text: string) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  isDeleted(sandbox: string, sessionId: string): boolean {
    return this.deletedIn(sandbox).has(sessionId);
  }

  /** Remove a thread's file and remember its id as deleted. */
  remove(sandbox: string, sessionId: string) {
    this.pending.delete(`${sandbox}\0${sessionId}`);
    this.written.delete(`${sandbox}\0${sessionId}`);
    rmSync(this.threadFile(sandbox, sessionId, META), { force: true });
    rmSync(this.threadFile(sandbox, sessionId, LOG), { force: true });
    this.deletedIn(sandbox).add(sessionId);
    this.saveDeleted(sandbox);
  }

  /** Remove everything saved for a sandbox that no longer exists. */
  removeSandbox(sandbox: string) {
    for (const k of [...this.pending.keys()]) if (k.startsWith(`${sandbox}\0`)) this.pending.delete(k);
    for (const k of [...this.written.keys()]) if (k.startsWith(`${sandbox}\0`)) this.written.delete(k);
    this.deleted.delete(sandbox);
    rmSync(this.sandboxDir(sandbox), { recursive: true, force: true });
  }

  private deletedIn(sandbox: string): Set<string> {
    let set = this.deleted.get(sandbox);
    if (!set) {
      try {
        set = new Set(JSON.parse(readFileSync(join(this.sandboxDir(sandbox), DELETED), "utf8")) as string[]);
      } catch {
        set = new Set();
      }
      this.deleted.set(sandbox, set);
    }
    return set;
  }

  private saveDeleted(sandbox: string) {
    try {
      mkdirSync(this.sandboxDir(sandbox), { recursive: true });
      writeFileSync(join(this.sandboxDir(sandbox), DELETED), JSON.stringify([...this.deletedIn(sandbox)]));
    } catch (e) {
      console.warn(`warning: cannot save the list of deleted threads: ${(e as Error).message}`);
    }
  }
}
