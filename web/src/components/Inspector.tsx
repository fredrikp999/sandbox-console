// Right column: session details, files changed, network, approvals, earlier sessions.
import { useCallback, useEffect, useState } from "react";
import type { NetworkHost, PastSession, ServerMessage } from "../../../shared/protocol.ts";
import { type BundleStatus, downloadBundle } from "../bundle.ts";
import { ago, relPath, sandboxStatus, shortId, tokens } from "../format.ts";
import { type RequestError, type SessionView, store, useStore } from "../store.ts";
import { Repos } from "./Repos.tsx";
import { DeleteSandbox } from "./StartSession.tsx";

const NETWORK_EVERY = 15_000;

function Network({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [hosts, setHosts] = useState<NetworkHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = (await store.request({ type: "network", sessionId })) as Extract<ServerMessage, { type: "network" }>;
      setHosts(r.hosts);
      setError(r.error ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);
  useEffect(() => {
    setHosts(null);
    load();
    if (!live) return;
    const t = setInterval(load, NETWORK_EVERY);
    return () => clearInterval(t);
  }, [load, live]);
  return (
    <div className="blk">
      <h5>
        Network this session
        <button type="button" className="icon-btn" onClick={load} title="Refresh from openshell logs" aria-label="Refresh network">
          ↻
        </button>
      </h5>
      {error && <p className="no">{error}</p>}
      {hosts && !hosts.length && !error && <p className="muted">No connections yet.</p>}
      {hosts && hosts.length > 0 && (
        <ul className="rows">
          {hosts.map((h) => (
            <li key={h.host} title={`${h.binaries.join(", ")}`}>
              <span>{h.host}</span>
              <span>
                {h.allowed > 0 && <span className="yes">allowed · {h.allowed}</span>}
                {h.allowed > 0 && h.denied > 0 && " "}
                {h.denied > 0 && <span className="no">denied · {h.denied}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {hosts?.some((h) => h.denied) && (
        <p className="muted">Denied hosts are blocked by the sandbox policy. The console doesn't change network rules.</p>
      )}
    </div>
  );
}

function Past({ view }: { view: SessionView }) {
  const [list, setList] = useState<PastSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const show = async () => {
    setError(null);
    try {
      const r = (await store.request({ type: "list_past_sessions", sessionId: view.info.sessionId })) as Extract<
        ServerMessage,
        { type: "past_sessions" }
      >;
      setList(r.sessions);
      if (r.error) setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = async (id: string) => {
    setBusy(id);
    try {
      await store.request({ type: "open_session", sandbox: view.info.sandbox, agent: view.info.agent, cwd: view.info.cwd, loadSessionId: id });
      setList(null);
    } catch (e) {
      setError((e as RequestError).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="blk">
      <h5>Earlier threads</h5>
      {!list && (
        <button type="button" className="btn small" style={{ justifySelf: "start" }} onClick={show}>
          Show earlier threads
        </button>
      )}
      {list && !list.length && <p className="muted">None in {view.info.cwd}.</p>}
      {list && list.length > 0 && (
        <ul className="rows past">
          {list.slice(0, 30).map((p) => (
            <li key={p.sessionId}>
              <span title={p.sessionId}>{p.title || shortId(p.sessionId)}</span>
              <button type="button" className="btn small" disabled={!!busy || view.info.state === "working"} onClick={() => open(p.sessionId)}>
                {busy === p.sessionId ? "Opening…" : p.updatedAt ? ago(Date.parse(p.updatedAt)) : "Open"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="no">{error}</p>}
    </div>
  );
}

export function Inspector() {
  const selected = useStore((s) => s.selected);
  const agents = useStore((s) => s.agents);
  const sb = useStore((s) => s.sandboxes.find((x) => x.name === s.selected));
  const view = useStore((s) => (s.selected && s.bySandbox[s.selected] ? s.sessions[s.bySandbox[s.selected]] : undefined));
  // The bundle status belongs to the session it was made for.
  const [bundleFor, setBundleFor] = useState<(BundleStatus & { sessionId: string }) | null>(null);
  const bundle = bundleFor && bundleFor.sessionId === view?.info.sessionId ? bundleFor : null;
  const [closing, setClosing] = useState(false);

  if (!selected || (!sb && !view)) {
    return (
      <aside className="pane inspect">
        <div className="pane-head">
          <h3>Session</h3>
        </div>
      </aside>
    );
  }

  const info = view?.info;
  const st = sb ? sandboxStatus(sb, agents) : null;
  const pill = info?.state === "dead" ? { pill: "Exited", tone: "bad" } : (st ?? { pill: "–", tone: "idle" });
  const files = view ? Object.values(view.conv.files) : [];
  const alive = !!info && info.state !== "dead";

  return (
    <aside className="pane inspect">
      <div className="pane-head">
        <h3>Session</h3>
        <span className={`pill ${pill.tone}`}>{pill.pill}</span>
      </div>
      <div className="scroll">
        <div className="blk">
          <h5>Details</h5>
          <dl className="kv">
            {info ? (
              <>
                <dt>Agent</dt>
                <dd title={info.agentCmd.join(" ")}>{info.agentCmd.join(" ")}</dd>
                <dt>Directory</dt>
                <dd title={info.cwd}>{info.cwd}</dd>
                <dt>Session</dt>
                <dd title={info.sessionId}>{shortId(info.sessionId)}</dd>
                {info.usage?.used !== undefined && (
                  <>
                    <dt>Context</dt>
                    <dd title={`${info.usage.used} of ${info.usage.size} tokens`}>
                      {tokens(info.usage.used)} / {tokens(info.usage.size)}
                    </dd>
                  </>
                )}
                {info.usage?.totals && (
                  <>
                    <dt>Tokens</dt>
                    <dd title={`in ${info.usage.totals.inputTokens}, out ${info.usage.totals.outputTokens}`}>
                      {tokens(info.usage.totals.totalTokens)}
                    </dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt>Phase</dt>
                <dd>{sb?.phase}</dd>
                <dt>Created</dt>
                <dd>{sb?.created}</dd>
              </>
            )}
          </dl>
        </div>

        {view && (
          <div className="blk">
            <h5>Files changed</h5>
            {!files.length && <p className="muted">None yet.</p>}
            {files.length > 0 && (
              <ul className="rows">
                {files.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className="linklike"
                      title={f.path}
                      onClick={() => document.getElementById(`tool-${f.toolId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                    >
                      {relPath(f.path, view.info.cwd)}
                    </button>
                    {f.counted ? (
                      <span>
                        {f.added > 0 && <span className="add">+{f.added}</span>} {f.removed > 0 && <span className="del">−{f.removed}</span>}
                        {!f.added && !f.removed && <span className="muted">±0</span>}
                      </span>
                    ) : (
                      <span className="muted">edited</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {alive && (
              <button
                type="button"
                className="btn"
                style={{ justifySelf: "start" }}
                disabled={bundle?.tone === "busy"}
                onClick={() => downloadBundle(view.info.sessionId, undefined, (b) => setBundleFor({ ...b, sessionId: view.info.sessionId }))}
                title={`Bundle the commits of the current branch in ${view.info.cwd}`}
              >
                {bundle?.tone === "busy" ? "Bundling…" : "Download as git bundle"}
              </button>
            )}
            {bundle && bundle.tone !== "busy" && <p className={bundle.tone === "error" ? "no" : "muted"}>{bundle.text}</p>}
          </div>
        )}

        {view && <Network sessionId={view.info.sessionId} live={alive} />}

        {view && (
          <div className="blk">
            <h5>Approvals</h5>
            <p className="muted">
              The agent decides what to ask about and the console never answers for you. Nothing runs on this machine: the console gives the agent no
              file or terminal access here.
            </p>
            {view.conv.always.length > 0 && (
              <>
                <p className="muted">Always allowed this session (remembered by the agent):</p>
                <ul className="rows">
                  {view.conv.always.map((a, i) => (
                    // Append-only list of strings that may repeat; position is the identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    <li key={i}>
                      <span title={a}>{a}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {view && alive && view.info.canList && <Past key={view.info.sessionId} view={view} />}

        {sb && <Repos sb={sb} />}

        <div className="blk">
          <h5>Sandbox</h5>
          {info && alive && (
            <button
              type="button"
              className="btn small"
              style={{ justifySelf: "start" }}
              disabled={closing}
              onClick={() => {
                setClosing(true);
                store.send({ type: "close_session", sessionId: info.sessionId });
                setTimeout(() => setClosing(false), 4000);
              }}
            >
              Stop the agent process
            </button>
          )}
          <span style={{ justifySelf: "start" }}>
            <DeleteSandbox name={selected} />
          </span>
        </div>
      </div>
    </aside>
  );
}
