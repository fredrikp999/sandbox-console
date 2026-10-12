# Sandbox Console: design

A local web app that lists your OpenShell sandboxes and lets you work with the coding agent in each one over ACP (Agent Client Protocol). The agent stays inside its sandbox. The console shows what it does and asks you before it acts.

`mockup.html` next to this file is a clickable mockup. Open it in a browser. "Show ACP wiring" overlays the ACP message behind each part of the screen. Its conversation, file and network data are examples.

## Contents
1. [Background](#1-background)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Architecture](#3-architecture)
4. [Talking to the agent](#4-talking-to-the-agent-what-is-already-proven)
5. [UI](#5-ui)
6. [Screen to ACP mapping](#6-screen-to-acp-mapping)
7. [Bridge](#7-bridge)
8. [Security](#8-security)
9. [Tech stack](#9-tech-stack)
10. [Phases](#10-phases)
11. [Open questions](#11-open-questions)
12. [References](#12-references)

## 1. Background
- **OpenShell** (NVIDIA) runs coding agents in sandboxes, as containers on Podman. A local **gateway** manages them, and the `openshell` CLI talks to the gateway.
  - **Network rules:** each sandbox has a policy that controls which hosts it may reach.
  - **Credentials:** API keys and tokens come from **providers** stored in the gateway, so the real key never lives in the sandbox.
- **Agents:** the [openshell-configs](https://github.com/fredrikp999/openshell-configs) repo sets up two agents:
  - **OpenCode** with OpenRouter: image `opencode-sandbox`, provider `openrouter`.
  - **Claude Code** with a Claude subscription: image `claude-sandbox`, provider `claude`.
- **Starting a sandbox:** `./sandbox.sh <agent> [name]` creates the sandbox on first use, running `sleep infinity` as its main process, and reuses it after that.
- **ACP** is JSON-RPC 2.0 over the agent's stdin and stdout, one JSON object per line. The client sends prompts. The agent streams back text, plans and tool calls, and asks the client for permission before it acts.
- **Proven so far:** the openshell-configs repo already has a working terminal client, `acp_client.py`. `sandbox.sh --acp` runs the agent in ACP mode. The console builds on what those two proved.

## 2. Goals and non-goals
**Goals**
- See all sandboxes and their state at a glance: working, waiting for you, or idle.
- Chat with the agent in any sandbox, with streaming replies, the agent's plan and tool calls.
- Approve or reject the agent's actions from the UI.
- Pick the model per session, and use the agent's slash commands.
- Run several sandboxes at once, and come back to a session after closing the tab.
- Keep the sandbox's isolation intact.

**Non-goals**
- **No code editor.** Use VS Code with `openshell sandbox connect <name> --editor vscode` for that.
- **No remote or multi-user hosting.** The console runs on your own machine, for you.
- **No changes to OpenShell, images or policies.** The console only drives what exists.

## 3. Architecture
```
┌────────────── your machine ───────────────────────────────────┐   ┌── sandbox ──────────┐
│                                                               │   │                     │
│  Browser UI  ── WebSocket ──▶  Bridge  ── stdio ──▶ openshell ─┼─▶ │  opencode acp       │
│  (React,        (ACP JSON +    (Node,     (one       sandbox   │   │  policy, provider   │
│   127.0.0.1)     console msgs)  sessions)  process   exec      │   │  credential         │
│                                            per session)       │   │                     │
└───────────────────────────────────────────────────────────────┘   └─────────────────────┘
```
- A browser can't start processes, so a small **bridge** does it. The bridge serves the UI and runs one `openshell sandbox exec` process per open session. It relays ACP between that process and the browser.
- **No port is opened in the sandbox.** The connection goes through the gateway, like VS Code's SSH tunnel.
- The bridge also covers what ACP doesn't: listing, creating and deleting sandboxes, the gateway status and logs.
- Sessions live in the bridge, not in the tab. Closing the browser doesn't stop the agent, and reopening replays the session.

## 4. Talking to the agent (what is already proven)
All of this was tested with `acp_client.py` against OpenCode 1.18.35.

**Start command, per session:**
```sh
openshell sandbox exec <sandbox> --no-tty --no-login-shell --workdir <dir> \
  --env 'OPENCODE_CONFIG_CONTENT={"model":"<model>"}' -- opencode acp
```
- **`--no-tty`:** a pty corrupts the JSON stream.
- **`--no-login-shell`:** shell profile output would otherwise reach stdout before the first message.
- **No `-m` flag:** `opencode acp` doesn't take one. Without a model in `OPENCODE_CONFIG_CONTENT`, OpenCode picks an `opencode/…` model. `opencode.ai` is blocked by the sandbox, so prompts then fail with "Cannot connect to API".
- **stderr:** the agent's stderr is log output. Keep the last lines and show them when something fails.

**Handshake:**
1. `initialize` with `{"protocolVersion": 1, "clientCapabilities": {}}`. The reply includes `agentInfo` (name, version) and `agentCapabilities`. OpenCode supports `loadSession`, image prompts, and listing, resuming and forking sessions.
2. `session/new` with `{"cwd": "/sandbox", "mcpServers": []}`. The reply includes:
   - **`sessionId`**
   - **`configOptions`:** contains the model selector, `{"id": "model", "category": "model", "type": "select", "currentValue": …, "options": [{value, name}, …]}`. With OpenRouter that is about 400 models.
3. Right after that, the agent sends `session/update` with `available_commands_update`. OpenCode's commands are `/init`, `/review` and `/customize-opencode`.

**During use:**
- **Prompt:** `session/prompt` with `{"sessionId", "prompt": [{"type": "text", "text": …}]}`. The reply comes when the turn ends, with `stopReason` set to `end_turn`, `cancelled`, `refusal` or similar. In between, the agent sends `session/update` notifications:
  - `agent_message_chunk`: reply text.
  - `agent_thought_chunk`: the agent's reasoning.
  - `plan`: the full plan, replaced on every update.
  - `tool_call` and `tool_call_update`: id, title, kind, status, content and locations.
  - `config_option_update`: changed session options.
- **Approvals:** the agent sends `session/request_permission` with `toolCall` and `options` (`optionId`, `name`, `kind`), and waits. Reply with `{"outcome": {"outcome": "selected", "optionId": …}}`, or `{"outcome": {"outcome": "cancelled"}}`.
- **Change model:** `session/set_config_option` with `{"sessionId", "configId": "model", "value": …}`. The reply carries the updated `configOptions`.
- **Stop:** send the `session/cancel` notification, then keep waiting for the `session/prompt` reply, which ends with `cancelled`.
- **Gotcha:** OpenCode's TUI command `/models` is not an ACP command. Sent as a prompt, it reaches the model as plain text and nothing useful comes back. Model choice goes through `configOptions` only.

**Claude Code:**
- It has no native ACP mode. The `claude-sandbox` image has the adapter `@agentclientprotocol/claude-agent-acp` (successor to `@zed-industries/claude-code-acp`), started as `claude-acp-start`, which first skips onboarding.
- The provider profile's `binaries` list may need updating so the adapter's `claude` process can use the token.
- None of this is tested yet. On an older image without the adapter, the exec fails with exit code 127 and `claude-acp-start: not found`.

## 5. UI
Three columns. Narrow screens hide the right column. Phone width stacks everything, with the sandbox list as a horizontal strip.

### Left: sandboxes
- **Gateway line:** a status dot with "Gateway `openshell` · connected", from `openshell status`.
- **Sandbox rows:** one per sandbox, showing:
  - a status dot and pill: **Working** (a prompt is running), **Waiting** (a permission request is open, shown in amber), **Ready** (no open session), or the OpenShell phase when it isn't Ready (Provisioning, Error);
  - the name in monospace;
  - one meta line: agent and last activity, "Needs approval", or "No open session".
- **"New sandbox" button:** opens a form with name, agent (OpenCode or Claude Code) and working directory. It runs `./sandbox.sh` or the same `openshell sandbox create` call.
- **Ordering:** sandboxes waiting for you sort to the top.

### Middle: conversation
- **Header:** the sandbox name, the agent and version, the working directory, and a **model picker**. The picker has search, because the list is long, and the current model is preselected.
- **Log, in order:**
  - **Your messages:** right-aligned bubbles.
  - **Agent text:** streamed and rendered as Markdown.
  - **Thinking:** a collapsed "Thinking" line. It expands to the thought text.
  - **Plan:** a checklist, with done items struck through and the current one marked.
  - **Tool cards:** each shows the kind (read, edit, exec…), title, status and duration. A coloured left edge shows the status: running, done or failed. Expanding a card shows the diff or output. Edit diffs are open by default.
  - **Permission card:** amber, stating what the agent wants to do ("The agent wants to run a command `pytest -q …`"). It has one button per agent option. Once answered, it collapses into a grey line with the choice ("Allowed once · pytest -q …").
  - **Errors:** inline, with what failed and how to fix it, for example "the model's API host is blocked by the sandbox policy, pick another model".
- **Composer:** a multi-line box with a Send button. **Enter** sends, **Shift+Enter** adds a new line, **Esc** stops the agent.
- **Slash menu:** typing `/` opens it, grouped into:
  - **Agent** commands from `available_commands_update`, sent as prompts;
  - **Console** commands handled locally: `/model`, `/bundle`, `/clear` (new session).

  Unknown `/words` are not sent silently. The UI says they aren't commands.

### Right: session
- **Details:** agent command, working directory, session id, and token usage if the agent reports it.
- **Files changed:** collected from tool call `locations` and diffs, with +/− counts. A **"Download as git bundle"** button follows the README's bundle workflow.
- **Network this session:** hosts allowed and denied, with counts. Needs `openshell logs`, see open questions.
- **Approvals:** the current rule in one sentence, e.g. "Ask before running commands. Edits inside /sandbox are allowed." Phase 2 adds per-session "always allow" memory.

### Visual direction
- **Calm and technical.** Cool grey neutrals tinted toward one teal accent, which marks the containment. Amber is used only for things that need you (permissions). Green and red are for status.
- **Type:** Bricolage Grotesque for headings, Instrument Sans for text, JetBrains Mono for names, paths, commands and models.
- **Themes:** light and dark from the start, through CSS variables.
- **Status is shown by form as well as colour:** a pill, the coloured edge on tool cards, the amber card.

## 6. Screen to ACP mapping
| On screen | Message | Notes |
|---|---|---|
| Sandbox list and status | `openshell sandbox list` | Not ACP. The bridge polls it every few seconds. |
| Gateway status | `openshell status` | Not ACP. |
| Opening a sandbox | `initialize` → `session/new` | Bridge spawns the exec command in section 4. |
| Reopening a past session | `session/load` | OpenCode advertises `loadSession`. |
| Model picker | `configOptions`, `session/set_config_option` | Watch for `config_option_update`. |
| Slash menu | `available_commands_update` | Plus console-only commands. |
| Streaming reply | `agent_message_chunk` | Markdown. |
| Thinking line | `agent_thought_chunk` | Collapsed by default. |
| Plan checklist | `plan` | Replaced in full on each update. |
| Tool cards | `tool_call`, `tool_call_update` | Diffs and output on expand. Locations feed "Files changed". |
| Permission card | `session/request_permission` | Buttons are the agent's `options`. |
| Stop / Esc | `session/cancel` | Turn ends with `stopReason: cancelled`. |
| Files changed | `tool_call` content (`diff`) and `locations` | |
| Network | `openshell logs` | Not ACP. To be verified. |
| Create / delete sandbox | `openshell sandbox create` / `delete` | Not ACP. |
| Git bundle | `openshell sandbox exec … git bundle`, then `download` | Not ACP. Same as the openshell-configs README. |

## 7. Bridge
**Responsibilities**
- **Serve the UI** on `127.0.0.1:<port>`.
- **Wrap the `openshell` CLI** for sandboxes: list (polled), create, delete, status.
- **Session manager:** one `openshell sandbox exec … opencode acp` child process per session, keyed by sandbox and session id.
  - Uses an ACP client library (`@agentclientprotocol/sdk`) on the stdio side.
  - Keeps a per-session event log in memory (optionally on disk) so a reconnecting tab can replay it.
  - Keeps the last 50 stderr lines for error reports.
  - If the child process exits, marks the session dead and shows the exit code, stderr tail and a hint. For example, exit code 127 means the agent command is missing from the image.
- **Relay to the browser** over one WebSocket per tab.

**Browser ↔ bridge protocol (proposal)**

JSON messages over the WebSocket, with a `type` field.
- **Browser to bridge:**
  - `list_sandboxes`, `create_sandbox {name, agent, workdir}`, `delete_sandbox {name}`
  - `open_session {sandbox, agent, cwd, model}`, which replies `session_opened {sessionId, agentInfo, configOptions, commands}`
  - `prompt {sessionId, text}`, `cancel {sessionId}`
  - `set_option {sessionId, configId, value}`
  - `permission_answer {sessionId, requestId, optionId | null}`
  - `subscribe {sessionId, sinceSeq}` to replay events after reconnecting
- **Bridge to browser:**
  - `sandboxes [{name, phase, created, agent?, activity}]`
  - `event {sessionId, seq, update}`: a raw ACP `session/update` payload, numbered so it can be replayed
  - `permission_request {sessionId, requestId, toolCall, options}`
  - `turn_end {sessionId, stopReason}`
  - `error {sessionId?, message, detail, hint}`
  - `session_closed {sessionId, exitCode, stderrTail}`

Keeping ACP's `session/update` payloads as they are means the UI can follow the ACP spec directly, and the bridge stays thin.

**Agent registry.** Config in the bridge, not hard-coded in the UI:
```json
{
  "opencode": {"cmd": ["opencode", "acp"], "modelEnv": "OPENCODE_CONFIG_CONTENT", "defaultModel": "openrouter/nvidia/nemotron-3.5-lightning:free"},
  "claude":   {"cmd": ["claude-acp-start"]}
}
```
**Knowing which agent a sandbox has.** `openshell sandbox list` doesn't show the image. Options:
- (a) name convention (`opencode-*`, `claude-*`), as `sandbox.sh` defaults do;
- (b) `openshell sandbox get <name>`, if it shows the image;
- (c) ask once and remember it per sandbox.

Start with (b), falling back to (c).

## 8. Security
- **Advertise no client `fs` or `terminal` capability** in `initialize`. Otherwise the agent may ask the console to read, write or run things on the *host*. Refuse any `fs/*` or `terminal/*` request with JSON-RPC error `-32601`.
- **Localhost only, with a random token.** The bridge binds to `127.0.0.1` and requires a random token, printed at start-up and passed in the URL fragment, then kept in `localStorage`. Without it, other local users or any web page could drive your agents over the WebSocket. The token is sent as a WebSocket subprotocol and as a `Bearer` header on `/api/*`. No cookie is used, because cookies are shared by all ports on `127.0.0.1` and would reach any other local server. Check the `Origin` and `Host` headers too.
- **No credentials** in the bridge or the UI. Providers stay in the OpenShell gateway.
- **Sandbox policy rules unchanged.** The console opens no ports and changes no network rules.
- **Code leaves the sandbox only through git bundles you review**, as in the openshell-configs README.
- **Agent output is untrusted.** Render Markdown without raw HTML, and sanitize everything.

## 9. Tech stack
- **Bridge:** Node 22+, TypeScript, `@agentclientprotocol/sdk`, `ws`, plus a small HTTP server (Fastify or plain `node:http`). Calls the `openshell` CLI with `child_process.spawn`, never through a shell, with arguments passed as an array.
- **UI:** React with Vite. Use a Markdown renderer with HTML disabled, a diff view (e.g. `react-diff-view`), and CSS variables for theming. A component library is optional; the mockup uses plain CSS.
- **Start-up:** `npm start` or `./console.sh` starts the bridge, prints `http://127.0.0.1:<port>/#token=…`, and opens it.
- **Later:** wrap in Tauri for a desktop app. The bridge becomes the sidecar, and the UI doesn't change.

## 10. Phases
1. **Chat with one sandbox.** Sandbox list, open a session, streaming replies, tool cards, permission cards, stop, error display. The same scope as `acp_client.py`, plus the UI.
2. **Work across sandboxes.** Several live sessions, status pills (Working, Waiting, Ready), searchable model picker, slash menu, replay after reconnect, `session/load` for past sessions, create and delete sandboxes.
3. **Review and ship.** Files changed with diffs, git bundle download, network view, Claude Code once its ACP adapter is in the image.

## 11. Open questions
- **Network view:** does `openshell logs <sandbox>` report policy denials, with host and binary, in a parseable form? The network view depends on it.
- **Sandbox image:** does `openshell sandbox get <name>` show the image, so the bridge can tell OpenCode and Claude sandboxes apart?
- **Exec over long sessions:** does the gRPC `sandbox exec` stream stay stable for hours, and through gateway restarts? The fallback is `ssh -T openshell-<name>.default opencode acp`.
- **Claude adapter:** does it work in the sandbox with the `claude-code-oauth` profile, and which binary paths does the profile need?
- **Approval memory:** should "always allow" be remembered per session, per sandbox or globally? ACP's `allow_always` option is the agent's own memory, so the UI may only need to show it.
- **Token usage:** OpenCode may report usage through a session update. Check before designing the counter.

## 12. References
- ACP spec: https://agentclientprotocol.com
- ACP TypeScript SDK: `@agentclientprotocol/sdk`
- OpenShell: https://github.com/NVIDIA/OpenShell
- openshell-configs: https://github.com/fredrikp999/openshell-configs. See `README.md` sections "ACP (Agent Client Protocol)" and "Getting code in and out", `sandbox.sh --acp`, and `acp_client.py`, the reference client for everything in section 4.
- Claude Code ACP adapter: `@agentclientprotocol/claude-agent-acp`
