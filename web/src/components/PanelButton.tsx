// Shows or hides a side panel. Sits at that side's edge of the chat header.
import { type Side, shown, toggle, usePanels } from "../panels.ts";

const KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? { left: "⌘B", right: "⌥⌘B" } : { left: "Ctrl+B", right: "Ctrl+Alt+B" };

export function PanelButton({ side }: { side: Side }) {
  const panels = usePanels();
  const on = shown(panels, side);
  const what = side === "left" ? "sandboxes" : "Changes, Catalog and Activity";
  const label = `${on ? "Hide" : "Show"} ${what}`;
  return (
    <button
      type="button"
      className={`icon-btn panel-btn ${side}`}
      onClick={() => toggle(side)}
      aria-label={label}
      aria-pressed={on}
      title={`${label} (${KEYS[side]})`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
        <rect x={side === "left" ? 2 : 10} y="3" width="4" height="10" rx="1.2" fill="currentColor" opacity={on ? 0.85 : 0.2} />
      </svg>
    </button>
  );
}
