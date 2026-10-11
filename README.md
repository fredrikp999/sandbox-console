# Sandbox Console

A local web app that lists your OpenShell sandboxes and lets you work with the coding agent in each one over ACP. See [DESIGN.md](DESIGN.md) for the design and [mockup.html](mockup.html) for the mockup.

## Run it

```sh
./console.sh            # installs, builds the UI if needed, starts the bridge and opens the browser
./console.sh --port 7900 --no-open
npm start               # same, without opening the browser
```

The bridge prints `http://127.0.0.1:7801/?token=…`. The token is new on every start. Opening that URL stores it in an HttpOnly cookie, so reload works, but after a restart you need the new URL.

Requires Node 22+, and `openshell` on the PATH with a running gateway. Sandboxes come from [openshell-configs](https://github.com/fredrikp999/openshell-configs). Set `OPENSHELL_CONFIGS` to that checkout so new sandboxes get `policies/vscode-terminal.yaml`, like `sandbox.sh`. The console also looks in `~/openshell-configs/openshell-configs`.

### Try it without a gateway

```sh
OPENSHELL_BIN=test/fake-openshell.mjs npm start
```

A fake CLI with a scripted agent. A turn plays a plan, an edit with a diff, a permission request and a refused `fs/*` request. A prompt containing "fail" returns an API error. `claude-demo` shows the missing-adapter error (exit code 127).

## Configuration

| | |
|---|---|
| `agents.json` | Agent registry: command, model env, default model, image and provider for "New sandbox", and the hint shown when the command is missing |
| `CONSOLE_PORT` / `--port` | Default 7801 |
| `OPENSHELL_BIN` | Default `openshell` |
| `OPENSHELL_CONFIGS`, `OPENSHELL_POLICY` | Where to find the policy for new sandboxes |
| `CONSOLE_STATE` | Agent, directory and model remembered per sandbox. Default `~/.config/sandbox-console/state.json` |

## Layout

```
server/        the bridge (Node, TypeScript, run with tsx)
  index.ts       HTTP + WebSocket on 127.0.0.1, token cookie, Origin check, CSP, /api/bundle
  console.ts     sandbox polling, agent detection, sessions, browser messages
  session.ts     one `openshell sandbox exec … <agent>` per sandbox: handshake, event log, permissions
  rpc.ts         JSON-RPC over stdio (newline-delimited)
  openshell.ts   CLI wrapper and the `openshell logs` network parser
  bundle.ts      git bundle out of the sandbox (bundle.sh "out")
shared/protocol.ts   browser <-> bridge messages
web/src/       React UI (Vite)
  conversation.ts  folds ACP session/update events into the log
  store.ts         WebSocket, reconnect + replay, request/response
test/fake-openshell.mjs
```

## Development

```sh
npm test            # unit tests + an end-to-end bridge test against the fake CLI
npm run typecheck
npm run dev & npm run dev:web    # bridge with --dev, plus Vite on :5173 with hot reload
```

## How it follows the design, and where it differs

- **Browser ↔ bridge protocol** is the one in DESIGN.md section 7, with these changes:
  - Every session event (`event`, `user_message`, `permission_request`, `permission_resolved`, `turn_end`, `session_error`, `session_closed`, …) carries a `seq`, so `subscribe {sessionId, sinceSeq}` replays all of them, not only `session/update`.
  - The user's own prompts are logged too, because ACP doesn't echo them.
  - Errors that belong in the conversation are `session_error`, so they can't be confused with replies to requests (`error` with a `reqId`).
- **The ACP transport is our own small JSON-RPC peer** (`server/rpc.ts`, ported from `acp_client.py`). `@agentclientprotocol/sdk` is used for types only. Its connection class answers `fs/*` requests through optional handlers instead of returning `-32601`, sends a parse error back to the agent for non-JSON lines on stdout, and validates payloads against its schema. The bridge should relay payloads as the agent sends them and refuse host access explicitly.
- **One agent process per sandbox.** `/clear` runs `session/new` and "Earlier sessions" runs `session/load` on the same process.
- **Agent detection** (open question: does `sandbox get` show the image?). It doesn't, but its policy lists the provider (`_provider_openrouter` means OpenCode). After that the console falls back to the name prefix, then to what you chose before.
- **Network view** (open question: are denials in `openshell logs`?). They are. `NET:OPEN … ALLOWED|DENIED <binary> -> host:port` lines are counted from the time the agent process started, and refreshed every 15 s.
- **Token usage**: OpenCode sends `usage_update` (context used and size), and the `session/prompt` result includes cumulative `usage`. Both are shown.
- **Fonts are bundled** (`@fontsource`) rather than loaded from Google, so the UI works offline and the CSP stays `'self'`.
- **The diff view** is a small jsdiff-based component instead of `react-diff-view`.

## Not done yet

- Claude Code runs `claude-acp-start`, the wrapper in the `claude-sandbox` image that skips onboarding and then starts the ACP adapter `claude-agent-acp`. Sandboxes from images built before the adapter was added fail with exit 127, and the console shows a rebuild hint.
- The event log lives in memory: sessions survive closing the tab, not restarting the bridge. Use "Earlier sessions" (`session/load`) to get back to them.
- "Download as git bundle" bundles the current branch of the session's working directory, compared with `host/main` or `host/master` when the repo came in through `bundle.sh in`. Choose another directory with `/bundle <dir>`.
- Long-running exec stability (hours, gateway restarts) is untested. When the process dies, the console shows the exit code and stderr, and offers to start a new session.
