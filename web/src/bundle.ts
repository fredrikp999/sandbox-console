import { authHeaders } from "./auth.ts";

// "Download as git bundle" / `/bundle`: the bridge bundles the agent's commits in
// the sandbox and streams the file; we hand it to the browser as a download.
export type BundleStatus = { tone: "busy" | "ok" | "error"; text: string };

export async function downloadBundle(sessionId: string, dir: string | undefined, onStatus: (s: BundleStatus) => void) {
  onStatus({ tone: "busy", text: `Bundling commits${dir ? ` in ${dir}` : ""}…` });
  const q = new URLSearchParams({ sessionId });
  if (dir) q.set("dir", dir);
  try {
    const r = await fetch(`/api/bundle?${q}`, { headers: authHeaders() });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const j = await r.json();
        msg = [j.message, j.detail, j.hint].filter(Boolean).join(" · ");
      } catch {
        msg = (await r.text().catch(() => "")) || msg;
      }
      onStatus({ tone: "error", text: msg });
      return;
    }
    const name = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "agent.bundle";
    // Percent-encoded by the bridge: branch names come from the sandbox and may not be Latin-1.
    const header = (h: string) => {
      try {
        return decodeURIComponent(r.headers.get(h) ?? "");
      } catch {
        return r.headers.get(h) ?? "";
      }
    };
    const branch = header("X-Bundle-Branch");
    const commits = r.headers.get("X-Bundle-Commits") ?? "?";
    const base = header("X-Bundle-Base");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    onStatus({
      tone: "ok",
      text: `Saved ${name}: ${commits} commit(s) on ${branch}${base ? ` since ${base}` : ""}. Review with: git fetch ${name} ${branch}:${branch}`,
    });
  } catch (e) {
    onStatus({ tone: "error", text: (e as Error).message });
  }
}
