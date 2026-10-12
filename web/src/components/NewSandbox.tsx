// "New sandbox": name, agent, working directory. The bridge runs the same
// `openshell sandbox create` call as sandbox.sh.
import { useEffect, useRef, useState } from "react";
import { type RequestError, store, useStore } from "../store.ts";

export function NewSandbox({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const note = useStore((s) => s.createNote);
  const [agent, setAgent] = useState(agents[0]?.id ?? "opencode");
  const [name, setName] = useState("");
  const [workdir, setWorkdir] = useState("/sandbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  const placeholder = `${agent}-agent1`;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim() || placeholder;
    setBusy(true);
    setError(null);
    try {
      await store.request({ type: "create_sandbox", name: n, agent, workdir });
      store.select(n);
      onClose();
    } catch (err) {
      const r = err as RequestError;
      setError([r.message, r.detail, r.hint].filter(Boolean).join("\n"));
      setBusy(false);
    }
  };

  return (
    // Clicking the backdrop closes the dialog; keyboard users have Esc (handled on window).
    // biome-ignore lint/a11y/noStaticElementInteractions: see above
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal form" onSubmit={submit} aria-label="New sandbox">
        <h3>New sandbox</h3>
        <label>
          Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            ref={first}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Working directory
          <input value={workdir} onChange={(e) => setWorkdir(e.target.value)} spellCheck={false} />
          <span className="note">Where the agent starts. Bring a repo in with bundle.sh in, which puts it at /sandbox/&lt;repo&gt;.</span>
        </label>
        {note && <span className="note">{note}</span>}
        {error && <div className="form-error">{error}</div>}
        <div className="acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Creating…" : "Create sandbox"}
          </button>
        </div>
      </form>
    </div>
  );
}
