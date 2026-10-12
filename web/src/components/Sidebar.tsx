// Left column: gateway line, sandbox rows with status, "New sandbox".
import { useEffect, useState } from "react";
import { dotClass, sandboxStatus } from "../format.ts";
import { store, useStore } from "../store.ts";
import { NewSandbox } from "./NewSandbox.tsx";

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
