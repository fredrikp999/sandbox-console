// The access token printed by the bridge (http://127.0.0.1:<port>/#token=…).
// Kept in localStorage, which, unlike cookies, is scoped to this exact origin
// including the port, so other local servers on 127.0.0.1 never see it.
const KEY = "sandbox-console-token";

function fromUrl(): string | null {
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  const t = hash.get("token") ?? query.get("token");
  if (!t) return null;
  // Take it out of the address bar (and so out of history and screenshots).
  hash.delete("token");
  query.delete("token");
  const q = query.toString();
  const h = hash.toString();
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`);
  return t;
}

let token: string | null = null;

export function initToken() {
  const t = fromUrl();
  if (t) localStorage.setItem(KEY, t);
  token = t ?? localStorage.getItem(KEY);
}

export function getToken() {
  return token;
}

export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** WebSocket subprotocols: the bridge answers with the first; the second carries the token. */
export function wsProtocols(): string[] {
  return token ? ["sandbox-console", `token.${token}`] : ["sandbox-console"];
}
