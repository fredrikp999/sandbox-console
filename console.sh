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
[ -d node_modules ] || npm install
[ -f dist/web/index.html ] || npm run build
exec npx tsx server/index.ts --open "$@"
