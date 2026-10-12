#!/bin/sh
# Start the Sandbox Console: builds the UI if needed, starts the bridge on
# 127.0.0.1 and opens the printed URL (with its access token) in the browser.
#
#   ./console.sh [--port N] [--no-open]
#
# OPENSHELL_CONFIGS points at your openshell-configs checkout; the console uses
# its policies/vscode-terminal.yaml when it creates sandboxes.
set -eu
cd "$(dirname "$0")"
# Install when dependencies changed (e.g. after a git pull), and always rebuild
# the UI, so it never runs stale. Both are quick when nothing changed.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install
fi
npm run build --silent >/dev/null
exec npx tsx server/index.ts --open "$@"
