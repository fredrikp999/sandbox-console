// "Files" tab of the inspector: browse /sandbox, look at an image, video, audio or
// text file, download a file (or a folder as .tar), and upload files by choosing
// or dropping them. The sandbox's only way out used to be a git bundle; this is
// for everything else, like a rendered video.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, SandboxRow, ServerMessage } from "../../../shared/protocol.ts";
import { bytes, type FileError, fetchFile, PREVIEW_LIMIT, type PreviewKind, previewKind, saveBlob, uploadFile } from "../files.ts";
import { ago } from "../format.ts";
import { type RequestError, store } from "../store.ts";

type Reply = Extract<ServerMessage, { type: "files" }>;
type Sort = "name" | "new";
const ROOT = "/sandbox";

/** Where each sandbox was last looked at, for coming back to the tab. */
const lastPath = new Map<string, string>();

interface Preview {
  entry: FileEntry;
  path: string;
  kind: PreviewKind;
  url?: string;
  text?: string;
  error?: string;
}

const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const segments = (path: string) => path.split("/").filter(Boolean);

function Crumbs({ path, go }: { path: string; go: (p: string) => void }) {
  const parts = segments(path);
  return (
    <nav className="crumbs" aria-label="Folder">
      {parts.map((seg, i) => {
        const to = `/${parts.slice(0, i + 1).join("/")}`;
        const last = i === parts.length - 1;
        return (
          <span key={to} className="crumb">
            {i > 0 && <span className="muted"> / </span>}
            {last ? (
              <b className="mono">{seg}</b>
            ) : (
              <button type="button" className="linklike mono" onClick={() => go(to)} disabled={to.length < ROOT.length}>
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export function Files({ sb, startPath }: { sb: SandboxRow; startPath: string }) {
  const [path, setPath] = useState(() => lastPath.get(sb.name) ?? startPath);
  const [data, setData] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [sort, setSort] = useState<Sort>("name");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string; hint?: string } | null>(null);
  const [conflict, setConflict] = useState<File[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const ready = sb.phase === "Ready";

  const load = useCallback(
    async (p: string) => {
      if (!ready) return;
      setLoading(true);
      setError(null);
      try {
        setData(await store.request<Reply>({ type: "files", sandbox: sb.name, path: p }));
        lastPath.set(sb.name, p);
      } catch (e) {
        const err = e as RequestError;
        setError([err.message, err.detail].filter(Boolean).join(": "));
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [sb.name, ready],
  );

  // The sandbox changed, or you moved: look at that folder.
  useEffect(() => {
    setStatus(null);
    setConflict(null);
    load(path);
  }, [load, path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the sandbox changes, not when the thread's directory does
  useEffect(() => {
    setPath(lastPath.get(sb.name) ?? startPath);
  }, [sb.name]);

  const fail = (e: unknown) => {
    const err = e as FileError;
    setStatus({ tone: "error", text: err.message, hint: err.hint ?? err.detail });
  };

  const download = async (entry: FileEntry) => {
    setBusy(entry.name);
    setStatus(null);
    try {
      const { blob, name } = await fetchFile(sb.name, join(path, entry.name));
      saveBlob(blob, name);
      setStatus({ tone: "ok", text: `Saved ${name} (${bytes(blob.size)}).` });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const open = async (entry: FileEntry) => {
    if (entry.kind === "dir") return setPath(join(path, entry.name));
    const kind = previewKind(entry.name);
    if (!kind || entry.size > PREVIEW_LIMIT[kind]) return download(entry);
    const full = join(path, entry.name);
    setPreview({ entry, path: full, kind });
    try {
      const { blob } = await fetchFile(sb.name, full);
      setPreview((p) => (p?.path === full ? { ...p, ...(kind === "text" ? { text: undefined } : { url: URL.createObjectURL(blob) }) } : p));
      if (kind === "text") {
        const text = await blob.text();
        setPreview((p) =>
          p?.path === full
            ? { ...p, text: text.length > 100_000 ? `${text.slice(0, 100_000)}\n\n… (cut short; download it for the rest)` : text }
            : p,
        );
      }
    } catch (e) {
      setPreview((p) => (p?.path === full ? { ...p, error: (e as Error).message } : p));
    }
  };

  const closePreview = useCallback(() => {
    setPreview((p) => {
      if (p?.url) URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);
  useEffect(() => {
    if (!preview) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closePreview();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [preview, closePreview]);

  /** Upload files one by one; one that exists asks first (the rest go on). */
  const send = async (list: File[], overwrite = false) => {
    if (!list.length) return;
    setStatus(null);
    const exists: File[] = [];
    let done = 0;
    for (const f of list) {
      setBusy(`up:${f.name}`);
      try {
        await uploadFile(sb.name, path, f, overwrite);
        done++;
      } catch (e) {
        if ((e as FileError).status === 409) exists.push(f);
        else {
          fail(e);
          break;
        }
      }
    }
    setBusy(null);
    if (done) setStatus({ tone: "ok", text: `Uploaded ${done} file${done === 1 ? "" : "s"} to ${path}.` });
    setConflict(exists.length ? exists : null);
    if (done) load(path);
  };

  const entries = (data?.entries ?? [])
    .filter((e) => hidden || !e.name.startsWith("."))
    .sort((a, b) =>
      (a.kind === "dir") !== (b.kind === "dir")
        ? a.kind === "dir"
          ? -1
          : 1
        : sort === "new"
          ? b.mtime - a.mtime
          : a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  const hiddenCount = (data?.entries ?? []).filter((e) => e.name.startsWith(".")).length;
  const atRoot = path === ROOT;

  if (!ready)
    return (
      <p className="muted pad">
        {sb.name} is {sb.phase}. Its files are here when it's Ready.
      </p>
    );

  return (
    <>
      <div className="blk files-head">
        <div className="files-bar">
          <Crumbs path={path} go={setPath} />
          <span className="files-tools">
            <button type="button" className="icon-btn" onClick={() => load(path)} disabled={loading} title="Look again" aria-label="Refresh">
              ↻
            </button>
          </span>
        </div>
        <div className="files-bar">
          <button type="button" className="btn small" onClick={() => pick.current?.click()} disabled={!!busy} title={`Upload into ${path}`}>
            Upload…
          </button>
          <input
            ref={pick}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              send([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <span className="files-tools">
            <select className="opt" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="name">By name</option>
              <option value="new">Newest first</option>
            </select>
            {hiddenCount > 0 && (
              <label className="check">
                <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden ({hiddenCount})
              </label>
            )}
          </span>
        </div>
        {error && <p className="no">{error}</p>}
        {status && (
          <div className={status.tone === "error" ? "repo-out err" : "repo-out"} role="status">
            <div>{status.text}</div>
            {status.hint && <div className="hint">{status.hint}</div>}
          </div>
        )}
        {conflict && (
          <div className="repo-out" role="alert">
            <div className="warn-line">
              {conflict.map((f) => f.name).join(", ")} already exist{conflict.length === 1 ? "s" : ""} here.
            </div>
            <span className="rule-acts">
              <button type="button" className="btn small primary" onClick={() => send(conflict, true)} disabled={!!busy}>
                Replace
              </button>
              <button type="button" className="btn small" onClick={() => setConflict(null)}>
                Skip
              </button>
            </span>
          </div>
        )}
      </div>

      {/* A drop target for files to upload into this folder. */}
      {/** biome-ignore lint/a11y/noStaticElementInteractions: dropping files has the Upload button as its keyboard route */}
      <div
        className={`files-list${over ? " over" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          send([...e.dataTransfer.files]);
        }}
      >
        {!atRoot && (
          <button type="button" className="file-row up" onClick={() => setPath(path.slice(0, path.lastIndexOf("/")) || ROOT)}>
            <span className="file-name">
              <span className="file-icon">↰</span> <span className="mono">..</span>
            </span>
          </button>
        )}
        {data && !entries.length && (
          <p className="muted pad">{data.entries.length ? "Only hidden files here." : "Empty. Drop files here to upload them."}</p>
        )}
        {!data && loading && <p className="muted pad">Looking…</p>}
        {entries.map((e) => (
          <div key={e.name} className="file-row">
            <button
              type="button"
              className="file-name"
              onClick={() => open(e)}
              title={e.kind === "dir" ? "Open the folder" : previewKind(e.name) ? "Look at it" : "Download it"}
            >
              <span className="file-icon" aria-hidden="true">
                {e.kind === "dir" ? "▸" : previewKind(e.name) === "image" ? "▣" : previewKind(e.name) === "video" ? "▶" : "·"}
              </span>
              <span className="mono file-text">
                <bdi>{e.name}</bdi>
              </span>
            </button>
            <span className="file-meta" title={new Date(e.mtime * 1000).toLocaleString()}>
              {e.kind === "dir" ? "" : bytes(e.size)} · {ago(e.mtime * 1000)}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => download(e)}
              disabled={!!busy || e.kind === "other"}
              title={e.kind === "dir" ? "Download as a .tar" : "Download"}
              aria-label={`Download ${e.name}`}
            >
              {busy === e.name ? "…" : "↓"}
            </button>
          </div>
        ))}
        {data?.truncated && <p className="muted pad">Only the first 2000 are shown.</p>}
      </div>
      <p className="muted pad small">Files under /sandbox only. Drop files on the list to upload them here.</p>

      {preview && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes it; this is the backdrop click
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && closePreview()}>
          <div className="modal preview" role="dialog" aria-label={preview.entry.name}>
            <div className="review-head">
              <h3 className="mono">
                <bdi>{preview.entry.name}</bdi>
              </h3>
              <span className="muted">{bytes(preview.entry.size)}</span>
            </div>
            <div className="preview-body">
              {preview.error ? (
                <p className="no">{preview.error}</p>
              ) : preview.kind === "text" ? (
                <pre className="cat-preview">{preview.text ?? "Loading…"}</pre>
              ) : !preview.url ? (
                <p className="muted">Loading {bytes(preview.entry.size)}…</p>
              ) : preview.kind === "image" ? (
                <img src={preview.url} alt={preview.entry.name} />
              ) : preview.kind === "video" ? (
                // biome-ignore lint/a11y/useMediaCaption: a file from the sandbox has no captions
                <video src={preview.url} controls autoPlay />
              ) : (
                // biome-ignore lint/a11y/useMediaCaption: a file from the sandbox has no captions
                <audio src={preview.url} controls autoPlay />
              )}
            </div>
            <div className="acts">
              <button type="button" className="btn" onClick={() => download(preview.entry)} disabled={!!busy}>
                Download
              </button>
              <button type="button" className="btn primary" onClick={closePreview}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
