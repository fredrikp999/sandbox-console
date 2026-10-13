// "New sandbox": a sandbox type (image + policy + agent), name, working
// directory. The bridge runs the same `openshell sandbox create` call as
// sandbox.sh. A type whose image isn't built yet can be built from here.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxType, ServerMessage } from "../../../shared/protocol.ts";
import { type RequestError, store, useStore } from "../store.ts";

type Types = Extract<ServerMessage, { type: "sandbox_types" }>;

function BuildLog({ lines, failed }: { lines: string[]; failed: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the output as it grows.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <pre ref={box} className={`build-log${failed ? " failed" : ""}`}>
      {lines.slice(-200).join("\n")}
    </pre>
  );
}

export function NewSandbox({ onClose }: { onClose: () => void }) {
  const note = useStore((s) => s.createNote);
  const build = useStore((s) => s.build);
  const [info, setInfo] = useState<Types | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [workdir, setWorkdir] = useState("/sandbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await store.request<Types>({ type: "sandbox_types" });
      setInfo(r);
      setTypeId((t) => t ?? r.types.find((x) => x.imageState !== "missing")?.id ?? r.types[0]?.id ?? null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // When a build finishes, see which images are there now.
  const buildState = build?.state;
  useEffect(() => {
    if (buildState === "done" || buildState === "failed") load();
  }, [buildState, load]);

  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  const types = info?.types ?? [];
  const chosen: SandboxType | undefined = types.find((t) => t.id === typeId);
  const building = build?.state === "running" ? build : null;
  const shownBuild = build && (build.state === "running" || build.sandboxType === typeId) ? build : null;
  const placeholder = `${chosen?.id ?? "sandbox"}-1`;
  const blocked = !chosen || chosen.imageState === "missing" || (!!building && building.sandboxType === chosen.id);

  const startBuild = async (t: SandboxType) => {
    setError(null);
    try {
      await store.request({ type: "build_image", sandboxType: t.id });
    } catch (e) {
      const r = e as RequestError;
      setError([r.message, r.hint].filter(Boolean).join("\n"));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    const n = name.trim() || placeholder;
    setBusy(true);
    setError(null);
    try {
      await store.request({ type: "create_sandbox", name: n, sandboxType: chosen.id, workdir });
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
      <form className="modal form new-sb" onSubmit={submit} aria-label="New sandbox">
        <h3>New sandbox</h3>
        <fieldset className="types">
          <legend>Type</legend>
          {!info && !loadError && <span className="note">Looking for the images…</span>}
          {loadError && <div className="form-error">{loadError}</div>}
          {types.map((t) => (
            <label key={t.id} className={`type${t.id === typeId ? " on" : ""}`}>
              <input type="radio" name="sandbox-type" checked={t.id === typeId} onChange={() => setTypeId(t.id)} />
              <span className="type-main">
                <span className="type-head">
                  <b>{t.label}</b>
                  {building?.sandboxType === t.id ? (
                    <span className="type-state busy">building…</span>
                  ) : t.imageState === "present" ? (
                    <span className="type-state ok">✓ built</span>
                  ) : t.imageState === "missing" ? (
                    <span className="type-state">not built</span>
                  ) : null}
                </span>
                {t.id === typeId && (
                  <>
                    <span className="type-desc">{t.description}</span>
                    <span className="type-meta mono">
                      {t.image} · {t.policy ? `policies/${t.policy}` : "default policy"}
                    </span>
                    {t.imageState === "missing" && t.build && (
                      <span className="type-build">
                        <button
                          type="button"
                          className="btn small"
                          disabled={!!building || !!info?.buildNote}
                          onClick={() => startBuild(t)}
                          title={info?.buildNote ?? `Runs make ${t.build} in openshell-configs on this machine`}
                        >
                          Build image
                        </button>
                        <span className="note">
                          <span className="mono">make {t.build}</span> in openshell-configs. Can take a while.
                        </span>
                      </span>
                    )}
                  </>
                )}
              </span>
            </label>
          ))}
          {info?.buildNote && <span className="note">{info.buildNote}</span>}
        </fieldset>
        {shownBuild && (
          <div className="build">
            <span className="note">
              {shownBuild.state === "running"
                ? `Building with make ${shownBuild.target}. You can close this; it keeps going.`
                : shownBuild.state === "done"
                  ? `make ${shownBuild.target} finished.`
                  : `make ${shownBuild.target} failed.`}
            </span>
            <BuildLog lines={shownBuild.lines} failed={shownBuild.state === "failed"} />
          </div>
        )}
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
          <span className="note">Where the agent starts. A repository brought in from the Changes tab goes to /sandbox/&lt;repo&gt;.</span>
        </label>
        {note && <span className="note">{note}</span>}
        {error && <div className="form-error">{error}</div>}
        <div className="acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || blocked}
            title={chosen?.imageState === "missing" ? "Build the image first" : undefined}
          >
            {busy ? "Creating…" : "Create sandbox"}
          </button>
        </div>
      </form>
    </div>
  );
}
