// Folds the session event log (raw ACP session/update payloads plus the
// bridge's own events) into what the conversation pane renders.
import { diffLines } from "diff";
import type { PermissionOption, PlanEntry, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import type { SessionEvent } from "../../shared/protocol.ts";

export interface ToolItem {
  kind: "tool";
  id: string;
  toolKind: string;
  title: string;
  status: string;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: any;
  rawOutput?: any;
  startedAt: number;
  endedAt?: number;
}

/** The (partial) tool call carried by session/request_permission. */
export interface PermissionTool {
  toolCallId?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: any;
  locations?: ToolCallLocation[];
}

export interface PermissionItem {
  kind: "permission";
  requestId: string;
  toolCall: PermissionTool;
  options: PermissionOption[];
  resolved?: { optionId: string | null; label: string };
}

export type Item =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | ToolItem
  | PermissionItem
  | { kind: "notice"; text: string }
  | { kind: "error"; message: string; detail?: string; hint?: string }
  | { kind: "turn_end"; stopReason: string; ms?: number }
  | { kind: "closed"; exitCode: number | null; stderrTail: string[]; hint?: string };

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** False when the agent reported the edit without a diff. */
  counted: boolean;
  toolId: string;
}

export interface Conversation {
  items: Item[];
  /** Index of each tool call's card in `items`. */
  tools: Record<string, number>;
  /** The plan item of the running turn, replaced in full on every update. */
  planIndex: number | null;
  turnStartedAt: number | null;
  files: Record<string, FileChange>;
  /** Options the user chose that the agent will remember ("always allow"). */
  always: string[];
  /** Line counts already added to `files`, per tool call and path. Bookkeeping only. */
  counted: Record<string, { added: number; removed: number }>;
}

export const emptyConversation = (): Conversation => ({
  items: [],
  tools: {},
  planIndex: null,
  turnStartedAt: null,
  files: {},
  always: [],
  counted: {},
});

function textOf(content: any): string {
  if (!content) return "";
  if (content.type === "text") return content.text ?? "";
  if (content.type === "resource_link") return `[${content.name ?? content.uri}](${content.uri})`;
  if (content.type === "image") return "*(image)*";
  return "";
}

const EDIT_KINDS = new Set(["edit", "delete", "move"]);

function lineCounts(oldText: string | null | undefined, newText: string) {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText ?? "", newText ?? "")) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

function trackFiles(c: Conversation, tool: ToolItem) {
  const diffs = tool.content.filter((x): x is Extract<ToolCallContent, { type: "diff" }> => x.type === "diff");
  for (const d of diffs) {
    // A tool call can be updated several times with the same diff: count it once.
    const prev = c.files[d.path];
    const { added, removed } = lineCounts(d.oldText, d.newText);
    const key = `${tool.id}:${d.path}`;
    const before = c.counted[key] ?? { added: 0, removed: 0 };
    c.counted[key] = { added, removed };
    c.files[d.path] = {
      path: d.path,
      added: (prev?.added ?? 0) - before.added + added,
      removed: (prev?.removed ?? 0) - before.removed + removed,
      counted: true,
      toolId: tool.id,
    };
  }
  if (!diffs.length && EDIT_KINDS.has(tool.toolKind) && tool.status === "completed") {
    for (const loc of tool.locations) {
      if (!c.files[loc.path]) c.files[loc.path] = { path: loc.path, added: 0, removed: 0, counted: false, toolId: tool.id };
    }
  }
}

function appendText(c: Conversation, kind: "agent" | "thought" | "user", text: string) {
  if (!text) return;
  const last = c.items[c.items.length - 1];
  if (last && last.kind === kind) {
    c.items[c.items.length - 1] = { kind, text: last.text + text };
  } else {
    c.items.push({ kind, text });
  }
}

function mergeTool(prev: ToolItem | undefined, u: any, ts: number): ToolItem {
  const status = u.status ?? prev?.status ?? "pending";
  const done = status === "completed" || status === "failed";
  return {
    kind: "tool",
    id: u.toolCallId,
    toolKind: u.kind ?? prev?.toolKind ?? "other",
    title: u.title ?? prev?.title ?? u.toolCallId,
    status,
    content: u.content ?? prev?.content ?? [],
    locations: u.locations && u.locations.length ? u.locations : (prev?.locations ?? u.locations ?? []),
    rawInput: u.rawInput && Object.keys(u.rawInput).length ? u.rawInput : (prev?.rawInput ?? u.rawInput),
    rawOutput: u.rawOutput ?? prev?.rawOutput,
    startedAt: prev?.startedAt ?? ts,
    endedAt: done ? (prev?.endedAt ?? ts) : undefined,
  };
}

