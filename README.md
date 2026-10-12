# Sandbox Console

A local web app for the coding agents in your [OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes. It lists your sandboxes and lets you chat with the agent in each one over [ACP](https://agentclientprotocol.com) (Agent Client Protocol). The agent stays inside its sandbox. The console shows what it does and asks you before it acts.

- **All sandboxes at a glance:** each one shows whether its agent is working, waiting for you, or idle. Sandboxes waiting for you sort to the top.
- **Chat:** streamed replies, the agent's plan, its thinking, and a card for each tool call, with diffs for edits.
- **Approvals:** permission requests appear as cards. You answer with the agent's own options, each labelled with what it actually does.
- **Models and commands:** a searchable model picker (OpenRouter offers about 400 models) and a `/` menu with the agent's commands.
- **Sessions keep running** when you close the tab, and the conversation is replayed when you come back. A sandbox can have several threads (conversations) side by side; switch between them or start a new one. Earlier threads can be reopened.
- **Review:** files changed, hosts the sandbox reached or was denied, and the agent's commits downloaded as a git bundle.

The design is in [docs/DESIGN.md](docs/DESIGN.md), and [docs/mockup.html](docs/mockup.html) is a clickable mockup.

## Requirements

- Node 22 or later.
- `openshell` on your PATH, with a running gateway (`openshell status`).
- Sandboxes, images and providers set up with [openshell-configs](https://github.com/fredrikp999/openshell-configs): the `opencode-sandbox` image with the `openrouter` provider, and/or `claude-sandbox` with `claude`.

## Quick start

```sh
git clone https://github.com/fredrikp999/sandbox-console.git
cd sandbox-console
./console.sh
```

`./console.sh` installs dependencies when they've changed, builds the UI, starts the bridge on `127.0.0.1:7801` and opens the console in your browser. It prints the address too:

```
Sandbox Console is running.

  http://127.0.0.1:7801/#token=…
```

The token is new each time the bridge starts. The page moves it out of the address bar and keeps it in the browser, so reloads and new tabs work. After a restart, open the new address.

Other ways to start it:

```sh
./console.sh --port 7900 --no-open   # another port, don't open the browser
npm start                            # build and start, don't open the browser
```

### Try it without a gateway

```sh
OPENSHELL_BIN=test/fixtures/fake-openshell.mjs ./console.sh
```

This uses a fake `openshell` with a scripted agent:
- **Normal prompt:** the agent shows a plan, makes an edit with a diff, asks permission to run a command, and makes a host file request that the console refuses.
- **Prompt containing "fail":** the agent returns an API error, so you can see how errors are shown.
- **`claude-demo`:** shows the error for an image without the ACP adapter.

## Using it

**Sandboxes (left).** Click a sandbox to open it.
- **No agent session yet:** pick the agent if the console can't tell which one the sandbox has, then the working directory, then **Start session**.
- **New sandbox:** creates one the same way `sandbox.sh` does: it runs `sleep infinity`, gets the openshell-configs policy, and stays around until you delete it.

**Conversation (middle).**

| Key | |
|---|---|
| <kbd>Enter</kbd> | send |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | new line |
| <kbd>Esc</kbd> | stop the agent |
| <kbd>/</kbd> | command menu |

The `/` menu has the agent's own commands (OpenCode: `/init`, `/review`, …) and three console commands:

| Command | |
|---|---|
| `/model [search]` | switch model for this session |
| `/bundle [dir]` | download the agent's commits as a git bundle |
| `/new` | start another thread in this sandbox |

Anything else starting with `/` isn't sent, because it would reach the model as plain text. Start with a space to send it anyway.

**Permission cards.** When the agent asks before acting, answer with one of its options. Each button also shows what it does ("allows once", "allows always", "rejects"), because the label is the agent's own text. Stop (<kbd>Esc</kbd>) answers an open request with "cancelled".

**Session (right).**
- **Details:** the agent command, directory, session id and token usage.
- **Files changed:** click a file to jump to its edit.
- **Download as git bundle:** see below.
- **Network this session:** from `openshell logs`.
- **Threads:** the tabs above the conversation. Each is its own ACP session with its own history, model and pending approvals, so one can wait for you while another works.
- **Earlier threads:** reopen one with `session/load`; it becomes another thread.
- **Repository:** bring a repo in, get the agent's work out, review and merge it. See below.
- **Stop the agent process** and **Delete sandbox**.

**Working on a repository.** The **Repository** block in the right column does what openshell-configs' `bundle.sh` does, plus the host side around it.
- **Bring into sandbox:** give a URL (`git@github.com:you/app.git`, `https://…`) or a path on this machine (`~/code/app`). A URL is cloned here, into `~/sandbox-repos/<name>` unless you choose a directory, with your own git credentials. The base branch (origin's default unless you name one) goes into the sandbox as a git bundle: `/sandbox/<name>`, on branch `agent/<sandbox>`. New sessions in that sandbox start in that directory.
- **Send latest:** pulls the base branch from origin here (fast-forward only; local commits are never rewritten), then sends it into the sandbox as `host/<base>`. Ask the agent to merge or rebase it.
- **Get changes:** the commits on `agent/<sandbox>` that aren't in `host/<base>` come out as a bundle and are fetched into your repo as branch `agent/<sandbox>`. The review opens.
- **Review:** the commits and the diff of each file, `<base>...agent/<sandbox>`.
- **Merge into `<base>`:** a fast-forward if `<base>` hasn't moved, otherwise a merge commit. If `<base>` is checked out, that work tree must have no uncommitted changes and is updated; if not, only the branch moves. On conflicts nothing changes: send the latest base in and let the agent merge it. After a merge the base is sent into the sandbox again.
- **Push `<base>` to origin:** a separate button, after the merge.
- **What the sandbox gets:** only bundles of the base branch. No other branches, no remote, no credentials. Git with credentials runs only on this machine, and never prompts (a prompt would hang): use SSH keys in ssh-agent or a credential helper.
- **Unlink** forgets the link. No files are deleted.


**Getting code out without a linked repository.** Have the agent commit, then use **Download as git bundle** (or `/bundle <dir>`).
- **What's in it:** the commits on the current branch of the session's directory that aren't in `host/main` or `host/master`. Those branches exist when the repo came in through openshell-configs' `bundle.sh in`; without them, the whole branch.
- **Taking it into your repo:** `git fetch <file> <branch>:<branch>`, then review before you push.

## Configuration

| Setting | |
|---|---|
| `server/agents.json` | Agent registry: the command that starts each agent in ACP mode, how its model is chosen, default model, image and provider for "New sandbox", and the hint shown when the command is missing. `CONSOLE_AGENTS` points at another file. |
| `CONSOLE_PORT`, `--port` | Port on 127.0.0.1. Default 7801. |
| `OPENSHELL_BIN` | The `openshell` CLI. Default `openshell` on the PATH. |
| `OPENSHELL_CONFIGS` | Your openshell-configs checkout. New sandboxes get its `policies/vscode-terminal.yaml`. Also looked for in `~/openshell-configs/openshell-configs`. |
| `OPENSHELL_POLICY` | A policy file for new sandboxes, instead of the one above. |
| `CONSOLE_STATE` | Where the agent, directory and model per sandbox are remembered. Default `~/.config/sandbox-console/state.json`. Threads (their conversations) are saved in a `threads/` folder next to it. |
| `CONSOLE_REPOS` | Where repositories given as a URL are cloned. Default `~/sandbox-repos`. |
| `CONSOLE_TOKEN` | A fixed access token instead of a random one (at least 8 characters of `A-Z a-z 0-9 _ -`). Mainly for scripting and tests. |

## Security

- **Nothing runs on your machine for the agent.** The console offers the agent no file or terminal access on the host, and refuses such requests (`-32601`). The agent works only inside its sandbox, under its network policy, with credentials that stay in the OpenShell gateway.
- **Only you can drive it.**
  - **Network:** the bridge listens on 127.0.0.1 only.
  - **Token:** every request needs the token, sent as a WebSocket subprotocol and as a `Bearer` header, never as a cookie. Cookies are shared by every port on 127.0.0.1, so any other local server could read one.
  - **Headers:** `Host` and `Origin` are checked.
  - **`--open`:** hands the address to the browser through a private file, so other users can't read the token from the process list.
- **Agent output is untrusted.** It's rendered as Markdown without HTML or remote images, under a strict Content Security Policy. Sandbox names and other input from the browser are checked before they reach the `openshell` CLI.
- **Code leaves the sandbox only as git bundles you review.**

## Development

```sh
npm run check       # typecheck + lint + tests (CI also runs the build)
npm test            # unit tests + an end-to-end bridge test against the fake CLI
npm run typecheck   # tsc -b over server/, web/ and the UI tests
npm run lint        # Biome: lint, formatting and import order
npm run format      # Biome: fix what it can
npm run dev & npm run dev:web    # bridge with --dev, plus Vite on :5173 with hot reload
```

- **Formatting and linting:** [Biome](https://biomejs.dev) (`biome.jsonc`). typescript-eslint doesn't support TypeScript 7 yet.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request.
- **Tests:** `*.test.ts` files sit next to the code they test.

### Layout

```
server/              the bridge (Node, TypeScript, run with tsx)
  index.ts             HTTP + WebSocket on 127.0.0.1: token auth, Host and Origin checks, CSP, /api/bundle
  bridge.ts            sandbox polling, agent detection, sessions, browser messages
  session.ts           one `openshell sandbox exec … <agent>` per sandbox: handshake, event log, permissions
  rpc.ts               JSON-RPC over stdio (newline-delimited)
  openshell.ts         CLI wrapper and the `openshell logs` network parser
  bundle.ts            git bundle out of the sandbox (bundle.sh "out")
  repos.ts             repositories: clone/pull on the host, bundles in and out, review, merge, push
  threadstore.ts       threads on disk
  validate.ts          shape checks for browser messages, sandbox name rules
  eventlog.ts          keeps the per-session event log bounded without breaking replay
  agents.json          agent registry
  config.ts, hints.ts  loads the registry and remembered state; error hints
shared/protocol.ts   browser <-> bridge messages
web/                 React UI (Vite)
  src/conversation.ts  folds ACP session/update events into the log
  src/store.ts         WebSocket, reconnect + replay, request/response
  src/auth.ts          the access token
  src/components/      Sidebar, Chat, ConversationLog, Composer, ModelPicker, Inspector, …
  vite.config.ts       UI build and dev server
test/fixtures/       fake `openshell` CLI with a scripted agent
docs/                design and mockup
```

TypeScript has one project per part: `server/tsconfig.json` (Node, no DOM), `web/tsconfig.json` (DOM, no Node) and `web/tsconfig.node.json` (UI tests and Vite config). They share the options in the root `tsconfig.json`.

## How it follows the design, and where it differs

- **Browser ↔ bridge protocol** is the one in [DESIGN.md](docs/DESIGN.md) section 7, with these changes:
  - Every session event (`event`, `user_message`, `permission_request`, `permission_resolved`, `turn_end`, `session_error`, `session_closed`, …) carries a `seq`, so `subscribe {sessionId, sinceSeq}` replays all of them, not only `session/update`.
  - The user's own prompts are logged too, because ACP doesn't echo them.
  - Errors that belong in the conversation are `session_error`, so they can't be confused with replies to requests (`error` with a `reqId`).
- **The ACP transport is our own small JSON-RPC peer** (`server/rpc.ts`, ported from `acp_client.py`). `@agentclientprotocol/sdk` is used for types only. Its connection class answers `fs/*` requests through optional handlers instead of returning `-32601`, sends a parse error back to the agent for non-JSON lines on stdout, and validates payloads against its schema. The bridge should relay payloads as the agent sends them and refuse host access explicitly.
- **One agent process per sandbox.** Threads are ACP sessions on that one process: "New thread" (`/new`) runs `session/new` and "Earlier threads" runs `session/load`.
- **Agent detection** (open question: does `sandbox get` show the image?). It doesn't, but its policy lists the provider (`_provider_openrouter` means OpenCode). After that the console falls back to the name prefix, then to what you chose before.
- **Network view** (open question: are denials in `openshell logs`?). They are. `NET:OPEN … ALLOWED|DENIED <binary> -> host:port` lines are counted from the time the agent process started, and refreshed every 15 s.
- **Token usage:** OpenCode sends `usage_update` (context used and size), and the `session/prompt` result includes cumulative `usage`. Both are shown.
- **Fonts are bundled** (`@fontsource`) rather than loaded from Google, so the UI works offline and the CSP stays `'self'`.
- **The diff view** is a small jsdiff-based component instead of `react-diff-view`.

## Limitations
- **Sessions are kept in memory.** They survive closing the tab, not restarting the bridge. Use "Earlier threads" to get back to them.
- **Long-running sessions** (hours, gateway restarts) are untested. When the agent process dies, the console shows its exit code and last output, and offers to start a new session.

## License

[MIT](LICENSE)
