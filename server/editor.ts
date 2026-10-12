// "Open in VS Code": a Remote-SSH window on a folder in the sandbox. OpenShell
// tunnels SSH through the gateway (`openshell ssh-proxy`) and keeps one host entry
// per sandbox in ~/.config/openshell/ssh_config, which ~/.ssh/config includes once
// `openshell sandbox connect --editor` has run. We make sure the entry is there,
// then start the editor's CLI on the folder.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";
import type { EditorId, EditorInfo } from "../shared/protocol.ts";
import { CliError, runOk } from "./openshell.ts";

const home = homedir();
const mac = platform() === "darwin";

const EDITORS: Record<EditorId, { label: string; cli: string[]; settings: string }> = {
  vscode: {
    label: "VS Code",
    cli: [process.env.CONSOLE_VSCODE ?? "", "code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
    settings: mac ? join(home, "Library/Application Support/Code/User/settings.json") : join(home, ".config/Code/User/settings.json"),
  },
  cursor: {
    label: "Cursor",
    cli: [process.env.CONSOLE_CURSOR ?? "", "cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"],
    settings: mac ? join(home, "Library/Application Support/Cursor/User/settings.json") : join(home, ".config/Cursor/User/settings.json"),
  },
};

const SSH_CONFIG = join(home, ".ssh", "config");
const MANAGED = join(home, ".config", "openshell", "ssh_config");
/** VS Code Server is downloaded by your machine and copied in; the sandbox can't reach Microsoft's servers. */
const SETTING = "remote.SSH.localServerDownload";
/** Folders as the console and agents make them; nothing that could leave the path in a URI. */
const FOLDER = /^\/(?:[A-Za-z0-9._@+-]+\/?)*$/;

function isFile(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function findCli(id: EditorId): string | null {
  for (const c of EDITORS[id].cli.filter(Boolean)) {
    if (c.includes("/")) {
      if (isFile(c)) return c;
      continue;
    }
    for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir && isFile(join(dir, c))) return join(dir, c);
  }
  return null;
}

/** The editors whose command line we can find, checked once at start-up. */
export function availableEditors(): EditorInfo[] {
  return (Object.keys(EDITORS) as EditorId[]).filter((id) => findCli(id)).map((id) => ({ id, label: EDITORS[id].label }));
}

export const isEditor = (v: string): v is EditorId => Object.hasOwn(EDITORS, v);

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** Is the setting in the editor's user settings? Unknown (no settings file) counts as missing. */
export function hasServerSetting(id: EditorId): boolean {
  return read(EDITORS[id].settings).includes(`"${SETTING}"`);
}

/** The settings text with `"remote.SSH.localServerDownload": "always"` added (JSON with comments; trailing commas are fine there). Null if it can't tell where. */
export function withServerSetting(text: string): string | null {
  if (text.includes(`"${SETTING}"`)) return text;
  const line = `\n  "${SETTING}": "always",`;
  if (!text.trim()) return `{${line}\n}\n`;
  const at = text.indexOf("{");
  return at < 0 ? null : text.slice(0, at + 1) + line + text.slice(at + 1);
}

export function addServerSetting(id: EditorId) {
  const file = EDITORS[id].settings;
  const next = withServerSetting(read(file));
  if (next === null) throw new CliError(`Can't read ${file}`, "", `Add "${SETTING}": "always" to it yourself.`);
  writeFileSync(file, next);
}

export interface OpenResult {
  log: string[];
  /** The editor will likely fail to install its server in the sandbox without SETTING. */
  needsSetting: boolean;
}

export async function openEditor(id: EditorId, sandbox: string, folder: string): Promise<OpenResult> {
  if (!FOLDER.test(folder) || folder.split("/").includes(".."))
    throw new CliError(`Can't open ${JSON.stringify(folder)}`, "", "Give an absolute path in the sandbox.");
  const cli = findCli(id);
  const { label } = EDITORS[id];
  if (!cli) {
    throw new CliError(
      `The ${label} command line wasn't found`,
      "",
      id === "vscode"
        ? "In VS Code, run Shell Command: Install 'code' command in PATH, then restart the console (or set CONSOLE_VSCODE)."
        : "Install Cursor's command line, or set CONSOLE_CURSOR.",
    );
  }
  const log: string[] = [];
  const [entry, policy] = await Promise.all([
    runOk(["sandbox", "ssh-config", sandbox]),
    runOk(["policy", "get", sandbox, "--base"]).catch(() => null),
  ]);
  const alias = /^Host\s+(\S+)/m.exec(entry)?.[1];
  if (!alias) throw new CliError("openshell sandbox ssh-config printed no Host entry", entry.slice(0, 300));

  if (!read(SSH_CONFIG).includes(".config/openshell/ssh_config")) {
    // Never set up on this machine: OpenShell adds the Include to ~/.ssh/config and opens the window itself (on the home folder).
    await runOk(["sandbox", "connect", sandbox, "--editor", id], 120_000);
    log.push(
      `OpenShell set up SSH for its sandboxes and opened ${label}. Use File > Open Folder for ${folder}; next time the console opens it directly.`,
    );
  } else {
    const managed = read(MANAGED);
    if (!managed.split("\n").some((l) => l.trim() === `Host ${alias}`)) {
      // The same entry OpenShell writes for `connect --editor`.
      appendFileSync(MANAGED, `${managed && !managed.endsWith("\n") ? "\n" : ""}${managed ? "\n" : ""}${entry.trim()}\n`);
      log.push(`Added the SSH host ${alias} to ${MANAGED.replace(home, "~")}.`);
    }
    const child = spawn(cli, ["--folder-uri", `vscode-remote://ssh-remote+${alias}${folder}`], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    log.push(`Opening ${folder} in ${label} over SSH (${alias}). The first time takes up to a minute while ${label} Server is copied in.`);
  }
  if (policy !== null && !policy.includes("/dev/pts")) {
    log.push(
      `warning: ${sandbox} was created without the terminal policy, so ${label}'s terminal won't start (forkpty failed). Create the sandbox again with policies/vscode-terminal.yaml.`,
    );
  }
  return { log, needsSetting: !hasServerSetting(id) };
}
