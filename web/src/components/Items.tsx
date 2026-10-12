// The conversation log: one component per kind of item (DESIGN.md section 5, Middle).
import { memo, useState } from "react";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { type Conversation, type Item, type PermissionItem, permissionSubject, type ToolItem } from "../conversation.ts";
import { store } from "../store.ts";
import { duration } from "../util.ts";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

const KIND_LABEL: Record<string, string> = { execute: "exec", switch_mode: "mode", other: "tool" };

function toolClass(status: string) {
  if (status === "failed") return "tool fail";
  if (status === "in_progress") return "tool run";
  if (status === "pending") return "tool pending";
  return "tool";
}

function toolStatus(t: ToolItem, now: number) {
  const ms = (t.endedAt ?? now) - t.startedAt;
  switch (t.status) {
    case "completed":
      return `done · ${duration(ms)}`;
    case "failed":
      return `failed · ${duration(ms)}`;
    case "in_progress":
      return "running…";
    default:
      return "pending";
  }
}

function rawOutputText(raw: any): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw.output === "string") return raw.output;
  if (typeof raw.error === "string") return raw.error;
  return JSON.stringify(raw, null, 2);
}

const ToolCard = memo(function ToolCard({ t }: { t: ToolItem }) {
  const hasDiff = t.content.some((c) => c.type === "diff");
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? (hasDiff || t.status === "failed");
  const command = t.toolKind === "execute" ? (t.rawInput?.command as string | undefined) : undefined;
  const texts = t.content.filter((c) => c.type === "content");
  const fallback = !texts.length && !hasDiff ? rawOutputText(t.rawOutput) : undefined;
  return (
    <details className={toolClass(t.status)} open={isOpen} id={`tool-${t.id}`} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="kind">{KIND_LABEL[t.toolKind] ?? t.toolKind}</span>
        <span className="t" title={t.title}>
          {t.title}
        </span>
        <span className="st">{toolStatus(t, Date.now())}</span>
      </summary>
      {isOpen && (
        <div className="tool-body">
          {command && command !== t.title && <pre>$ {command}</pre>}
          {t.content.map((c, i) => {
            if (c.type === "diff") {
              return (
                <div key={i}>
                  <div className="file">{c.path}</div>
                  <DiffView path={c.path} oldText={c.oldText} newText={c.newText} />
                </div>
              );
            }
            if (c.type === "content") {
              const inner: any = c.content;
              return <pre key={i}>{inner.type === "text" ? inner.text : `[${inner.type}]`}</pre>;
            }
            return (
              <div key={i} className="note">
                Terminal output isn't shown: the console gives the agent no terminal capability.
              </div>
            );
          })}
          {fallback && <pre>{fallback}</pre>}
          {!t.content.length && !fallback && !command && (
            <div className="note">{t.status === "completed" ? "No output." : "Waiting for output…"}</div>
          )}
        </div>
      )}
    </details>
  );
});

// What each option does, from its ACP `kind`. The `name` is free text chosen by
// the agent, so it is never the only thing shown or used for styling.
const KIND_TAG: Record<string, string> = {
  allow_once: "allows once",
  allow_always: "allows always",
  reject_once: "rejects",
  reject_always: "rejects always",
};
const KIND_DONE: Record<string, string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  reject_once: "Rejected",
  reject_always: "Always rejected",
};

function optionClass(o: PermissionOption) {
  if (o.kind === "allow_once") return "btn warn";
  if (o.kind === "reject_once" || o.kind === "reject_always") return "btn";
  return "btn outline-warn";
}

function sameMeaning(name: string, kind: string) {
  return name.trim().toLowerCase() === (KIND_DONE[kind] ?? "").toLowerCase();
}

