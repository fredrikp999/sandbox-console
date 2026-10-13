// Message box with the slash menu. Enter sends, Shift+Enter adds a line, Esc
// stops the agent. Agent commands are sent as prompts; console commands run here.
// Images can be pasted, dropped or attached, if the agent takes them.

import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PromptImage } from "../../../shared/protocol.ts";
import { type Attached, imageFiles, MAX_IMAGES, prepareImage } from "../images.ts";

export interface ConsoleCommand {
  name: string;
  hint: string;
  run: (arg: string) => void;
}

interface Entry {
  group: "Agent" | "Console";
  name: string;
  description: string;
}

export function Composer({
  sessionKey,
  agentCommands,
  consoleCommands,
  working,
  disabled,
  canImages,
  controls,
  onSend,
  onStop,
}: {
  sessionKey: string;
  agentCommands: AvailableCommand[];
  consoleCommands: ConsoleCommand[];
  working: boolean;
  disabled?: string;
  /** The agent takes images in prompts. */
  canImages: boolean;
  /** Model and mode for this thread, shown under the message box. */
  controls?: React.ReactNode;
  onSend: (text: string, images: PromptImage[]) => boolean;
  onStop: () => void;
}) {
  const drafts = useRef(new Map<string, string>());
  const [text, setTextState] = useState(() => drafts.current.get(sessionKey) ?? "");
  const setText = (v: string) => {
    setTextState(v);
    drafts.current.set(sessionKey, v);
  };
  const draftImages = useRef(new Map<string, Attached[]>());
  const [attached, setAttachedState] = useState<Attached[]>(() => draftImages.current.get(sessionKey) ?? []);
  const setAttached = (v: Attached[] | ((a: Attached[]) => Attached[])) =>
    setAttachedState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      draftImages.current.set(sessionKey, next);
      return next;
    });
  const [preparing, setPreparing] = useState(0);
  const [over, setOver] = useState(false);
  const attach = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // A draft per session, so switching sandboxes doesn't lose what you typed.
  useEffect(() => {
    setTextState(drafts.current.get(sessionKey) ?? "");
    setAttachedState(draftImages.current.get(sessionKey) ?? []);
    setNotice(null);
    box.current?.focus();
  }, [sessionKey]);

  // Grow the box with its text (up to a limit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures the DOM after the text changes
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`;
  }, [text]);

  const entries: Entry[] = useMemo(
    () => [
      ...agentCommands.map((c) => ({ group: "Agent" as const, name: `/${c.name}`, description: c.description ?? "" })),
      ...consoleCommands.map((c) => ({ group: "Console" as const, name: `/${c.name}`, description: c.hint })),
    ],
    [agentCommands, consoleCommands],
  );

  const slashQuery = text.startsWith("/") && !/\s/.test(text) ? text : null;
  const hits = slashQuery !== null && !dismissed ? entries.filter((e) => e.name.startsWith(slashQuery)) : [];
  const menuOpen = hits.length > 0;

  const pick = (e: Entry) => {
    setText(`${e.name} `);
    setDismissed(true);
    box.current?.focus();
  };

  /** Read, scale and add images; what can't be added is said in the notice. */
  const addFiles = async (list: File[]) => {
    const files = imageFiles(list);
    if (!files.length) return;
    if (!canImages) return setNotice("This agent doesn't take images in prompts.");
    const room = MAX_IMAGES - attached.length;
    if (room <= 0) return setNotice(`At most ${MAX_IMAGES} images in one message.`);
    const notes: string[] = [];
    if (files.length > room) notes.push(`Only ${MAX_IMAGES} images fit in one message; the rest were left out.`);
    setPreparing((n) => n + 1);
    try {
      const done = await Promise.allSettled(files.slice(0, room).map(prepareImage));
      const ok = done.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      for (const r of done) if (r.status === "rejected") notes.push((r.reason as Error).message);
      if (ok.length) setAttached((a) => [...a, ...ok].slice(0, MAX_IMAGES));
    } finally {
      setPreparing((n) => n - 1);
    }
    setNotice(notes.length ? notes.join(" ") : null);
    box.current?.focus();
  };

  const submit = () => {
    const v = text.trim();
    if ((!v && !attached.length) || disabled || preparing) return;
    if (!attached.length && v.startsWith("/") && !text.startsWith(" ")) {
      const [word, ...rest] = v.split(/\s+/);
      const arg = rest.join(" ");
      const cc = consoleCommands.find((c) => `/${c.name}` === word);
      if (cc) {
        cc.run(arg);
        setText("");
        setNotice(null);
        return;
      }
      if (!agentCommands.some((c) => `/${c.name}` === word)) {
        // Unknown words would reach the model as plain text and look like "no answer".
        setNotice(`${word} isn't a command. Type / to see the commands, or start with a space to send it as text.`);
        return;
      }
    }
    if (
      onSend(
        v,
        attached.map((a) => a.image),
      )
    ) {
      setText("");
      setAttached([]);
      setNotice(null);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && hits[active] && hits[active].name !== text.trim())) {
        e.preventDefault();
        pick(hits[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && working) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    // Dropping image files on the message box attaches them.
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a shortcut; the attach button and pasting work from the keyboard
    <div
      className={`composer${over ? " over" : ""}`}
      onDragOver={(e) => {
        if (canImages && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {menuOpen && (
        <div className="slash" role="listbox" aria-label="Commands">
          {hits.map((h, i) => {
            const head = i === 0 || hits[i - 1].group !== h.group ? <div className="grp">{h.group}</div> : null;
            return (
              <div key={h.group + h.name} style={{ display: "contents" }}>
                {head}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(h)}
                  onMouseEnter={() => setActive(i)}
                >
                  <b>{h.name}</b>
                  <span title={h.description}>{h.description}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {(attached.length > 0 || preparing > 0) && (
        <div className="attached">
          {attached.map((a) => (
            <div key={a.id} className="attached-one">
              <img src={a.preview} alt={a.name} title={a.name} />
              <button
                type="button"
                className="attached-x"
                onClick={() => setAttached((l) => l.filter((x) => x.id !== a.id))}
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
          {preparing > 0 && <div className="attached-one busy">…</div>}
        </div>
      )}
      <div className="comp-row">
        {canImages && (
          <>
            <button
              type="button"
              className="icon-btn attach"
              onClick={() => attach.current?.click()}
              disabled={!!disabled || attached.length >= MAX_IMAGES}
              title={`Attach an image (or paste or drop one), up to ${MAX_IMAGES}`}
              aria-label="Attach an image"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
                <circle cx="5.5" cy="6" r="1.2" fill="currentColor" />
                <path d="M2.5 12.5l3.5-4 2.5 2.5 2-2 3 3.5" fill="none" stroke="currentColor" />
              </svg>
            </button>
            <input
              ref={attach}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </>
        )}
        <textarea
          ref={box}
          rows={1}
          value={text}
          disabled={!!disabled}
          placeholder={disabled ?? "Ask the agent… ( / for commands )"}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
            setActive(0);
          }}
          onKeyDown={onKey}
          onPaste={(e) => {
            const pasted = imageFiles(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            addFiles(pasted);
          }}
        />
        {working ? (
          <button type="button" className="btn stop" onClick={onStop} title="Stop the agent (Esc)">
            Stop
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={submit} disabled={!!disabled || preparing > 0 || (!text.trim() && !attached.length)}>
            Send
          </button>
        )}
      </div>
      <div className="comp-foot">
        {controls}
        {notice ? (
          <div className="hint alert" role="status">
            {notice}
          </div>
        ) : (
          <div className="hint">
            <span>
              <kbd>Enter</kbd> send
            </span>
            <span>
              <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
            </span>
            <span>
              <kbd>Esc</kbd> stop the agent
            </span>
            <span>
              <kbd>/</kbd> commands
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
