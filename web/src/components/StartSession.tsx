// Shown for a sandbox without an open session: start the agent, or explain
// why the sandbox can't be used yet.
import { useEffect, useState } from "react";
import type { SandboxRow } from "../../../shared/protocol.ts";
import { agentLabel } from "../format.ts";
import { type RequestError, store, useStore } from "../store.ts";

export function DeleteSandbox({ name }: { name: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    try {
      await store.request({ type: "delete_sandbox", name });
      store.select(null);
    } catch (e) {
      setError((e as RequestError).detail || (e as Error).message);
      setBusy(false);
      setArmed(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`btn danger small${armed ? " armed" : ""}`}
        onClick={del}
        onBlur={() => !busy && setArmed(false)}
        disabled={busy}
      >
        {busy ? "Deleting…" : armed ? `Delete ${name} and its files` : "Delete sandbox…"}
      </button>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

/** `resume`: the shown thread has ended. `resumeId`: the agent can load it again, so offer that. */
export function StartSession({ sb, resume, resumeId }: { sb: SandboxRow; resume?: boolean; resumeId?: string }) {
  const agents = useStore((s) => s.agents);
  const [agent, setAgent] = useState(sb.agent ?? "");
  const [cwd, setCwd] = useState(sb.cwd ?? "/sandbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const starting = busy || sb.session?.state === "starting";
  // Detection can finish after the panel is shown.
  useEffect(() => {
    if (!agent && sb.agent) setAgent(sb.agent);
  }, [agent, sb.agent]);

  if (sb.phase !== "Ready") {
    return (
      <div className="empty">
        <b>
          {sb.name} is {sb.phase}
        </b>
        <span>{sb.message ?? (sb.phase === "Error" ? "OpenShell reports an error for this sandbox." : "Wait until it is Ready.")}</span>
        {sb.phase === "Error" && (
          <span>
            Delete it and create it again (its files are lost), or check it with <span className="mono">openshell sandbox get {sb.name}</span>.
          </span>
        )}
        <DeleteSandbox name={sb.name} />
      </div>
    );
  }

  const start = async (e: React.FormEvent, loadSessionId?: string) => {
    e.preventDefault();
    if (!agent) return;
    setBusy(true);
    setError(null);
    if (agent !== sb.agent) store.send({ type: "set_sandbox_agent", name: sb.name, agent });
    try {
      await store.request({ type: "open_session", sandbox: sb.name, agent, cwd, loadSessionId });
    } catch (err) {
      setError(err as RequestError);
    } finally {
      setBusy(false);
    }
  };

  const known = sb.agentSource === "policy" || sb.agentSource === "remembered";
  const cmd = agents.find((a) => a.id === agent)?.cmd.join(" ");
  return (
    <div className="empty">
      <b>{resumeId ? "This thread has ended" : resume ? "Start a new session" : "No session open"}</b>
      <span>
        {starting ? (
          `Starting ${agentLabel(agents, agent)} in ${sb.name}…`
        ) : resumeId ? (
          "The conversation above is saved. Resume it to continue where it left off, or start a new thread."
        ) : (
          <>
            Start the agent in this sandbox. The console runs <span className="mono">{cmd ?? "the agent"}</span> through the gateway.
          </>
        )}
      </span>
      <form className="form" onSubmit={(e) => start(e)}>
        <label>
          {known ? "Agent" : "Which agent is in this sandbox?"}
          <select value={agent} onChange={(e) => setAgent(e.target.value)} disabled={starting} required>
            {!agent && <option value="">Choose…</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Working directory
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={starting} spellCheck={false} />
        </label>
        {error && (
          <div className="err" role="alert" style={{ maxWidth: "100%" }}>
            <b>{error.message}</b>
            {error.hint && <div className="hint">{error.hint}</div>}
            {error.detail && <pre>{error.detail}</pre>}
          </div>
        )}
        <div className="acts">
          {resumeId && (
            <button type="button" className="btn primary" disabled={starting || !agent} onClick={(e) => start(e, resumeId)}>
              {starting ? "Starting…" : "Resume thread"}
            </button>
          )}
          <button type="submit" className={`btn${resumeId ? "" : " primary"}`} disabled={starting || !agent}>
            {starting ? "Starting…" : resumeId ? "New thread" : "Start session"}
          </button>
        </div>
      </form>
    </div>
  );
}
