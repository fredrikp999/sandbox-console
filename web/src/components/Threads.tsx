// Row of threads under the chat header: switch between them, start another.
import { useMemo, useState } from "react";
import type { ActivityState } from "../../../shared/protocol.ts";
import { type RequestError, store, useStore } from "../store.ts";

const DOT: Record<ActivityState, string> = {
  waiting: "dot warn",
  working: "dot ok pulse",
  starting: "dot idle",
  idle: "dot idle",
  dead: "dot bad",
};

const STATE_LABEL: Record<ActivityState, string> = {
  waiting: "needs approval",
  working: "working",
  starting: "starting",
  idle: "idle",
  dead: "agent exited",
};

export function Threads({ sandbox, onError }: { sandbox: string; onError: (text: string) => void }) {
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const current = useStore((s) => s.bySandbox[sandbox]);
  const [busy, setBusy] = useState(false);
  const threads = useMemo(
    () =>
      Object.values(sessions)
        .filter((v) => v.info.sandbox === sandbox && open[v.info.sessionId])
        .sort((a, b) => a.info.startedAt - b.info.startedAt),
    [sessions, open, sandbox],
  );
  const alive = threads.some((t) => t.info.state !== "dead");

  const add = async () => {
    setBusy(true);
    try {
      await store.request({ type: "new_thread", sandbox });
    } catch (e) {
      onError([(e as RequestError).message, (e as RequestError).hint].filter(Boolean).join(" "));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="threads" role="tablist" aria-label="Threads">
      {threads.map((t, i) => {
        const label = t.info.title || `Thread ${i + 1}`;
        const id = t.info.sessionId;
        return (
          <span key={id} className="thread-wrap">
            <button
              type="button"
              role="tab"
              className="thread"
              aria-selected={id === current}
              title={`${label} · ${STATE_LABEL[t.info.state]}`}
              onClick={() => store.activate(sandbox, id)}
            >
              <span className={DOT[t.info.state]} />
              <span className="thread-title">{label}</span>
            </button>
            <button
              type="button"
              className="thread-x"
              aria-label={`Close ${label}`}
              title="Close this tab. The thread is kept; open it again from the sidebar."
              onClick={() => store.close(sandbox, id)}
            >
              ×
            </button>
          </span>
        );
      })}
      {alive && (
        <button type="button" className="thread add" onClick={add} disabled={busy} title="Start another thread in this sandbox (/new)">
          + New thread
        </button>
      )}
    </div>
  );
}
