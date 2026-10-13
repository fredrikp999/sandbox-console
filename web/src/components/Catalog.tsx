// "Catalog" tab of the inspector: agents, skills and context files on this
// machine, and which of them the selected sandbox has. Adding one copies it into
// the sandbox's home, where its agent looks (~/.claude for Claude Code,
// ~/.config/opencode for OpenCode).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CatalogItem, CatalogKind, SandboxCatalog, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { type RequestError, store, useStore } from "../store.ts";

type Reply = Extract<ServerMessage, { type: "catalog" }>;
type Outcome = { tone: "ok" | "error"; lines: string[]; hint?: string };

const SECTIONS: { kind: CatalogKind; title: string; empty: string }[] = [
  { kind: "agent", title: "Agents", empty: "No agents." },
  { kind: "skill", title: "Skills", empty: "No skills." },
  { kind: "context", title: "Context", empty: "No context files." },
];

type Status = "absent" | "added" | "outdated" | "theirs";

function statusOf(item: CatalogItem, sb: SandboxCatalog | undefined): Status {
  if (!sb) return "absent";
  const here = sb.present.includes(item.id);
  const mine = sb.installed.find((i) => i.kind === item.kind && i.name === item.name);
  if (!here) return "absent";
  if (!mine) return "theirs";
  return mine.hash === item.hash ? "added" : "outdated";
}

function where(kind: CatalogKind, name: string, places: SandboxCatalog["places"]) {
  if (kind === "agent") return `${places.agent}/${name}.md`;
  if (kind === "skill") return `${places.skill}/${name}/`;
  return places.context;
}

