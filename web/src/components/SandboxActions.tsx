// The sandbox's actions, in the chat header next to its name: open a folder of it
// in VS Code (or Cursor), and a menu with the rare ones (stop the agent, delete).
import { useCallback, useState } from "react";
import type { EditorId, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { type RequestError, store, useStore } from "../store.ts";
import { Popover } from "./Popover.tsx";

type Opened = Extract<ServerMessage, { type: "editor_opened" }>;
type Outcome = { tone: "ok" | "error"; lines: string[]; hint?: string };

/** Linked repositories first: usually what you want to look at. */
export function editorFolders(sb: SandboxRow, cwd?: string): string[] {
  return [...new Set([...sb.repos.map((r) => r.sandboxPath), cwd, sb.cwd, "/sandbox"].filter((f): f is string => !!f))];
}

function OpenInEditor({ sb, cwd }: { sb: SandboxRow; cwd?: string }) {
  const editors = useStore((s) => s.editors);
  const folders = editorFolders(sb, cwd);
  const [folder, setFolder] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorId | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [needsSetting, setNeedsSetting] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const chosen = folder && folders.includes(folder) ? folder : folders[0];
  const ed = editors.find((e) => e.id === editor) ?? editors[0];
  if (!ed) return null;

  const go = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await store.request<Opened>({ type: "open_editor", sandbox: sb.name, editor: ed.id, folder: chosen });
      setNeedsSetting(r.needsSetting);
      const warned = r.needsSetting || r.log.some((l) => l.startsWith("warning:"));
      setOutcome({ tone: "ok", lines: r.log });
      // Only stay in the way when there's something to act on.
      setOpen(warned);
    } catch (e) {
      const err = e as RequestError;
      setOutcome({ tone: "error", lines: [err.message, ...(err.detail ? [err.detail] : [])], hint: err.hint });
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const addSetting = async () => {
    try {
      await store.request({ type: "editor_setting", editor: ed.id });
      setNeedsSetting(false);
      setOutcome((o) => ({ tone: "ok", lines: [...(o?.lines ?? []), `Added remote.SSH.localServerDownload to ${ed.label}'s settings.`] }));
    } catch (e) {
      setOutcome({ tone: "error", lines: [(e as RequestError).message], hint: (e as RequestError).hint });
    }
  };

  return (
    <Popover
      open={open}
      onClose={close}
      label={`Open in ${ed.label}`}
      anchor={
        <div className="split">
          <button
            type="button"
            className="btn small"
            onClick={go}
            disabled={busy || sb.phase !== "Ready"}
            title={`Open ${chosen} in ${ed.label} (Remote-SSH through the gateway)`}
          >
            {busy ? "Opening…" : `Open in ${ed.label}`}
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => setOpen((o) => !o)}
            aria-label="Choose folder and editor"
            aria-expanded={open}
            disabled={busy}
          >
            ▾
          </button>
        </div>
      }
    >
      <div className="pop-sec">
        <div className="pop-label">Folder</div>
        {folders.map((f) => (
          <label key={f} className="pop-choice">
            <input type="radio" name={`folder-${sb.name}`} checked={f === chosen} onChange={() => setFolder(f)} />
            <span className="mono">{f}</span>
          </label>
        ))}
      </div>
      {editors.length > 1 && (
        <div className="pop-sec">
          <div className="pop-label">Editor</div>
          {editors.map((e) => (
            <label key={e.id} className="pop-choice">
              <input type="radio" name={`editor-${sb.name}`} checked={e.id === ed.id} onChange={() => setEditor(e.id)} />
              <span>{e.label}</span>
            </label>
          ))}
        </div>
      )}
      {outcome && (
        <div className={outcome.tone === "error" ? "repo-out err" : "repo-out"} role="status">
          {outcome.lines.map((l) => (
            <div key={l} className={l.startsWith("warning:") ? "warn-line" : undefined}>
              {l}
            </div>
          ))}
          {outcome.hint && <div className="hint">{outcome.hint}</div>}
        </div>
      )}
      {needsSetting && (
        <div className="repo-out">
          <div className="warn-line">
            The sandbox can't download {ed.label} Server, so the first connect will likely fail without{" "}
            <span className="mono">"remote.SSH.localServerDownload": "always"</span> in {ed.label}'s settings.
          </div>
          <button type="button" className="btn small" style={{ justifySelf: "start" }} onClick={addSetting}>
            Add the setting
          </button>
        </div>
      )}
      <div className="pop-acts">
        <button type="button" className="btn small primary" onClick={go} disabled={busy || sb.phase !== "Ready"}>
          {busy ? "Opening…" : `Open ${chosen}`}
        </button>
      </div>
    </Popover>
  );
}

function MoreMenu({ sb, sessionId, alive }: { sb: SandboxRow; sessionId?: string; alive: boolean }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setArmed(false);
  }, []);

  const stop = () => {
    if (!sessionId) return;
    store.send({ type: "close_session", sessionId });
    close();
  };
  const del = async () => {
    if (!armed) return setArmed(true);
    setBusy("Deleting…");
    try {
      await store.request({ type: "delete_sandbox", name: sb.name });
      store.select(null);
    } catch (e) {
      setError((e as RequestError).detail || (e as Error).message);
      setArmed(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover
      open={open}
      onClose={close}
      label={`${sb.name} actions`}
      anchor={
        <button type="button" className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="More actions" aria-expanded={open}>
          ⋯
        </button>
      }
    >
      <div className="pop-menu">
        {alive && (
          <button type="button" className="pop-item" onClick={stop} title="Stops the agent and all its threads; their conversations are kept">
            Stop the agent
          </button>
        )}
        <button type="button" className={`pop-item danger${armed ? " armed" : ""}`} onClick={del} disabled={!!busy}>
          {busy ?? (armed ? `Delete ${sb.name} and its files?` : "Delete sandbox…")}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </Popover>
  );
}

export function SandboxActions({ sb, sessionId, cwd, alive }: { sb: SandboxRow; sessionId?: string; cwd?: string; alive: boolean }) {
  return (
    <div className="sb-actions">
      <OpenInEditor sb={sb} cwd={cwd} />
      <MoreMenu sb={sb} sessionId={sessionId} alive={alive} />
    </div>
  );
}
