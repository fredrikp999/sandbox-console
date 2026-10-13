import { type ReactNode, useEffect } from "react";
import type { ServerBuild } from "../../shared/protocol.ts";
import { Chat } from "./components/Chat.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { closeOverlay, onPanelKey, usePanels } from "./panels.ts";
import { useStore } from "./store.ts";

/** What to tell when the page and the bridge are from different versions of the console. */
function versionNotice(server: ServerBuild | null): ReactNode {
  if (!server) return null;
  if (server.stale) {
    return (
      <>
        <b>The console was updated.</b> Restart it to use the new version: press <kbd>Ctrl</kbd>+<kbd>C</kbd> where it runs, start it again with{" "}
        <span className="mono">./console.sh</span>, and open the new address. Until then, some new buttons won't work.
      </>
    );
  }
  if (server.protocol !== __PROTOCOL__) {
    return (
      <>
        <b>This page is from a different version of the console than the server.</b> Reload it (<kbd>⌘R</kbd>); if this stays, restart the console.
      </>
    );
  }
  return null;
}

export function App() {
  const link = useStore((s) => s.link);
  const waiting = useStore((s) => s.sandboxes.filter((x) => x.session?.state === "waiting").length);
  const panels = usePanels();
  const notice = versionNotice(useStore((s) => s.server));

  useEffect(() => {
    window.addEventListener("keydown", onPanelKey);
    return () => window.removeEventListener("keydown", onPanelKey);
  }, []);

  // Show in the tab title when an agent is waiting for you.
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Waiting · Sandbox Console` : "Sandbox Console";
  }, [waiting]);

  if (link === "unauthorized") {
    return (
      <div className="gate">
        <b>The console needs its access link</b>
        <span>
          The bridge was restarted, or this browser hasn't been given its token. Open the URL that <span className="mono">./console.sh</span> printed
          (it ends with <span className="mono">#token=…</span>).
        </span>
      </div>
    );
  }

  return (
    <div
      className={[
        "app",
        notice && "has-banner",
        !panels.left && "no-left",
        (panels.narrow || !panels.right) && "no-right",
        panels.over && "right-over",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {notice && (
        <div className="banner" role="status">
          {notice}
        </div>
      )}
      {panels.left && <Sidebar />}
      <Chat />
      {(panels.narrow ? panels.over : panels.right) && <Inspector />}
      {panels.over && <div className="scrim" onClick={closeOverlay} aria-hidden="true" />}
    </div>
  );
}
