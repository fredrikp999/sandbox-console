// "Ports" in the sandbox header: forward a port from this machine to the same
// port in the sandbox (`openshell forward`), to open something the agent serves,
// like the HyperFrames Studio, in your browser. Presets, the ports open in the
// sandbox, or any other port.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ListeningPort, PortPreset, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { type RequestError, store } from "../store.ts";
import { Popover } from "./Popover.tsx";

type Reply = Extract<ServerMessage, { type: "ports" }>;
type Outcome = { tone: "ok" | "error"; lines: string[]; hint?: string };

/** Linux hands out ports from here for outgoing and throwaway servers; rarely what you want to open. */
const EPHEMERAL = 32768;
const url = (port: number) => `http://127.0.0.1:${port}/`;

type SectionId = "forwarded" | "presets" | "open" | "other";
const SECTIONS_KEY = "sandbox-console-ports-sections";
/** What's forwarded is open at first; the rest is a click away. Your choice is remembered. */
const DEFAULT_OPEN: Record<SectionId, boolean> = { forwarded: true, presets: false, open: false, other: false };

function loadSections(): Record<SectionId, boolean> {
  try {
    return { ...DEFAULT_OPEN, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_OPEN;
  }
}

function Section({
  title,
  count,
  open,
  onToggle,
  tools,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`pop-sec ports${open ? "" : " closed"}`}>
      <div className="pop-label">
        <button type="button" className="sec-head" onClick={onToggle} aria-expanded={open}>
          <span className="cat-caret">{open ? "▾" : "▸"}</span>
          {title}
          {count !== undefined && <span className="sec-count">{count}</span>}
        </button>
        {tools}
      </div>
      {open && children}
    </div>
  );
}

