#!/usr/bin/env sh
set -eu

PACKAGE="${PERRY_NPM_PACKAGE:-@perry-ai/cli}"

if ! command -v npm >/dev/null 2>&1; then
  echo "Perry installer requires Node.js/npm for now." >&2
  echo "Install Node.js 20+ first, then rerun this installer." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Perry requires Node.js 20+. Current Node: $(node -v 2>/dev/null || echo unknown)" >&2
  exit 1
fi

echo "Installing $PACKAGE globally..."
npm install -g "$PACKAGE"

echo "Perry installed. Run: perry"
