// Searchable picker for a `select` config option. OpenRouter offers ~400
// models, so a plain <select> isn't enough (DESIGN.md section 5).
import type { SessionConfigSelectOptions } from "@agentclientprotocol/sdk";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  name: string;
  group?: string;
}

export interface PickerHandle {
  open(query?: string): void;
}

const MAX_SHOWN = 200;

export const ModelPicker = forwardRef<
  PickerHandle,
  {
    label: string;
    current: string;
    options: SelectOption[];
    busy?: boolean;
    onPick: (value: string) => void;
  }
>(function ModelPicker({ label, current, options, busy, onPick }, ref) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  /** Open with a search; without one, the current value is highlighted. */
  const openWith = (query: string) => {
    setQ(query);
    setActive(
      query
        ? 0
        : Math.max(
            0,
            options.findIndex((o) => o.value === current),
          ),
    );
    setOpen(true);
  };

  useImperativeHandle(ref, () => ({ open: (query = "") => openWith(query) }));

  const hits = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = `${o.value} ${o.name}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [q, options]);

  // On opening: focus the search box and bring the highlighted option into view.
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (v: string | undefined) => {
    setOpen(false);
    if (v && v !== current) onPick(v);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(hits.length, MAX_SHOWN);
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + n) % Math.max(n, 1);
      setActive(next);
      list.current?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(hits[active]?.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const currentName = options.find((o) => o.value === current)?.value ?? current;
  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentName}
        disabled={busy}
        onClick={() => (open ? setOpen(false) : openWith(""))}
      >
        {busy ? "switching…" : currentName || label}
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label={`Choose ${label.toLowerCase()}`} onKeyDown={onKey}>
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder={`Search ${options.length} ${label.toLowerCase()}s…`}
            aria-label={`Search ${label}`}
          />
          <div ref={list} role="listbox" className="options">
            {hits.slice(0, MAX_SHOWN).map((o, i) => (
              <button
                type="button"
                key={o.value}
                data-i={i}
                role="option"
                aria-selected={i === active}
                className={o.value === current ? "cur" : ""}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o.value)}
              >
                <b>{o.value}</b>
                {o.name && o.name !== o.value && <span>{o.name}</span>}
              </button>
            ))}
          </div>
          <div className="count">
            {hits.length > MAX_SHOWN ? `${MAX_SHOWN} of ${hits.length} shown, keep typing` : `${hits.length} of ${options.length}`}
          </div>
        </div>
      )}
    </div>
  );
});

/** Flatten an ACP select option's `options`, which may be grouped. */
export function flattenOptions(opts: SessionConfigSelectOptions | undefined): SelectOption[] {
  const out: SelectOption[] = [];
  for (const o of opts ?? []) {
    if ("options" in o) for (const x of o.options) out.push({ value: x.value, name: x.name ?? x.value, group: o.name });
    else out.push({ value: o.value, name: o.name ?? o.value });
  }
  return out;
}