/** Apply one event. Returns a new Conversation (items array copied, unchanged items shared). */
export function apply(prev: Conversation, ev: SessionEvent): Conversation {
  const c: Conversation = { ...prev, items: prev.items.slice() };
  switch (ev.type) {
    case "user_message":
      c.items.push({ kind: "user", text: ev.text });
      break;
    case "turn_start":
      c.turnStartedAt = ev.ts;
      c.planIndex = null;
      break;
    case "turn_end":
      if (ev.stopReason !== "end_turn") {
        c.items.push({ kind: "turn_end", stopReason: ev.stopReason, ms: c.turnStartedAt ? ev.ts - c.turnStartedAt : undefined });
      }
      c.turnStartedAt = null;
      break;
    case "notice":
      c.items.push({ kind: "notice", text: ev.text });
      break;
    case "session_error":
      c.items.push({ kind: "error", message: ev.message, detail: ev.detail, hint: ev.hint });
      break;
    case "session_closed":
      c.items.push({ kind: "closed", exitCode: ev.exitCode, stderrTail: ev.stderrTail, hint: ev.hint });
      break;
    case "permission_request":
      c.items.push({ kind: "permission", requestId: ev.requestId, toolCall: ev.toolCall as any, options: ev.options });
      break;
    case "permission_resolved": {
      const i = c.items.findIndex((x) => x.kind === "permission" && x.requestId === ev.requestId);
      if (i >= 0) {
        const p = c.items[i] as PermissionItem;
        c.items[i] = { ...p, resolved: { optionId: ev.optionId, label: ev.label } };
        const opt = p.options.find((o) => o.optionId === ev.optionId);
        if (opt?.kind === "allow_always") {
          c.always = [...c.always, permissionSubject(p, c).text];
        }
      }
      break;
    }
    case "event": {
      const u: any = ev.update;
      switch (u.sessionUpdate) {
        case "user_message_chunk":
          appendText(c, "user", textOf(u.content));
          break;
        case "agent_message_chunk":
          appendText(c, "agent", textOf(u.content));
          break;
        case "agent_thought_chunk":
          appendText(c, "thought", textOf(u.content));
          break;
        case "plan":
          if (c.planIndex !== null && c.items[c.planIndex]?.kind === "plan") {
            c.items[c.planIndex] = { kind: "plan", entries: u.entries ?? [] };
          } else {
            c.planIndex = c.items.length;
            c.items.push({ kind: "plan", entries: u.entries ?? [] });
          }
          break;
        case "tool_call":
        case "tool_call_update": {
          const idx = c.tools[u.toolCallId];
          const prevTool = idx !== undefined ? (c.items[idx] as ToolItem) : undefined;
          const tool = mergeTool(prevTool, u, ev.ts);
          if (idx !== undefined) c.items[idx] = tool;
          else {
            c.tools = { ...c.tools, [tool.id]: c.items.length };
            c.items.push(tool);
          }
          c.files = { ...c.files };
          trackFiles(c, tool);
          break;
        }
      }
      break;
    }
  }
  return c;
}

/** The tool call behind a permission request, merged with what we already know of it. */
export function permissionTool(p: PermissionItem, c: Conversation): PermissionTool {
  const t = p.toolCall;
  const known = t.toolCallId !== undefined && c.tools[t.toolCallId] !== undefined ? (c.items[c.tools[t.toolCallId]] as ToolItem) : undefined;
  return {
    toolCallId: t.toolCallId,
    kind: t.kind ?? known?.toolKind,
    title: t.title ?? known?.title,
    status: t.status ?? known?.status,
    rawInput: t.rawInput && Object.keys(t.rawInput).length ? t.rawInput : known?.rawInput,
    locations: t.locations?.length ? t.locations : known?.locations,
  };
}

const ASK: Record<string, string> = {
  execute: "The agent wants to run a command",
  edit: "The agent wants to edit a file",
  delete: "The agent wants to delete a file",
  move: "The agent wants to move a file",
  read: "The agent wants to read a file",
  fetch: "The agent wants to fetch a URL",
  search: "The agent wants to search",
};

/** "The agent wants to run a command" + `pytest -q …` */
export function permissionSubject(p: PermissionItem, c: Conversation): { question: string; text: string } {
  const t = permissionTool(p, c);
  const kind = t.kind ?? "other";
  const input = t.rawInput ?? {};
  const text =
    (kind === "execute" && (input.command ?? input.cmd)) ||
    t.locations?.[0]?.path ||
    input.filePath ||
    input.path ||
    input.url ||
    t.title ||
    "this action";
  return { question: ASK[kind] ?? "The agent wants to use a tool", text: String(text) };
}

export function fold(events: SessionEvent[]): Conversation {
  return events.reduce(apply, emptyConversation());
}
