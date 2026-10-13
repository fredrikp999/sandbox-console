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

/** Which code the bridge runs, to tell the page when it needs a restart. */
export interface ServerBuild {
  /** Hash of shared/protocol.ts as the bridge loaded it; the page compares it with its own. */
  protocol: string;
  /** The code on disk has changed since the bridge started. */
  stale: boolean;
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
  /** The sandbox type's label, if the console created it. */
  type?: string;
  /** Defaults the console remembers for this sandbox. */
  cwd?: string;
  model?: string;
  /** Host repositories brought into this sandbox. */
  repos: RepoLink[];
  /** The agent process; `state` is the most urgent of its threads. */
  session?: {
    /** The thread touched last. */
    sessionId: string | null;
    state: ActivityState;
    lastActivity: number;
    agent: AgentId;
  };
}

/**
 * A host repository brought into a sandbox with git bundles (as openshell-configs'
 * bundle.sh does). Its base branch goes in as host/<base>; the agent works on
 * `branch`, which comes back out into the host repo under the same name.
 */
export interface RepoLink {
  /** Its directory name in /sandbox; unique per sandbox. */
  name: string;
  /** The git work tree on this machine. */
  hostPath: string;
  /** The URL it was cloned from, if the console cloned it. */
  cloneUrl?: string;
  base: string;
  branch: string;
  sandboxPath: string;
  sentAt?: number;
  fetchedAt?: number;
  mergedAt?: number;
  pushedAt?: number;
}

export interface RepoCommit {
  sha: string;
  author: string;
  time: number;
  subject: string;
}

export interface RepoFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  /** The file's part of the unified diff, without the `diff --git` header lines. */
  patch: string;
}

/** The agent's branch on the host compared with the base branch. */
export interface RepoReview {
  base: string;
  branch: string;
  /** False until the agent's commits have been fetched out at least once. */
  hasBranch: boolean;
  /** Commits on the branch that aren't in base, newest first. */
  commits: RepoCommit[];
  /** Commits on base the branch doesn't have; merging then needs a merge commit. */
  behind: number;
  files: RepoFile[];
  /** The diff was too big to send whole. */
  truncated: boolean;
}

export type RepoOp = "link" | "send" | "get" | "review" | "merge" | "push" | "unlink";

/**
 * A kind of sandbox "New sandbox" can create: an image with everything installed
 * when it was built (on this machine, from openshell-configs), and the policy
 * that goes with it.
 */
export interface SandboxType {
  id: string;
  label: string;
  description: string;
  agent: AgentId;
  image: string;
  /** The policy file's name in openshell-configs/policies, or null if it isn't there. */
  policy: string | null;
  /** The openshell-configs make target that builds the image. */
  build?: string;
  /** Whether the image is in the local container engine. */
  imageState: "present" | "missing" | "unknown";
}

/** An image being built (one at a time), with the end of its output. */
export interface ImageBuild {
  sandboxType: string;
  target: string;
  state: "running" | "done" | "failed";
  lines: string[];
  startedAt: number;
}

/** A port on this machine forwarded to the same port in a sandbox. */
export interface PortForward {
  sandbox: string;
  port: number;
  bind: string;
  alive: boolean;
}

/** A port something listens on in the sandbox, and the program, if it can be seen. */
export interface ListeningPort {
  port: number;
  command?: string;
}

export interface PortPreset {
  port: number;
  label: string;
  /** How to get it running in the sandbox. */
  hint?: string;
}

