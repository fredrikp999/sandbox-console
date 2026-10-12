// "Open in VS Code": a Remote-SSH window on a folder of the sandbox, started by
// the bridge on this machine.
import { useState } from "react";
import type { EditorId, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { type RequestError, store, useStore } from "../store.ts";

type Opened = Extract<ServerMessage, { type: "editor_opened" }>;

export function OpenEditor({ sb, cwd }: { sb: SandboxRow; cwd?: string }) {
  const editors = useStore((s) => s.editors);
  // Linked repositories first: that's usually what you want to look at.
  const folders = [...new Set([...sb.repos.map((r) => r.sandboxPath), cwd, sb.cwd, "/sandbox"].filter((f): f is string => !!f))];
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; lines: string[]; hint?: string } | null>(null);
  const [needsSetting, setNeedsSetting] = useState<EditorId | null>(null);
  const chosen = folder && folders.includes(folder) ? folder : folders[0];

  if (!editors.length) {
    return <p className="muted">Install VS Code's `code` command (Shell Command: Install 'code' command in PATH) to open the sandbox in VS Code.</p>;
  }

  const open = async (editor: EditorId) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await store.request<Opened>({ type: "open_editor", sandbox: sb.name, editor, folder: chosen });
      setMsg({ tone: "ok", lines: r.log });
      setNeedsSetting(r.needsSetting ? editor : null);
    } catch (e) {
      const err = e as RequestError;
      setMsg({ tone: "error", lines: [err.message, ...(err.detail ? [err.detail] : [])], hint: err.hint });
    } finally {
      setBusy(false);
    }
  };

  const addSetting = async (editor: EditorId) => {
    try {
      await store.request({ type: "editor_setting", editor });
      setNeedsSetting(null);
      setMsg((m) => ({ tone: "ok", lines: [...(m?.lines ?? []), "Added remote.SSH.localServerDownload to your settings."] }));
    } catch (e) {
      setMsg({ tone: "error", lines: [(e as RequestError).message], hint: (e as RequestError).hint });
    }
  };

  const label = editors.find((e) => e.id === needsSetting)?.label;
  return (
    <div className="editor-open">
      {folders.length > 1 && (
        <select className="opt" value={chosen} onChange={(e) => setFolder(e.target.value)} aria-label="Folder to open" disabled={busy}>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}
      <div className="repo-acts">
        {editors.map((e) => (
          <button
            key={e.id}
            type="button"
            className="btn small"
            disabled={busy || sb.phase !== "Ready"}
            onClick={() => open(e.id)}
            title={`Open ${chosen} in ${e.label} over SSH through the gateway`}
          >
            {busy ? "Opening…" : `Open in ${e.label}`}
          </button>
        ))}
      </div>
      {msg && (
        <div className={msg.tone === "error" ? "repo-out err" : "repo-out"} role="status">
          {msg.lines.map((l) => (
            <div key={l} className={l.startsWith("warning:") ? "warn-line" : undefined}>
              {l}
            </div>
          ))}
          {msg.hint && <div className="hint">{msg.hint}</div>}
        </div>
      )}
      {needsSetting && (
        <div className="repo-out">
          <div className="warn-line">
            {label} isn't set to download its server on this machine. The sandbox can't reach Microsoft's servers, so the first connect will likely
            fail without <span className="mono">"remote.SSH.localServerDownload": "always"</span>.
          </div>
          <button type="button" className="btn small" style={{ justifySelf: "start" }} onClick={() => addSetting(needsSetting)}>
            Add it to {label}'s settings
          </button>
        </div>
      )}
    </div>
  );
}
