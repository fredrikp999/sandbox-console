// Left column: gateway line, sandbox rows with status, "New sandbox".
import { useEffect, useMemo, useState } from "react";
import type { ActivityState, PastSession, ServerMessage } from "../../../shared/protocol.ts";
import { ago, dotClass, sandboxStatus, shortId } from "../format.ts";
import { type RequestError, store, useStore } from "../store.ts";
import { NewSandbox } from "./NewSandbox.tsx";

const DOT: Record<ActivityState, string> = {
  waiting: "dot warn",
  working: "dot ok pulse",
  starting: "dot idle",
  idle: "dot idle",
  dead: "dot bad",
};

const ALL = "*all";

/** The agent's own earlier sessions (session/list) in this sandbox's directory; loading one makes it a thread. */
function EarlierFromAgent({ sandbox }: { sandbox: string }) {
  // Any live thread can ask: they share the agent process.
  const live = useStore((s) => Object.values(s.sessions).find((v) => v.info.sandbox === sandbox && v.info.state !== "dead" && v.info.canList));
  const [list, setList] = useState<PastSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!live) return null;
  const info = live.info;

  const show = async () => {
    setError(null);
    try {
      const r = await store.request<Extract<ServerMessage, { type: "past_sessions" }>>({ type: "list_past_sessions", sessionId: info.sessionId });
      setList(r.sessions);
      if (r.error) setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = async (id: string) => {
    setBusy(id);
    try {
      await store.request({ type: "open_session", sandbox, agent: info.agent, cwd: info.cwd, loadSessionId: id });
      setList((l) => l?.filter((p) => p.sessionId !== id) ?? null);
    } catch (e) {
      setError((e as RequestError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {!list ? (
        <button type="button" className="sb-thread-all" onClick={show} title={`Sessions the agent keeps for ${info.cwd}`}>
          Earlier from the agent…
        </button>
      ) : (
        <>
          <div className="sb-threads-label">From the agent{list.length ? "" : ": none"}</div>
          {list.slice(0, 30).map((p) => (
            <div key={p.sessionId} className="sb-thread">
              <button
                type="button"
                className="sb-thread-open"
                disabled={!!busy}
                onClick={() => open(p.sessionId)}
                title={`Load ${p.sessionId} as a thread`}
              >
                <span className="dot idle" />
                <span className="sb-thread-title">{p.title || shortId(p.sessionId)}</span>
                <span className="sb-thread-hint">{busy === p.sessionId ? "loading…" : p.updatedAt ? ago(Date.parse(p.updatedAt)) : "load"}</span>
              </button>
            </div>
          ))}
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

/** The threads of the selected sandbox: open one in a tab, or delete it for good. */
function SandboxThreads({ sandbox }: { sandbox: string }) {
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const current = useStore((s) => s.bySandbox[sandbox]);
  /** A session id, or ALL, that the next click deletes. */
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threads = useMemo(
    () =>
      Object.values(sessions)
        .filter((v) => v.info.sandbox === sandbox)
        .sort((a, b) => b.info.startedAt - a.info.startedAt),
    [sessions, sandbox],
  );
  if (!threads.length) {
    return (
      <div className="sb-threads">
        <EarlierFromAgent sandbox={sandbox} />
      </div>
    );
  }

  const remove = async (target: string) => {
    if (armed !== target) return setArmed(target);
    setArmed(null);
    setError(null);
    try {
      await store.request(target === ALL ? { type: "delete_threads", sandbox } : { type: "delete_thread", sessionId: target });
    } catch (e) {
      setError((e as RequestError).message);
    }
  };

  return (
    <div className="sb-threads">
      {threads.map((t, i) => {
        const id = t.info.sessionId;
        const label = t.info.title || `Thread ${threads.length - i}`;
        return (
          <div key={id} className="sb-thread">
            <button
              type="button"
              className="sb-thread-open"
              aria-current={open[id] && id === current}
              title={open[id] ? `${label} (open in a tab)` : `Open ${label}`}
              onClick={() => store.activate(sandbox, id)}
            >
              <span className={DOT[t.info.state]} />
              <span className="sb-thread-title">{label}</span>
              {!open[id] && <span className="sb-thread-hint">open</span>}
            </button>
            <button
              type="button"
              className={`thread-x${armed === id ? " armed" : ""}`}
              aria-label={`Delete ${label}`}
              title="Delete this thread and its saved conversation. The sandbox's files stay."
              onClick={() => remove(id)}
              onBlur={() => setArmed((a) => (a === id ? null : a))}
            >
              {armed === id ? "Delete?" : "×"}
            </button>
          </div>
        );
      })}
      {threads.length > 1 && (
        <button
          type="button"
          className={`sb-thread-all${armed === ALL ? " armed" : ""}`}
          title="Delete every thread in this sandbox and its saved conversations. The sandbox's files stay."
          onClick={() => remove(ALL)}
          onBlur={() => setArmed((a) => (a === ALL ? null : a))}
        >
          {armed === ALL ? `Delete all ${threads.length}?` : "Delete all threads"}
        </button>
      )}
      <EarlierFromAgent sandbox={sandbox} />
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "auto");
  const next = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
  const flip = () => {
    if (next === "auto") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("theme");
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("theme", next);
    }
    setTheme(next);
  };
  return (
    <button type="button" className="icon-btn" onClick={flip} title={`Theme: ${theme} (click for ${next})`} aria-label={`Theme: ${theme}`}>
      {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
    </button>
  );
}

export function Sidebar() {
  const sandboxes = useStore((s) => s.sandboxes);
  const agents = useStore((s) => s.agents);
  const selected = useStore((s) => s.selected);
  const gateway = useStore((s) => s.gateway);
  const link = useStore((s) => s.link);
  const listError = useStore((s) => s.listError);
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Sandboxes waiting for you first; otherwise the order OpenShell lists them in.
  const rows = sandboxes
    .map((s, i) => ({ s, st: sandboxStatus(s, agents, now), i }))
    .sort((a, b) => (a.st.rank === 0 ? 0 : 1) - (b.st.rank === 0 ? 0 : 1) || a.i - b.i);

  const gwOk = gateway?.status === "connected";
  return (
    <aside className="pane side">
      <div className="pane-head">
        <span className="brand">
          <span className="brand-mark" />
          Sandbox Console
        </span>
        <ThemeToggle />
      </div>
      {link !== "open" ? (
        <div className="gw">
          <span className="dot warn" />
          <span>Console bridge {link === "connecting" ? "connecting…" : "disconnected, retrying…"}</span>
        </div>
      ) : (
        <div className="gw" title={gateway?.error ?? (gateway?.version ? `OpenShell ${gateway.version}` : undefined)}>
          <span className={gwOk ? "dot" : gateway ? "dot bad" : "dot idle"} />
          <span>
            Gateway <span className="mono">{gateway?.name ?? "openshell"}</span> · {gateway?.status ?? "checking…"}
          </span>
        </div>
      )}
      {listError && <div className="banner">{listError}</div>}
      <ul className="sb-list" aria-label="Sandboxes">
        {rows.length === 0 && !listError && <li className="sb-empty">{link === "open" ? "No sandboxes yet. Create one below." : ""}</li>}
        {rows.map(({ s, st }) => (
          <li key={s.name}>
            <button type="button" className="sb" aria-current={s.name === selected} onClick={() => store.select(s.name)}>
              <span className={dotClass(st.tone)} />
              <span className="name" title={s.name}>
                {s.name}
              </span>
              <span className={`pill ${st.tone}`}>{st.pill}</span>
              <span className="meta" title={st.meta}>
                {st.meta}
              </span>
            </button>
            {s.name === selected && <SandboxThreads sandbox={s.name} />}
          </li>
        ))}
      </ul>
      <div className="side-foot">
        <button type="button" className="btn full" onClick={() => setCreating(true)} disabled={link !== "open"}>
          New sandbox
        </button>
      </div>
      {creating && <NewSandbox onClose={() => setCreating(false)} />}
    </aside>
  );
}