/** One thing in a sandbox folder. */
export interface FileEntry {
  name: string;
  kind: "file" | "dir" | "other";
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

/** A network rule OpenShell proposed after a connection was denied. */
export interface RuleProposal {
  /** The chunk id `openshell rule approve` takes. */
  id: string;
  status: string;
  rule: string;
  endpoints: { host: string; port: number; mode?: string }[];
  /** The programs that would be allowed to make the connection. */
  binaries: string[];
  confidence?: number;
  rationale: string;
  hits?: number;
  firstSeen?: string;
  lastSeen?: string;
  /** One of the programs is something many things run as (node, python, curl, …). */
  shared: boolean;
}

export type CatalogKind = "agent" | "skill" | "context" | "tool";

/** Something in the catalog on this machine that can be put into a sandbox. */
export interface CatalogItem {
  /** "<kind>:<name>"; a name is unique per kind. */
  id: string;
  kind: CatalogKind;
  name: string;
  description: string;
  /** Which catalog folder it is from, e.g. "Built in" or "~/.claude". */
  source: string;
  files: number;
  bytes: number;
  /** Of its contents, to tell when the sandbox has an older copy. */
  hash: string;
  /** Why it can't be put in, if it can't. */
  problem?: string;
}

/** What the console put into a sandbox from the catalog. */
export interface InstalledItem {
  kind: CatalogKind;
  name: string;
  source: string;
  hash: string;
  at: number;
}

/** The catalog seen from one sandbox. */
export interface SandboxCatalog {
  /** Which agent's places are used, e.g. Claude Code's ~/.claude. */
  agent: AgentId;
  /** Where each kind goes in the sandbox. */
  places: Record<CatalogKind, string>;
  /** "<kind>:<name>" of everything there now, from the catalog or not. */
  present: string[];
  installed: InstalledItem[];
  /** Couldn't look into the sandbox (e.g. it isn't Ready). */
  error?: string;
}

export type CatalogOp = "list" | "preview" | "install" | "remove";

export type EditorId = "vscode" | "cursor";

export interface EditorInfo {
  id: EditorId;
  label: string;
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
  /** The agent takes images in prompts (ACP promptCapabilities.image). */
  promptImages?: boolean;
  cwd: string;
  /** From the agent, else the first prompt; null for an empty thread. */
  title: string | null;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
  state: ActivityState;
  startedAt: number;
  usage?: { used?: number; size?: number; totals?: Usage };
  /** Last seq in the event log, so a tab can tell how much to replay. */
  lastSeq: number;
}

/** An image sent along with a prompt. */
export interface PromptImage {
  /** png, jpeg, gif or webp. */
  mimeType: string;
  /** Base64 of what the agent receives, already scaled down by the page. */
  data: string;
  /** Base64 of a small JPEG, kept in the conversation to show what was sent. */
  thumb: string;
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
  | (Logged & { type: "user_message"; text: string; images?: { mimeType: string; thumb: string }[] })
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
  /** Something started listening on a port in the sandbox while the agent worked, e.g. the HyperFrames Studio. */
  | (Logged & { type: "port_open"; port: number; command?: string; label?: string })
  /** Something failed in this session; shown inline in the conversation. */
  | (Logged & { type: "session_error"; message: string; detail?: string; hint?: string })
  | (Logged & { type: "session_closed"; exitCode: number | null; stderrTail: string[]; hint?: string });

// ---- browser -> bridge

export type ClientMessage =
  | { type: "list_sandboxes" }
  /** From a sandbox type (its image, policy and agent), or else from the agent's image in agents.json. */
  | { type: "create_sandbox"; reqId: string; name: string; agent?: AgentId; sandboxType?: string; workdir: string }
  /** The contents of a folder in the sandbox (under /sandbox). */
  | { type: "files"; reqId: string; sandbox: string; path: string }
  /** The network rules OpenShell proposes for a sandbox; approve or reject one by its id. */
  | { type: "rules"; reqId: string; sandbox: string; op?: "approve" | "reject"; chunkId?: string }
  /** Port forwards of a sandbox, what listens in it, and the presets for it. */
  | { type: "ports"; reqId: string; sandbox: string }
  /** Start or stop forwarding a port (the same number on both sides). */
  | { type: "forward"; reqId: string; sandbox: string; op: "start" | "stop"; port: number }
  /** The sandbox types, with whether each image is built. */
  | { type: "sandbox_types"; reqId: string }
  /** Build a sandbox type's image with `make <target>` in openshell-configs. */
  | { type: "build_image"; reqId: string; sandboxType: string }
  | { type: "delete_sandbox"; reqId: string; name: string }
  | { type: "set_sandbox_agent"; name: string; agent: AgentId }
  | {
      type: "open_session";
      reqId: string;
      sandbox: string;
      agent: AgentId;
      cwd: string;
      model?: string;
      /** Load this earlier session (session/load) as a thread instead of starting a new one. */
      loadSessionId?: string;
    }
  /** Another thread in a sandbox whose agent is running. */
  | { type: "new_thread"; reqId: string; sandbox: string }
  /** Stops the sandbox's agent process, and with it all its threads. */
  | { type: "close_session"; sessionId: string }
  /** Forget a thread for good: its saved conversation goes too. The sandbox's files are untouched. */
  | { type: "delete_thread"; reqId: string; sessionId: string }
  /** Every thread of a sandbox, live or saved. */
  | { type: "delete_threads"; reqId: string; sandbox: string }
  | { type: "list_past_sessions"; reqId: string; sessionId: string }
  | { type: "prompt"; sessionId: string; text: string; images?: PromptImage[] }
  | { type: "cancel"; sessionId: string }
  | { type: "set_option"; reqId: string; sessionId: string; configId: string; value: string }
  | { type: "permission_answer"; sessionId: string; requestId: string; optionId: string | null }
  | { type: "subscribe"; sessionId: string; sinceSeq: number }
  | { type: "network"; reqId: string; sessionId: string }
  /** Open a folder of the sandbox in an editor on this machine (Remote-SSH through the gateway). */
  | { type: "open_editor"; reqId: string; sandbox: string; editor: EditorId; folder: string }
  /** Add "remote.SSH.localServerDownload": "always" to the editor's user settings. */
  | { type: "editor_setting"; reqId: string; editor: EditorId }
  /**
   * Repository actions for a sandbox. link: clone `source` (a URL) into `dest`, or use
   * `source` as a host path, and send it in. send: pull base from origin and send it in.
   * get: fetch the agent's commits out, then review. merge: merge the branch into base
   * on the host. push: push base to origin. unlink: forget the link (no files change).
   */
  | {
      type: "repo";
      reqId: string;
      sandbox: string;
      op: RepoOp;
      repo?: string;
      source?: string;
      base?: string;
      dest?: string;
    }
  /**
   * The catalog. list: everything in it, and with `sandbox` what that sandbox has.
   * preview: an item's main file as it would go in. install / remove: in `sandbox`.
   */
  | { type: "catalog"; reqId: string; op: CatalogOp; sandbox?: string; kind?: CatalogKind; name?: string };

// ---- bridge -> browser

export type ServerMessage =
  | {
      type: "hello";
      agents: AgentInfo[];
      sessions: SessionInfo[];
      canCreate: boolean;
      createNote?: string;
      /** Editors whose command line was found, for "Open in …". */
      editors: EditorInfo[];
      build: ServerBuild;
    }
  /** The bridge's code on disk changed (or was reverted) since it started. */
  | { type: "server_build"; build: ServerBuild }
  | { type: "sandboxes"; sandboxes: SandboxRow[]; error?: string }
  | {
      type: "sandbox_types";
      reqId: string;
      types: SandboxType[];
      build: ImageBuild | null;
      /** Why images can't be built from here, if they can't. */
      buildNote?: string;
    }
  | {
      type: "ports";
      reqId: string;
      sandbox: string;
      forwards: PortForward[];
      listening: ListeningPort[];
      presets: PortPreset[];
      /** What a start or stop did. */
      log: string[];
      /** Couldn't look into the sandbox. */
      error?: string;
    }
  | { type: "rules"; reqId: string; sandbox: string; rules: RuleProposal[]; log: string[]; error?: string }
  | { type: "files"; reqId: string; sandbox: string; path: string; entries: FileEntry[]; truncated: boolean }
  /** Progress of an image build, to every tab. */
  | { type: "image_build"; build: ImageBuild }
  | { type: "gateway"; gateway: GatewayStatus }
  | { type: "session_opened"; reqId?: string; session: SessionInfo }
  | { type: "session_info"; session: SessionInfo }
  /** A thread was deleted (by any tab, or because its sandbox is gone). */
  | { type: "thread_deleted"; reqId?: string; sessionId: string }
  | { type: "replay_done"; sessionId: string; lastSeq: number }
  | { type: "past_sessions"; reqId: string; sessionId: string; sessions: PastSession[]; error?: string }
  | { type: "network"; reqId: string; sessionId: string; hosts: NetworkHost[]; error?: string }
  | { type: "result"; reqId: string; ok: boolean; message?: string; hint?: string }
  | { type: "editor_opened"; reqId: string; log: string[]; needsSetting: boolean }
  /** What a repo action did, step by step, and the review if it produced one. */
  | { type: "repo_result"; reqId: string; sandbox: string; repo: string | null; log: string[]; review?: RepoReview }
  | {
      type: "catalog";
      reqId: string;
      items: CatalogItem[];
      /** Where to put your own: agents/, skills/ and context/ under it. */
      folder: string;
      sandbox?: SandboxCatalog;
      preview?: string;
      log: string[];
    }
  | { type: "error"; reqId?: string; sessionId?: string; message: string; detail?: string; hint?: string }
  | SessionEvent;
