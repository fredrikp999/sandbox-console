import { memo, useMemo } from "react";
import { structuredPatch } from "diff";

/** Unified diff of an ACP `diff` tool content item. */
export const DiffView = memo(function DiffView({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const hunks = useMemo(() => structuredPatch(path, path, oldText ?? "", newText ?? "", "", "", { context: 3 }).hunks, [path, oldText, newText]);
  if (!hunks.length) return <div className="note">No changes.</div>;
  return (
    <div className="diff">
      {hunks.map((h, i) => (
        <div key={i}>
          {(hunks.length > 1 || oldText) && (
            <div className="hunk">
              @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
          )}
          {h.lines.map((l, j) =>
            l.startsWith("\\") ? null : (
              <div key={j} className={`ln ${l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}`}>
                {l[0] === "-" ? "−" : l[0]}
                {l.slice(1)}
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
});
