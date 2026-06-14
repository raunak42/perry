#!/usr/bin/env node
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function expandHomePrefix(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createDevCommandScript({ sourceRoot, bunCommand = "bun" }) {
  const normalizedSourceRoot = path.resolve(sourceRoot);
  return `#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=${shellQuote(normalizedSourceRoot)}
ENTRY="$SOURCE_ROOT/src/index.ts"

if ! command -v ${shellQuote(bunCommand)} >/dev/null 2>&1; then
  echo "perry-dev requires Bun. Install Bun first: https://bun.sh" >&2
  exit 127
fi

if [ ! -f "$ENTRY" ]; then
  echo "perry-dev could not find Perry source at $ENTRY" >&2
  echo "Re-run: cd <perry-source> && bun run dev:install" >&2
  exit 1
fi

exec ${shellQuote(bunCommand)} run "$ENTRY" "$@"
`;
}

function resolveInstallPath(env = process.env) {
  const binDir = path.resolve(expandHomePrefix(env.PERRY_DEV_BIN_DIR || path.join(os.homedir(), ".local", "bin")));
  return {
    binDir,
    commandPath: path.join(binDir, "perry-dev"),
  };
}

function isDirOnPath(binDir, env = process.env) {
  const entries = (env.PATH || "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(expandHomePrefix(entry)));
  return entries.includes(path.resolve(binDir));
}

function installDevCommand({ sourceRoot = path.resolve(__dirname, ".."), env = process.env } = {}) {
  const { binDir, commandPath } = resolveInstallPath(env);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(commandPath, createDevCommandScript({ sourceRoot }), { mode: 0o755 });
  chmodSync(commandPath, 0o755);

  console.log(`Installed perry-dev -> ${commandPath}`);
  console.log(`Source root: ${path.resolve(sourceRoot)}`);
  console.log("Run `perry-dev` from any repo to start this source checkout of Perry there.");
  if (!isDirOnPath(binDir, env)) {
    console.log("");
    console.log(`${binDir} is not on PATH. Add this to your shell profile:`);
    console.log(`export PATH=${shellQuote(binDir)}:$PATH`);
  }

  return { binDir, commandPath };
}

if (require.main === module) {
  installDevCommand();
}

module.exports = {
  createDevCommandScript,
  installDevCommand,
  isDirOnPath,
  resolveInstallPath,
  shellQuote,
};
