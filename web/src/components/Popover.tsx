// A panel that drops down from a button. Closes on Esc and on a click outside.
import { type ReactNode, useEffect, useRef } from "react";

export function Popover({
  open,
  onClose,
  anchor,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  /** The button(s) it drops down from. */
  anchor: ReactNode;
  children: ReactNode;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open, onClose]);
  return (
    <div className="pop-anchor" ref={box}>
      {anchor}
      {open && (
        <div className="pop" role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
