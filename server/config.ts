// Agent registry (server/agents.json) and the small amount of state the console
// remembers per sandbox (agent, working directory, model).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, AgentInfo, InstalledItem, RepoLink } from "../shared/protocol.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AgentConfig {
  id: AgentId;
  label: string;
  cmd: string[];
  /** Env var through which the model is chosen at start-up (OpenCode). */
  modelEnv?: string;
  defaultModel?: string;
  image?: string;
  provider?: string;
  /** Shown when the agent command is missing from the image (exit 127). */
  missingHint?: string;
  /** Where it looks for agents, skills and global instructions: "claude" (~/.claude), "opencode" (~/.config/opencode) or "agy" (~/.gemini/config, skills and context only). */
  layout?: "claude" | "opencode" | "agy";
}

export function loadAgents(): Map<AgentId, AgentConfig> {
  const file = process.env.CONSOLE_AGENTS ?? join(ROOT, "server", "agents.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Omit<AgentConfig, "id">>;
  return new Map(Object.entries(raw).map(([id, a]) => [id, { id, ...a, label: a.label ?? id }]));
}

export function agentInfo(a: AgentConfig): AgentInfo {
  return { id: a.id, label: a.label, cmd: a.cmd, hasModelEnv: !!a.modelEnv };
}

/** The openshell-configs checkout (its policies and image Dockerfiles), if we can find it. */
export function findConfigs(): string | undefined {
  const dirs = [
    process.env.OPENSHELL_CONFIGS,
    join(homedir(), "openshell-configs", "openshell-configs"),
    join(homedir(), "openshell-configs"),
    join(ROOT, "..", "openshell-configs"),
  ].filter(Boolean) as string[];
  return dirs.find((d) => existsSync(join(d, "policies", "vscode-terminal.yaml")));
}

/** The policy sandbox.sh uses when it creates sandboxes, if we can find it. */
export function findPolicy(): string | undefined {
  if (process.env.OPENSHELL_POLICY) return process.env.OPENSHELL_POLICY;
  const d = findConfigs();
  return d && join(d, "policies", "vscode-terminal.yaml");
}

export interface Remembered {
  agent?: AgentId;
  /** The sandbox type it was created as, by the console. */
  type?: string;
  cwd?: string;
  model?: string;
  repos?: RepoLink[];
  /** What the console put in from the catalog. */
  catalog?: InstalledItem[];
}

export class StateStore {
  private data: { sandboxes: Record<string, Remembered> } = { sandboxes: {} };
  constructor(readonly file = process.env.CONSOLE_STATE ?? join(homedir(), ".config", "sandbox-console", "state.json")) {
    try {
      this.data = JSON.parse(readFileSync(file, "utf8"));
      this.data.sandboxes ??= {};
    } catch {
      /* first run */
    }
  }

  get(name: string): Remembered {
    return this.data.sandboxes[name] ?? {};
  }

  set(name: string, patch: Remembered) {
    this.data.sandboxes[name] = { ...this.get(name), ...patch };
    this.save();
  }

  forget(name: string) {
    delete this.data.sandboxes[name];
    this.save();
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`warning: cannot save ${this.file}: ${(e as Error).message}`);
    }
  }
}
