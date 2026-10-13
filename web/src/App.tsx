import { useEffect } from "react";
import { Chat } from "./components/Chat.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { closeOverlay, onPanelKey, usePanels } from "./panels.ts";
import { useStore } from "./store.ts";

export function App() {
  const link = useStore((s) => s.link);
  const waiting = useStore((s) => s.sandboxes.filter((x) => x.session?.state === "waiting").length);
  const panels = usePanels();

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
      className={["app", !panels.left && "no-left", (panels.narrow || !panels.right) && "no-right", panels.over && "right-over"]
        .filter(Boolean)
        .join(" ")}
    >
      {panels.left && <Sidebar />}
      <Chat />
      {(panels.narrow ? panels.over : panels.right) && <Inspector />}
      {panels.over && <div className="scrim" onClick={closeOverlay} aria-hidden="true" />}
    </div>
  );
}