const PermissionCard = memo(function PermissionCard({ p, conv, sessionId }: { p: PermissionItem; conv: Conversation; sessionId: string }) {
  const { question, text } = permissionSubject(p, conv);
  if (p.resolved) {
    const chosen = p.options.find((o) => o.optionId === p.resolved!.optionId);
    const done = chosen ? (KIND_DONE[chosen.kind] ?? chosen.name) : "Cancelled";
    return (
      <div className="perm resolved">
        <b>{done}</b>
        {chosen && !sameMeaning(chosen.name, chosen.kind) && <span> ({chosen.name})</span>} · <code>{text}</code>
      </div>
    );
  }
  const answer = (optionId: string | null) => {
    try {
      store.send({ type: "permission_answer", sessionId, requestId: p.requestId, optionId });
    } catch {
      /* the link banner shows the problem */
    }
  };
  return (
    <div className="perm" role="alertdialog" aria-label={question}>
      <div className="q">{question}</div>
      <div>
        <code>{text}</code>
      </div>
      <div className="acts">
        {p.options.map((o) => (
          <button key={o.optionId} className={optionClass(o)} onClick={() => answer(o.optionId)} title={`The agent's option "${o.name}" (${o.kind})`}>
            {o.name}
            <span className="kind-tag">{KIND_TAG[o.kind] ?? `unknown: ${o.kind}`}</span>
          </button>
        ))}
      </div>
      <div className="perm-note">Described by the agent. The console can't check what it will actually do.</div>
    </div>
  );
});

const STOP_TEXT: Record<string, string> = {
  cancelled: "Stopped",
  refusal: "The agent refused this request",
  max_tokens: "Stopped: the reply hit the token limit",
  max_turn_requests: "Stopped: too many steps in one turn",
  agent_exited: "The turn ended because the agent exited",
  error: "The turn ended with an error",
};

function ItemView({ item, conv, sessionId }: { item: Item; conv: Conversation; sessionId: string }) {
  switch (item.kind) {
    case "user":
      return <div className="msg-user">{item.text}</div>;
    case "agent":
      return (
        <div className="msg-agent">
          <Markdown text={item.text} />
        </div>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>Thinking</summary>
          <div className="body">{item.text}</div>
        </details>
      );
    case "plan":
      return (
        <div className="plan">
          <h4>Plan</h4>
          <ul>
            {item.entries.map((e, i) => (
              <li key={i} className={e.status === "completed" ? "done" : e.status === "in_progress" ? "now" : ""}>
                <span className="chk">{e.status === "completed" ? "✓" : e.status === "in_progress" ? "●" : "○"}</span>
                <span>{e.content}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "tool":
      return <ToolCard t={item} />;
    case "permission":
      return <PermissionCard p={item} conv={conv} sessionId={sessionId} />;
    case "notice":
      return <div className="line-note">{item.text}</div>;
    case "turn_end":
      return (
        <div className="line-note">
          {STOP_TEXT[item.stopReason] ?? `Turn ended: ${item.stopReason}`}
          {item.ms !== undefined ? ` · ${duration(item.ms)}` : ""}
        </div>
      );
    case "error":
      return (
        <div className="err" role="alert">
          <b>{item.message}</b>
          {item.hint && <div className="hint">{item.hint}</div>}
          {item.detail && <pre>{item.detail}</pre>}
        </div>
      );
    case "closed":
      if (item.exitCode === 0 && !item.hint) return <div className="line-note">Session closed.</div>;
      return (
        <div className="err" role="alert">
          <b>The agent process exited{item.exitCode !== null ? ` (exit code ${item.exitCode})` : ""}.</b>
          {item.hint && <div className="hint">{item.hint}</div>}
          {item.stderrTail.length > 0 && <pre>{item.stderrTail.join("\n")}</pre>}
        </div>
      );
  }
}

export const LogItems = memo(function LogItems({ conv, sessionId }: { conv: Conversation; sessionId: string }) {
  return (
    <>
      {conv.items.map((item, i) => (
        <ItemView key={item.kind === "tool" ? `t-${item.id}` : item.kind === "permission" ? `p-${item.requestId}` : i} item={item} conv={conv} sessionId={sessionId} />
      ))}
    </>
  );
});
