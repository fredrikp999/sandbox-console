// Files in and out of a sandbox, over the bridge's /api/file and /api/upload. The
// bytes are fetched with the access token in a header (never in the address), then
// handed to the browser as a download or shown from a local copy.
import { authHeaders } from "./auth.ts";

export type PreviewKind = "image" | "video" | "audio" | "text";

const KINDS: [PreviewKind, string[]][] = [
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "svg"]],
  ["video", ["mp4", "m4v", "webm", "mov"]],
  ["audio", ["mp3", "wav", "ogg", "m4a", "flac"]],
  ["text", ["txt", "md", "json", "log", "csv", "yaml", "yml", "toml", "ts", "tsx", "js", "mjs", "css", "html", "xml", "py", "sh"]],
];

/** What a file can be shown as, going by its extension. */
export function previewKind(name: string): PreviewKind | null {
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return KINDS.find(([, exts]) => exts.includes(ext))?.[0] ?? null;
}

/** Bigger than this isn't fetched just to look at (video and audio, then text). */
export const PREVIEW_LIMIT: Record<PreviewKind, number> = { image: 40_000_000, video: 250_000_000, audio: 100_000_000, text: 2_000_000 };

export function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

export class FileError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

async function failure(r: Response): Promise<FileError> {
  try {
    const j = await r.json();
    return new FileError(j.message ?? `${r.status} ${r.statusText}`, r.status, j.detail, j.hint);
  } catch {
    return new FileError(`${r.status} ${r.statusText}`, r.status);
  }
}

export async function fetchFile(sandbox: string, path: string): Promise<{ blob: Blob; name: string }> {
  const r = await fetch(`/api/file?${new URLSearchParams({ sandbox, path })}`, { headers: authHeaders() });
  if (!r.ok) throw await failure(r);
  const header = r.headers.get("X-File-Name") ?? "";
  let name = path.split("/").pop() || "file";
  try {
    name = decodeURIComponent(header) || name;
  } catch {
    /* keep the path's name */
  }
  return { blob: await r.blob(), name };
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function uploadFile(sandbox: string, dir: string, file: File, overwrite: boolean): Promise<void> {
  const q = new URLSearchParams({ sandbox, dir, name: file.name });
  if (overwrite) q.set("overwrite", "1");
  const r = await fetch(`/api/upload?${q}`, { method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/octet-stream" }, body: file });
  if (!r.ok) throw await failure(r);
}