function size(bytes: number) {
  return bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${Math.round(bytes / 1000)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function Item({
  item,
  status,
  places,
  ready,
  busy,
  onRun,
  sandbox,
}: {
  item: CatalogItem;
  status: Status;
  places?: SandboxCatalog["places"];
  ready: boolean;
  busy: string | null;
  onRun: (op: "install" | "remove", item: CatalogItem) => void;
  sandbox: string;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const mine = busy === item.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per opening; a new hash means new contents.
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPreviewError(null);
    store
      .request<Reply>({ type: "catalog", op: "preview", sandbox, kind: item.kind, name: item.name })
      .then((r) => setPreview(r.preview ?? ""))
      .catch((e) => setPreviewError((e as Error).message));
  }, [open, item.hash, sandbox]);

  const action = status === "absent" ? "Add" : status === "outdated" ? "Update" : status === "theirs" ? "Replace" : null;
  const actionTitle =
    status === "theirs"
      ? `The sandbox already has its own ${item.name}. Adding this one replaces it.`
      : status === "outdated"
        ? "The catalog has a newer version than the sandbox"
        : places
          ? `Copy to ${where(item.kind, item.name, places)}`
          : undefined;

  return (
    <li className={`cat-item${open ? " open" : ""}`}>
      <div className="cat-row">
        <button type="button" className="cat-name" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={item.description}>
          <span className="cat-caret">{open ? "▾" : "▸"}</span>
          <span className="mono">{item.name}</span>
        </button>
        <span className="cat-acts">
          {status === "added" && <span className="cat-state">✓ added</span>}
          {action && (
            <button
              type="button"
              className={`btn small${status === "outdated" ? " primary" : ""}`}
              disabled={!ready || !!busy || !!item.problem}
              onClick={() => onRun("install", item)}
              title={item.problem ?? actionTitle}
            >
              {mine ? "…" : action}
            </button>
          )}
          {(status === "added" || status === "outdated") && (
            <button
              type="button"
              className="icon-btn"
              disabled={!ready || !!busy}
              onClick={() => onRun("remove", item)}
              title={item.kind === "context" ? "Take it out of the sandbox's instructions" : "Remove it from the sandbox"}
              aria-label={`Remove ${item.name}`}
            >
              ×
            </button>
          )}
        </span>
      </div>
      {item.description && <div className="cat-desc">{item.description}</div>}
      {open && (
        <div className="cat-more">
          <div className="muted">
            {item.source}
            {item.kind === "skill" && ` · ${item.files} file${item.files === 1 ? "" : "s"}, ${size(item.bytes)}`}
            {places && (
              <>
                {" · goes to "}
                <span className="mono">{where(item.kind, item.name, places)}</span>
              </>
            )}
          </div>
          {item.problem && <div className="no">{item.problem}</div>}
          {item.kind === "agent" && <div className="muted">Shown as it's written for this sandbox's agent.</div>}
          {item.kind === "context" && <div className="muted">Added to the agent's own instructions, between marker lines.</div>}
          {previewError ? <div className="no">{previewError}</div> : <pre className="cat-preview">{preview ?? "Loading…"}</pre>}
        </div>
      )}
    </li>
  );
}

export function Catalog({ sb }: { sb: SandboxRow }) {
  const agents = useStore((s) => s.agents);
  const connected = useStore((s) => s.link === "open");
  const [data, setData] = useState<Reply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const ready = sb.phase === "Ready" && !data?.sandbox?.error;
  const agentId = sb.session?.agent ?? sb.agent;

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoadError(null);
    try {
      setData(await store.request<Reply>({ type: "catalog", op: "list", sandbox: sb.name }));
    } catch (e) {
      const err = e as RequestError;
      setLoadError([err.message, err.detail].filter(Boolean).join(": "));
    }
  }, [sb.name, agentId]);

  useEffect(() => {
    setData(null);
    setOutcome(null);
    if (connected) load();
  }, [load, connected]);

  const run = async (op: "install" | "remove", item: CatalogItem) => {
    setBusy(item.id);
    setOutcome(null);
    try {
      const r = await store.request<Reply>({ type: "catalog", op, sandbox: sb.name, kind: item.kind, name: item.name });
      setData(r);
      setOutcome({ tone: "ok", lines: r.log });
    } catch (e) {
      const err = e as RequestError;
      setOutcome({ tone: "error", lines: [err.message, ...(err.detail ? err.detail.split("\n") : [])], hint: err.hint });
    } finally {
      setBusy(null);
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => (data?.items ?? []).filter((i) => !q || `${i.name} ${i.description} ${i.source}`.toLowerCase().includes(q)), [data, q]);
  const own = useMemo(() => {
    const ids = new Set(data?.items.map((i) => i.id));
    return (data?.sandbox?.present ?? []).filter((id) => !ids.has(id));
  }, [data]);

  if (!agentId) {
    return (
      <p className="muted pad">Choose which agent runs in {sb.name} in the sidebar first: agents and skills go where that agent looks for them.</p>
    );
  }
  const label = agents.find((a) => a.id === agentId)?.label ?? agentId;
  const places = data?.sandbox?.places;

  return (
    <>
      <div className="blk">
        <div className="cat-search">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter agents, skills, context"
            aria-label="Filter the catalog"
          />
          <button type="button" className="icon-btn" onClick={load} title="Read the catalog and the sandbox again" aria-label="Reload catalog">
            ↻
          </button>
        </div>
        <p className="muted">
          Copies them into {sb.name} for {label}
          {places && (
            <>
              {" "}
              (<span className="mono">{places.agent.replace(/\/agents$/, "")}</span>)
            </>
          )}
          . New threads pick them up.
        </p>
        {loadError && <p className="no">{loadError}</p>}
        {data?.sandbox?.error && <p className="no">{data.sandbox.error}</p>}
        {outcome && (
          <div className={outcome.tone === "error" ? "repo-out err" : "repo-out"} role="status">
            {outcome.lines.map((l, i) => (
              <div key={l} className={outcome.tone === "error" && i === 0 ? "first" : undefined}>
                {l}
              </div>
            ))}
            {outcome.hint && <div className="hint">{outcome.hint}</div>}
          </div>
        )}
      </div>
      {!data && !loadError && <p className="muted pad">Reading the catalog…</p>}
      {data &&
        SECTIONS.map(({ kind, title, empty }) => {
          const items = shown.filter((i) => i.kind === kind);
          const added = data.items.filter((i) => i.kind === kind && statusOf(i, data.sandbox) !== "absent").length;
          return (
            <div className="blk" key={kind}>
              <h5>
                {title}
                {added > 0 && <span className="cat-count">{added} in the sandbox</span>}
              </h5>
              {!items.length && <p className="muted">{q ? "Nothing matches." : empty}</p>}
              {items.length > 0 && (
                <ul className="cat-list">
                  {items.map((i) => (
                    <Item
                      key={i.id}
                      item={i}
                      status={statusOf(i, data.sandbox)}
                      places={places}
                      ready={ready}
                      busy={busy}
                      onRun={run}
                      sandbox={sb.name}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      {data && (
        <div className="blk">
          {own.length > 0 && (
            <p className="muted">
              Also in the sandbox, not from the catalog:{" "}
              {own.map((id, n) => (
                <span key={id}>
                  {n > 0 && ", "}
                  <span className="mono">{id.replace(":", " ")}</span>
                </span>
              ))}
              .
            </p>
          )}
          <p className="muted">
            Add your own to <span className="mono">{data.folder}</span>: <span className="mono">agents/&lt;name&gt;.md</span>,{" "}
            <span className="mono">skills/&lt;name&gt;/SKILL.md</span> or <span className="mono">context/&lt;name&gt;.md</span>. Your skills and
            agents in ~/.claude, ~/.agents and ~/.config/opencode are listed too.
          </p>
        </div>
      )}
    </>
  );
}
