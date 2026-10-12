// Browser <-> bridge messages (DESIGN.md section 7). JSON over one WebSocket
// per tab, each with a `type`. ACP `session/update` payloads are passed through
// unchanged, so the UI follows the ACP spec directly.
import type { AvailableCommand, PermissionOption, SessionConfigOption, SessionUpdate, ToolCallUpdate, Usage } from "@agentclientprotocol/sdk";

export type AgentId = string;

export interface AgentInfo {
  id: AgentId;
  label: string;
  cmd: string[];
  hasModelEnv: boolean;
}

/** What the session is doing, as shown by the status pill. */
export type ActivityState = "starting" | "working" | "waiting" | "idle" | "dead";

export interface SandboxRow {
  name: string;
  /** OpenShell phase: Ready, Provisioning, Error, ... */
  phase: string;
  created: string;
  /** Detected from the provider policy or the name, or remembered; null if unknown. */
  agent: AgentId | null;
  /** How `agent` was found, so the UI can ask when it is only a guess. */
  agentSource: "policy" | "name" | "remembered" | null;
  /** Error text from the Ready condition, when the sandbox isn't Ready. */
  message?: string;
  /** Defaults the console remembers for this sandbox. */
  cwd?: string;
  model?: string;
  session?: {
    sessionId: string | null;
    state: ActivityState;
    lastActivity: number;
    agent: AgentId;
  };
}

export interface GatewayStatus {
  name: string;
  status: string;
  version?: string;
  error?: string;
}

export interface SessionInfo {
  sessionId: string;
  sandbox: string;
  agent: AgentId;
  agentCmd: string[];
  agentInfo: { name?: string; version?: string; title?: string | null } | null;
  canLoad: boolean;
  canList: boolean;
  cwd: string;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
  state: ActivityState;
  startedAt: number;
  usage?: { used?: number; size?: number; totals?: Usage };
  /** Last seq in the event log, so a tab can tell how much to replay. */
  lastSeq: number;
}

export interface PastSession {
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
  cwd: string;
}

export interface NetworkHost {
  host: string;
  allowed: number;
  denied: number;
  binaries: string[];
}

// ---- session event log: everything a tab needs to rebuild the conversation

interface Logged {
  sessionId: string;
  seq: number;
  ts: number;
}

export type SessionEvent =
  | (Logged & { type: "event"; update: SessionUpdate })
  | (Logged & { type: "user_message"; text: string })
  | (Logged & { type: "turn_start" })
  | (Logged & { type: "turn_end"; stopReason: string; usage?: Usage })
  | (Logged & {
      type: "permission_request";
      requestId: string;
      toolCall: ToolCallUpdate;
      options: PermissionOption[];
    })
  | (Logged & {
      type: "permission_resolved";
      requestId: string;
      optionId: string | null;
      label: string;
    })
  | (Logged & { type: "notice"; text: string })
  /** Something failed in this session; shown inline in the conversation. */
  | (Logged & { type: "session_error"; message: string; detail?: string; hint?: string })
  | (Logged & { type: "session_closed"; exitCode: number | null; stderrTail: string[]; hint?: string });

// ---- browser -> bridge

export type ClientMessage =
  | { type: "list_sandboxes" }
  | { type: "create_sandbox"; reqId: string; name: string; agent: AgentId; workdir: string }
  | { type: "delete_sandbox"; reqId: string; name: string }
  | { type: "set_sandbox_agent"; name: string; agent: AgentId }
  | {
      type: "open_session";
      reqId: string;
      sandbox: string;
      agent: AgentId;
      cwd: string;
      model?: string;
      /** Load this earlier session (session/load) instead of starting a new one. */
      loadSessionId?: string;
    }
  | { type: "new_session"; reqId: string; sessionId: string }
  | { type: "close_session"; sessionId: string }
  | { type: "list_past_sessions"; reqId: string; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "cancel"; sessionId: string }
  | { type: "set_option"; reqId: string; sessionId: string; configId: string; value: string }
  | { type: "permission_answer"; sessionId: string; requestId: string; optionId: string | null }
  | { type: "subscribe"; sessionId: string; sinceSeq: number }
  | { type: "network"; reqId: string; sessionId: string };

// ---- bridge -> browser

export type ServerMessage =
  | {
      type: "hello";
      agents: AgentInfo[];
      sessions: SessionInfo[];
      canCreate: boolean;
      createNote?: string;
    }
  | { type: "sandboxes"; sandboxes: SandboxRow[]; error?: string }
  | { type: "gateway"; gateway: GatewayStatus }
  | { type: "session_opened"; reqId?: string; session: SessionInfo }
  | { type: "session_info"; session: SessionInfo }
  | { type: "replay_done"; sessionId: string; lastSeq: number }
  | { type: "past_sessions"; reqId: string; sessionId: string; sessions: PastSession[]; error?: string }
  | { type: "network"; reqId: string; sessionId: string; hosts: NetworkHost[]; error?: string }
  | { type: "result"; reqId: string; ok: boolean; message?: string; hint?: string }
  | { type: "error"; reqId?: string; sessionId?: string; message: string; detail?: string; hint?: string }
  | SessionEvent;
