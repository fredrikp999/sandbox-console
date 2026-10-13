// Right column, about the code: "Changes" (the repository workflow and the files
// this thread edited), "Files" (browse, download and upload), "Catalog" (agents,
// skills, context and tools to add to the sandbox) and "Activity" (network, the
// rules waiting for your decision, and approvals). Sandbox actions live in the
// chat header; threads in the tabs and the sidebar.
import { useCallback, useEffect, useState } from "react";
import type { NetworkHost, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { type BundleStatus, downloadBundle } from "../bundle.ts";
import { relPath } from "../format.ts";
import { type SessionView, store, useStore } from "../store.ts";
import { Catalog } from "./Catalog.tsx";
import { Files } from "./Files.tsx";
import { Repos } from "./Repos.tsx";
import { Rules, type RulesState, useRules } from "./Rules.tsx";

const NETWORK_EVERY = 15_000;

/** The thread's network view, polled while its agent runs. Shared by the tab badge and the Activity tab. */
function useNetwork(sessionId: string | undefined, live: boolean) {
  const [hosts, setHosts] = useState<NetworkHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!sessionId) return;
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
    setError(null);
    load();
    if (!live) return;
    const t = setInterval(load, NETWORK_EVERY);
    return () => clearInterval(t);
  }, [load, live]);
  return { hosts, error, load };
}

function Edited({ view }: { view: SessionView }) {
  const files = Object.values(view.conv.files);
  return (
    <div className="blk">
      <h5>Edited in this thread</h5>
      {!files.length && <p className="muted">Nothing yet.</p>}
      {files.length > 0 && (
        <ul className="rows">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className="linklike"
                title={`${f.path}\nClick to jump to the edit`}
                onClick={() => document.getElementById(`tool-${f.toolId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              >
                <bdi>{relPath(f.path, view.info.cwd)}</bdi>
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
    </div>
  );
}

/** Without a linked repository: the agent's commits as a file. */
function BundleFallback({ view }: { view: SessionView }) {
  const [status, setStatus] = useState<BundleStatus | null>(null);
  return (
    <div className="blk">
      <p className="muted">
        Or, without linking a repository:{" "}
        <button
          type="button"
          className="linklike"
          disabled={status?.tone === "busy"}
          onClick={() => downloadBundle(view.info.sessionId, undefined, setStatus)}
          title={`Bundle the commits of the current branch in ${view.info.cwd}`}
        >
          {status?.tone === "busy" ? "bundling…" : "download the agent's commits as a git bundle"}
        </button>
        .
      </p>
      {status && status.tone !== "busy" && <p className={status.tone === "error" ? "no" : "muted"}>{status.text}</p>}
    </div>
  );
}

function Activity({ view, net, rules }: { view: SessionView | undefined; net: ReturnType<typeof useNetwork>; rules: RulesState }) {
  const { hosts, error, load } = net;
  const proposed = new Set(rules.rules.flatMap((r) => r.endpoints.map((e) => e.host)));
  return (
    <>
      <Rules state={rules} />
      {!view && <p className="muted pad">Start a session to see what the agent reaches and what it was allowed.</p>}
      {view && (
        <>
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
                  <li key={h.host} title={h.binaries.join(", ")}>
                    <span>{h.host}</span>
                    <span>
                      {h.allowed > 0 && <span className="yes">allowed · {h.allowed}</span>}
                      {h.allowed > 0 && h.denied > 0 && " "}
                      {h.denied > 0 && <span className="no">denied · {h.denied}</span>}
                      {h.denied > 0 && proposed.has(h.host) && <span className="muted"> · rule proposed</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {hosts?.some((h) => h.denied) && (
              <p className="muted">Denied hosts are blocked by the sandbox policy. The console doesn't change network rules.</p>
            )}
          </div>
          <div className="blk">
            <h5>Approvals</h5>
            {view.conv.always.length > 0 ? (
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
            ) : (
              <p className="muted">Nothing is always allowed. The agent asks, and the console never answers for you.</p>
            )}
            <p className="muted">The agent has no file or terminal access on this machine; it works only inside the sandbox.</p>
          </div>
        </>
      )}
    </>
  );
}

type Tab = "changes" | "files" | "catalog" | "activity";

export function Inspector() {
  const sb: SandboxRow | undefined = useStore((s) => s.sandboxes.find((x) => x.name === s.selected));
  const view = useStore((s) => (s.selected && s.bySandbox[s.selected] ? s.sessions[s.bySandbox[s.selected]] : undefined));
  const [tab, setTab] = useState<Tab>("changes");
  const alive = !!view && view.info.state !== "dead";
  const net = useNetwork(view?.info.sessionId, alive);
  const denied = net.hosts?.reduce((n, h) => n + (h.denied ? 1 : 0), 0) ?? 0;
  // Where Files starts: the thread's directory, else the sandbox's, if it's under /sandbox.
  const startPath = [view?.info.cwd, sb?.cwd].find((p) => p === "/sandbox" || p?.startsWith("/sandbox/")) ?? "/sandbox";
  const rules = useRules(sb?.name, sb?.phase === "Ready");
  const waiting = rules.rules.length;

  return (
    <aside className="pane inspect">
      <div className="pane-head tabs" role="tablist" aria-label="Inspector">
        <button type="button" role="tab" className="itab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
          Changes
        </button>
        <button type="button" role="tab" className="itab" aria-selected={tab === "files"} onClick={() => setTab("files")}>
          Files
        </button>
        <button type="button" role="tab" className="itab" aria-selected={tab === "catalog"} onClick={() => setTab("catalog")}>
          Catalog
        </button>
        <button
          type="button"
          role="tab"
          className="itab"
          aria-selected={tab === "activity"}
          onClick={() => setTab("activity")}
          title={
            waiting
              ? `${waiting} blocked connection${waiting === 1 ? " is" : "s are"} waiting for your decision`
              : denied
                ? `${denied} host${denied === 1 ? "" : "s"} denied this session`
                : undefined
          }
        >
          Activity
          {(waiting > 0 || denied > 0) && <span className="badge bad">{waiting || denied}</span>}
        </button>
      </div>
      <div className="scroll">
        {!sb ? null : tab === "changes" ? (
          <>
            <Repos sb={sb} />
            {view && <Edited view={view} />}
            {view && alive && !sb.repos.length && <BundleFallback view={view} />}
          </>
        ) : tab === "files" ? (
          <Files sb={sb} startPath={startPath} />
        ) : tab === "catalog" ? (
          <Catalog sb={sb} />
        ) : (
          <Activity view={view} net={net} rules={rules} />
        )}
      </div>
    </aside>
  );
}
