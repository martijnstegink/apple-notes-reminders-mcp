#!/usr/bin/env bash
# Installs apple-notes-reminders-mcp and registers it with Claude Desktop.
set -euo pipefail

SERVER_NAME="apple-notes-reminders"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/Library/Application Support/Claude"
CONFIG_FILE="$CONFIG_DIR/claude_desktop_config.json"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this server is macOS-only" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH — install Node.js 18+ first" >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 18 )); then
  echo "error: Node.js 18+ required, found $(node -v)" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  *"/.nvm/"*|*"/.asdf/"*|*"/.volta/"*|*"/fnm/"*)
    echo "warning: '$NODE_BIN' is a version-manager path and may break when you"
    echo "         switch Node versions. Consider pointing at a stable binary"
    echo "         (e.g. /opt/homebrew/bin/node) in the config afterwards."
    ;;
esac

echo "==> Installing dependencies (also builds swift/reminders-daemon via postinstall)"
(cd "$REPO_DIR" && npm install)

echo "==> Building TypeScript"
(cd "$REPO_DIR" && npm run build)

if [[ ! -x "$REPO_DIR/swift/reminders-daemon" ]]; then
  echo "error: swift/reminders-daemon was not built — check npm install output above" >&2
  exit 1
fi

echo "==> Registering '$SERVER_NAME' in Claude Desktop config"
mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG_FILE" ]]; then
  BACKUP="$CONFIG_FILE.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$CONFIG_FILE" "$BACKUP"
  echo "    backed up existing config to $BACKUP"
fi

CONFIG_FILE="$CONFIG_FILE" SERVER_NAME="$SERVER_NAME" NODE_BIN="$NODE_BIN" REPO_DIR="$REPO_DIR" \
  node --input-type=module <<'EOF'
import fs from "node:fs";

const configFile = process.env.CONFIG_FILE;
const serverName = process.env.SERVER_NAME;
const nodeBin = process.env.NODE_BIN;
const repoDir = process.env.REPO_DIR;

let config = {};
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, "utf8").trim();
  config = raw ? JSON.parse(raw) : {};
}

config.mcpServers = config.mcpServers || {};
config.mcpServers[serverName] = {
  command: nodeBin,
  args: [`${repoDir}/dist/index.js`],
};

fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
console.log(`    wrote ${configFile}`);
EOF

cat <<MSG

==> Done.

Before it works, macOS will need to grant Claude Desktop:
  - Automation permission to control Notes.app and Reminders.app
    (prompted automatically on first use, or set in System Settings ->
    Privacy & Security -> Automation)
  - Full Disk Access, to read the Notes database directly
    (System Settings -> Privacy & Security -> Full Disk Access -> add Claude)

Then quit and reopen Claude Desktop so it picks up the new MCP server.
MSG