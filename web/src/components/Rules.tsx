// Network rules OpenShell proposes after a connection was denied: what would be
// allowed, for which program, and your decision on each. Approving widens the
// sandbox, so it takes two clicks and says who else gets the access.
import { useCallback, useEffect, useState } from "react";
import type { RuleProposal, ServerMessage } from "../../../shared/protocol.ts";
import { type RequestError, store } from "../store.ts";

type Reply = Extract<ServerMessage, { type: "rules" }>;
const EVERY = 20_000;

export interface RulesState {
  rules: RuleProposal[];
  error: string | null;
  busy: string | null;
  note: string | null;
  decide: (id: string, op: "approve" | "reject") => Promise<void>;
  load: () => Promise<void>;
}

/** The sandbox's pending proposals, read now and then while the sandbox is Ready. */
export function useRules(sandbox: string | undefined, ready: boolean): RulesState {
  const [rules, setRules] = useState<RuleProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sandbox || !ready) return;
    try {
      const r = await store.request<Reply>({ type: "rules", sandbox });
      setRules(r.rules);
      setError(r.error ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sandbox, ready]);

  useEffect(() => {
    setRules([]);
    setError(null);
    setNote(null);
    load();
    if (!sandbox || !ready) return;
    const t = setInterval(load, EVERY);
    return () => clearInterval(t);
  }, [load, sandbox, ready]);

  const decide = async (id: string, op: "approve" | "reject") => {
    if (!sandbox) return;
    setBusy(id);
    setNote(null);
    setError(null);
    try {
      const r = await store.request<Reply>({ type: "rules", sandbox, op, chunkId: id });
      setRules(r.rules);
      setNote(r.log.join(" "));
    } catch (e) {
      const err = e as RequestError;
      setError([err.message, err.detail].filter(Boolean).join(": "));
    } finally {
      setBusy(null);
    }
  };
  return { rules, error, busy, note, decide, load };
}

const program = (path: string) => path.split("/").pop() || path;

function Proposal({ p, state }: { p: RuleProposal; state: RulesState }) {
  const [armed, setArmed] = useState(false);
  const target = p.endpoints.map((e) => `${e.host}:${e.port}`).join(", ") || p.rule;
  const who = p.binaries.map(program).join(", ") || "a program";
  const mine = state.busy === p.id;
  return (
    <li className="rule">
      <div className="rule-head">
        <span className="mono rule-target" title={target}>
          {target}
        </span>
        <span className="rule-meta">
          {who}
          {p.hits ? ` · ${p.hits} attempt${p.hits === 1 ? "" : "s"}` : ""}
          {p.lastSeen ? ` · last ${p.lastSeen.slice(5, 16)}` : ""}
        </span>
      </div>
      {armed ? (
        <div className="rule-confirm">
          <span>
            Let <b>{who}</b> connect to <b>{target}</b>
            {p.endpoints.some((e) => e.mode === "L4") ? " (the connection itself, not limited to certain requests)" : ""}.
            {p.shared && (
              <span className="warn-line"> {who} is a program many things run as, including the agent, so all of them get this access.</span>
            )}
          </span>
          <span className="rule-acts">
            <button type="button" className="btn small primary" disabled={!!state.busy} onClick={() => state.decide(p.id, "approve")}>
              {mine ? "…" : "Allow"}
            </button>
            <button type="button" className="btn small" disabled={!!state.busy} onClick={() => setArmed(false)}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <div className="rule-acts">
          <button type="button" className="btn small" disabled={!!state.busy} onClick={() => setArmed(true)}>
            Allow…
          </button>
          <button type="button" className="btn small" disabled={!!state.busy} onClick={() => state.decide(p.id, "reject")}>
            {mine ? "…" : "Reject"}
          </button>
        </div>
      )}
      <details className="rule-more">
        <summary>Details</summary>
        <div className="muted">{p.rationale}</div>
        {p.binaries.map((b) => (
          <div key={b} className="mono muted">
            {b}
          </div>
        ))}
        {p.confidence !== undefined && <div className="muted">OpenShell's confidence that this is what you want: {p.confidence}%</div>}
      </details>
    </li>
  );
}

export function Rules({ state }: { state: RulesState }) {
  const { rules, error, note } = state;
  return (
    <div className="blk">
      <h5>
        Waiting for your decision
        {rules.length > 0 && <span className="badge bad">{rules.length}</span>}
      </h5>
      {error && <p className="no">{error}</p>}
      {!error && !rules.length && (
        <p className="muted">No blocked connection is waiting for a rule. OpenShell proposes one when something is denied.</p>
      )}
      {rules.length > 0 && (
        <>
          <p className="muted">
            OpenShell proposes a rule for each blocked connection. Nothing is allowed until you say so, and the console never decides for you.
          </p>
          <ul className="rules">
            {rules.map((p) => (
              <Proposal key={p.id} p={p} state={state} />
            ))}
          </ul>
        </>
      )}
      {note && <p className="muted">{note}</p>}
    </div>
  );
}