export function Ports({ sb }: { sb: SandboxRow }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Reply | null>(null);
  const [busy, setBusy] = useState<number | "load" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [custom, setCustom] = useState("");
  const [more, setMore] = useState(false);
  const [sections, setSections] = useState(loadSections);
  const toggle = (id: SectionId) =>
    setSections((s) => {
      const next = { ...s, [id]: !s[id] };
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      return next;
    });
  const close = useCallback(() => setOpen(false), []);
  const ready = sb.phase === "Ready";

  const load = useCallback(async () => {
    setBusy("load");
    try {
      setData(await store.request<Reply>({ type: "ports", sandbox: sb.name }));
    } catch (e) {
      setOutcome({ tone: "error", lines: [(e as Error).message] });
    } finally {
      setBusy(null);
    }
  }, [sb.name]);

  // Know the forwards from the start, for the count on the button.
  useEffect(() => {
    setData(null);
    setOutcome(null);
    load();
  }, [load]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const act = async (op: "start" | "stop", port: number) => {
    setBusy(port);
    setOutcome(null);
    try {
      const r = await store.request<Reply>({ type: "forward", sandbox: sb.name, op, port });
      setData(r);
      setOutcome({ tone: "ok", lines: r.log });
      if (op === "start") setCustom("");
    } catch (e) {
      const err = e as RequestError;
      setOutcome({ tone: "error", lines: [err.message, ...(err.detail ? [err.detail] : [])], hint: err.hint });
    } finally {
      setBusy(null);
    }
  };

  const forwards = data?.forwards ?? [];
  const forwarded = new Set(forwards.map((f) => f.port));
  const listening = data?.listening ?? [];
  const isOpen = (port: number) => listening.some((l) => l.port === port);
  const presetOf = (port: number): PortPreset | undefined => data?.presets.find((p) => p.port === port);
  const labelOf = (port: number) => presetOf(port)?.label ?? listening.find((l) => l.port === port)?.command;
  const presets = (data?.presets ?? []).filter((p) => !forwarded.has(p.port));
  const others = listening.filter((l) => !forwarded.has(l.port) && !presetOf(l.port));
  const shownOthers = others.filter((l) => l.port < EPHEMERAL || l.command);
  const hidden = others.filter((l) => l.port >= EPHEMERAL && !l.command);
  const customPort = Number(custom);
  const customOk = /^\d+$/.test(custom) && customPort >= 1024 && customPort <= 65535;

  const forwardButton = (port: number) => (
    <button type="button" className="btn small" disabled={!ready || busy !== null} onClick={() => act("start", port)}>
      {busy === port ? "…" : "Forward"}
    </button>
  );
  const row = (l: ListeningPort) => (
    <li key={l.port} className="port-row">
      <span className="port-main">
        <span className="mono port-num">{l.port}</span>
        {l.command && (
          <span className="port-label mono" title={l.command}>
            {l.command}
          </span>
        )}
      </span>
      {forwardButton(l.port)}
    </li>
  );

  return (
    <Popover
      open={open}
      onClose={close}
      label={`Ports of ${sb.name}`}
      anchor={
        <button
          type="button"
          className="btn small"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title="Open a port of the sandbox in your browser (openshell forward)"
        >
          Ports
          {forwards.length > 0 && <span className="badge on">{forwards.length}</span>}
        </button>
      }
    >
      <Section
        title="Forwarded"
        count={forwards.length}
        open={sections.forwarded}
        onToggle={() => toggle("forwarded")}
        tools={
          <button type="button" className="icon-btn" onClick={load} disabled={busy !== null} title="Look again" aria-label="Refresh ports">
            ↻
          </button>
        }
      >
        {!forwards.length && <p className="muted">Nothing yet. Forward a port and open it here at the same number.</p>}
        <ul className="port-list">
          {forwards.map((f) => (
            <li key={f.port} className="port-row">
              <span className="port-main">
                <a href={url(f.port)} target="_blank" rel="noreferrer noopener" className="mono port-link">
                  127.0.0.1:{f.port} ↗
                </a>
                <span className="port-label">
                  {[
                    labelOf(f.port),
                    !f.alive ? "the forward has stopped" : !isOpen(f.port) && !data?.error ? "nothing listening in the sandbox yet" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <button type="button" className="btn small" disabled={busy !== null} onClick={() => act("stop", f.port)}>
                {busy === f.port ? "…" : "Stop"}
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {presets.length > 0 && (
        <Section title="Presets" count={presets.length} open={sections.presets} onToggle={() => toggle("presets")}>
          <ul className="port-list">
            {presets.map((p) => (
              <li key={p.port} className="port-row">
                <span className="port-main">
                  <span>
                    {p.label} <span className="mono muted">{p.port}</span>
                  </span>
                  <span className={`port-label${isOpen(p.port) ? " up" : ""}`}>
                    {isOpen(p.port) ? "running in the sandbox" : (p.hint ?? "not running in the sandbox")}
                  </span>
                </span>
                {forwardButton(p.port)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(shownOthers.length > 0 || hidden.length > 0) && (
        <Section title="Open in the sandbox" count={others.length} open={sections.open} onToggle={() => toggle("open")}>
          <ul className="port-list">
            {shownOthers.map(row)}
            {more && hidden.map(row)}
          </ul>
          {hidden.length > 0 && (
            <button type="button" className="linklike" onClick={() => setMore((m) => !m)}>
              {more ? "Fewer" : `${hidden.length} more high port${hidden.length === 1 ? "" : "s"} (usually the agent's own)`}
            </button>
          )}
        </Section>
      )}

      <Section title="Another port" open={sections.other} onToggle={() => toggle("other")}>
        <form
          className="port-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (customOk) act("start", customPort);
          }}
        >
          <div className="port-custom">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value.trim())}
              inputMode="numeric"
              placeholder="e.g. 4321"
              aria-label="Port to forward"
            />
            <button type="submit" className="btn small" disabled={!ready || !customOk || busy !== null}>
              Forward
            </button>
          </div>
          <span className="muted">The same port on this machine and in the sandbox, 1024–65535, only on 127.0.0.1.</span>
        </form>
      </Section>

      {data?.error && <div className="form-error">{data.error}</div>}
      {outcome && (
        <div className={outcome.tone === "error" ? "repo-out err" : "repo-out"} role="status">
          {outcome.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
          {outcome.hint && <div className="hint">{outcome.hint}</div>}
        </div>
      )}
    </Popover>
  );
}
