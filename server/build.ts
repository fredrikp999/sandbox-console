// Which version of the console's code is running, compared with what is on disk,
// so the UI can say "restart the console" after an update (otherwise the page
// is new and the server old, and the new buttons fail in confusing ways).
//
// - `protocolHash` is a hash of shared/protocol.ts. The page has the hash of the
//   one it was built with, the server the one it loaded; if they differ, the two
//   speak different messages.
// - `codeHash` is a hash of the server's own files. The server takes it at start-up
//   and again every few seconds; a change means the code on disk is newer than the
//   code running.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export function protocolHash(root = ROOT_DIR): string {
  return createHash("sha256")
    .update(readFileSync(join(root, "shared", "protocol.ts")))
    .digest("hex")
    .slice(0, 12);
}

/** The files whose change means a restart is needed: the server and the protocol, not tests. */
export function watchedFiles(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    for (const dir of [join(root, "server"), join(root, "shared")]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names.sort()) {
        if (/\.(ts|json)$/.test(n) && !n.endsWith(".test.ts")) out.push(join(dir, n));
      }
    }
  }
  return out;
}

export function codeHash(roots: string[] = [ROOT_DIR]): string {
  const h = createHash("sha256");
  for (const f of watchedFiles(roots)) {
    try {
      h.update(f).update("\0").update(readFileSync(f)).update("\0");
    } catch {
      /* removed while reading: the next check sees it */
    }
  }
  return h.digest("hex").slice(0, 12);
}
