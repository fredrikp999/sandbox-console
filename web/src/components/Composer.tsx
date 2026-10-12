// Message box with the slash menu. Enter sends, Shift+Enter adds a line, Esc
// stops the agent. Agent commands are sent as prompts; console commands run here.

import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { useEffect, useMemo, useRef, useState } from "react";

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
  onSend,
  onStop,
}: {
  sessionKey: string;
  agentCommands: AvailableCommand[];
  consoleCommands: ConsoleCommand[];
  working: boolean;
  disabled?: string;
  onSend: (text: string) => boolean;
  onStop: () => void;
}) {
  const drafts = useRef(new Map<string, string>());
  const [text, setTextState] = useState(() => drafts.current.get(sessionKey) ?? "");
  const setText = (v: string) => {
    setTextState(v);
    drafts.current.set(sessionKey, v);
  };
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // A draft per session, so switching sandboxes doesn't lose what you typed.
  useEffect(() => {
    setTextState(drafts.current.get(sessionKey) ?? "");
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

  const submit = () => {
    const v = text.trim();
    if (!v || disabled) return;
    if (v.startsWith("/") && !text.startsWith(" ")) {
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
    if (onSend(v)) {
      setText("");
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
    <div className="composer">
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
      <div className="comp-row">
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
        />
        {working ? (
          <button type="button" className="btn stop" onClick={onStop} title="Stop the agent (Esc)">
            Stop
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={submit} disabled={!!disabled || !text.trim()}>
            Send
          </button>
        )}
      </div>
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
  );
}
