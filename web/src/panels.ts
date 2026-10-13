// Which side panels are shown: the sandboxes (left) and the inspector (right).
// Remembered in this browser. Where the window is too narrow for the inspector,
// it opens over the conversation instead, and that isn't remembered.
import { useSyncExternalStore } from "react";

export type Side = "left" | "right";

const KEY = "sandbox-console-panels";
const NARROW = "(max-width: 1020px)";

interface Panels {
  left: boolean;
  right: boolean;
  /** The inspector over the conversation, in a narrow window. */
  over: boolean;
  narrow: boolean;
}

function load(): Pick<Panels, "left" | "right"> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { left: v.left !== false, right: v.right !== false };
  } catch {
    return { left: true, right: true };
  }
}

const media = typeof matchMedia === "function" ? matchMedia(NARROW) : null;
let state: Panels = { ...load(), over: false, narrow: !!media?.matches };
const listeners = new Set<() => void>();

function set(next: Partial<Panels>) {
  state = { ...state, ...next };
  localStorage.setItem(KEY, JSON.stringify({ left: state.left, right: state.right }));
  for (const l of listeners) l();
}

media?.addEventListener("change", (e) => set({ narrow: e.matches, over: false }));

/** Whether a panel is on screen now. */
export function shown(p: Panels, side: Side) {
  return side === "left" ? p.left : p.narrow ? p.over : p.right;
}

export function toggle(side: Side) {
  if (side === "left") set({ left: !state.left });
  else if (state.narrow) set({ over: !state.over });
  else set({ right: !state.right });
}

export function closeOverlay() {
  if (state.over) set({ over: false });
}

export function usePanels(): Panels {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** ⌘B / Ctrl+B for the sandboxes, ⌘⌥B / Ctrl+Alt+B for the inspector, as in VS Code. Esc closes the overlay. */
export function onPanelKey(e: KeyboardEvent) {
  if (e.key === "Escape" && state.over) {
    closeOverlay();
    return;
  }
  if (e.code !== "KeyB" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
  e.preventDefault();
  toggle(e.altKey ? "right" : "left");
}
