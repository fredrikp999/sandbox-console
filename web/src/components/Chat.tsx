// Middle column: header with model picker, the conversation log, the composer.
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type BundleStatus, downloadBundle } from "../bundle.ts";
import { agentLabel } from "../format.ts";
import { type RequestError, type SessionView, store, useStore } from "../store.ts";
import { Composer, type ConsoleCommand } from "./Composer.tsx";
import { ConversationLog } from "./ConversationLog.tsx";
import { flattenOptions, ModelPicker, type PickerHandle } from "./ModelPicker.tsx";
import { StartSession } from "./StartSession.tsx";
import { Threads } from "./Threads.tsx";

function ConfigControls({
  view,
  picker,
  onError,
}: {
  view: SessionView;
  picker: React.RefObject<PickerHandle | null>;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (configId: string, value: string) => {
    setBusy(configId);
    try {
      await store.request({ type: "set_option", sessionId: view.info.sessionId, configId, value });
    } catch (e) {
      const r = e as RequestError;
      onError([r.message, r.hint].filter(Boolean).join(" "));
    } finally {
      setBusy(null);
    }
  };
  const selects = view.info.configOptions.filter((o): o is Extract<SessionConfigOption, { type: "select" }> => o.type === "select");
  return (
    <div className="head-tools">
      {selects.map((o) => {
        const options = flattenOptions(o.options);
        if (o.category === "model" || o.id === "model") {
          return (
            <ModelPicker
              key={o.id}
              ref={picker}
              label={o.name ?? "Model"}
              current={o.currentValue}
              options={options}
              busy={busy === o.id}
              onPick={(v) => set(o.id, v)}
            />
          );
        }
        return (
          <select
            key={o.id}
            className="opt"
            aria-label={o.name}
            title={o.description ?? o.name}
            value={o.currentValue}
            disabled={busy === o.id}
            onChange={(e) => set(o.id, e.target.value)}
          >
            {options.map((x) => (
              <option key={x.value} value={x.value}>
                {x.name}
              </option>
            ))}
          </select>
        );
      })}
    </div>
  );
}

export function Chat() {
  const selected = useStore((s) => s.selected);
  const sandboxes = useStore((s) => s.sandboxes);
  const agents = useStore((s) => s.agents);
  const sessionId = useStore((s) => (s.selected ? s.bySandbox[s.selected] : undefined));
  const view = useStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const sb = sandboxes.find((s) => s.name === selected);
  const picker = useRef<PickerHandle>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // A status line under the log (bundle result, errors), shown only for the sandbox it belongs to.
  const [flashed, setFlashed] = useState<(BundleStatus & { sandbox: string | null }) | null>(null);
  const flash = flashed && flashed.sandbox === selected ? flashed : null;
  const setFlash = useCallback((f: BundleStatus | null) => setFlashed(f && { ...f, sandbox: store.state.selected }), []);

  const bridgeError = view?.error;
  useEffect(() => {
    if (bridgeError) setFlash({ tone: "error", text: [bridgeError.message, bridgeError.hint].filter(Boolean).join(" ") });
  }, [bridgeError, setFlash]);

  // Follow the conversation while you are at the bottom of it.
  const conv = view?.conv;
  // biome-ignore lint/correctness/useExhaustiveDependencies: conv and flash are what changes the log's height; the effect runs after they do.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [conv, flash]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the session changes, so a newly opened one starts at the bottom.
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  const info = view?.info;
  const working = info?.state === "working" || info?.state === "waiting";
  const dead = info?.state === "dead";

  const consoleCommands = useMemo<ConsoleCommand[]>(
    () => [
      {
        name: "model",
        hint: "switch model for this session",
        run: (q) => (picker.current ? picker.current.open(q) : setFlash({ tone: "error", text: "This agent offers no model choice." })),
      },
      {
        name: "bundle",
        hint: "download the agent's commits as a git bundle [dir]",
        run: (dir) => sessionId && downloadBundle(sessionId, dir || undefined, setFlash),
      },
      {
        name: "new",
        hint: "start another thread in this sandbox",
        run: () =>
          selected &&
          store.request({ type: "new_thread", sandbox: selected }).catch((e: RequestError) => setFlash({ tone: "error", text: e.message })),
      },
    ],
    [sessionId, selected, setFlash],
  );

  if (!selected) {
    return (
      <main className="pane">
        <div className="empty">
          <b>Pick a sandbox</b>
          <span>Choose a sandbox on the left to chat with its agent, or create a new one.</span>
        </div>
      </main>
    );
  }

  if (!sb && !view) {
    return (
      <main className="pane">
        <div className="empty">
          <b>{selected}</b>
          <span>{sandboxes.length ? "This sandbox doesn't exist any more." : "Loading sandboxes…"}</span>
        </div>
      </main>
    );
  }

  const sub = info
    ? `${info.agentInfo?.name ?? agentLabel(agents, info.agent)}${info.agentInfo?.version ? ` ${info.agentInfo.version}` : ""} · ${info.cwd}${dead ? " · exited" : ""}`
    : `${agentLabel(agents, sb?.agent)} · not connected`;

  const send = (text: string) => {
    if (!info) return false;
    if (working) {
      setFlash({ tone: "error", text: "The agent is still working. Wait for it, or stop it with Esc." });
      return false;
    }
    try {
      store.send({ type: "prompt", sessionId: info.sessionId, text });
      stick.current = true;
      return true;
    } catch (e) {
      setFlash({ tone: "error", text: (e as Error).message });
      return false;
    }
  };
  const stop = () => info && store.send({ type: "cancel", sessionId: info.sessionId });
  const lastItem = view?.conv.items.at(-1);
  const waitingOnYou = lastItem?.kind === "permission" && !lastItem.resolved;

  return (
    <main className="pane">
      <div className="pane-head chat-head">
        <div className="title">
          <b>{selected}</b>
          <span>{sub}</span>
        </div>
        {view && !dead && <ConfigControls view={view} picker={picker} onError={(text) => setFlash({ tone: "error", text })} />}
      </div>
      {view && <Threads sandbox={selected} onError={(text) => setFlash({ tone: "error", text })} />}
      <div
        className="log"
        ref={log}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {view ? (
          <>
            {!view.conv.items.length && view.replayed && !dead && (
              <div className="empty">
                <b>New thread</b>
                <span>
                  {info?.agentInfo?.name ?? "The agent"} is running in <span className="mono">{selected}</span>. Ask it something, or type{" "}
                  <kbd>/</kbd> for commands.
                </span>
              </div>
            )}
            <ConversationLog conv={view.conv} sessionId={view.info.sessionId} />
            {working && !waitingOnYou && (
              <div className="working">
                <span className="dot ok pulse" /> Working…
              </div>
            )}
            {flash && (
              <div className={flash.tone === "error" ? "err" : "line-note"} role="status">
                {flash.tone === "error" ? <b>{flash.text}</b> : flash.text}
              </div>
            )}
            {dead && sb && <StartSession key={`resume-${sb.name}`} sb={sb} resume />}
          </>
        ) : (
          sb && <StartSession key={sb.name} sb={sb} />
        )}
      </div>
      {view && !dead && (
        <Composer
          sessionKey={view.info.sessionId}
          agentCommands={view.info.commands}
          consoleCommands={consoleCommands}
          working={working}
          disabled={info?.state === "starting" ? "Starting the agent…" : undefined}
          onSend={send}
          onStop={stop}
        />
      )}
    </main>
  );
}
