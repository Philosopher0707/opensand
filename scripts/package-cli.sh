#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/dist/bin"
CLI_DIR="$ROOT_DIR/packages/cli"

echo "===> Packaging OpenSand CLI Standalone Executable..."
mkdir -p "$BIN_DIR"

# 1. Compile all packages
pnpm -C "$ROOT_DIR" run build

# 2. Create standalone executable script
STANDALONE_BIN="$BIN_DIR/opensand"

cat << 'EOF' > "$STANDALONE_BIN"
#!/usr/bin/env node
/**
 * OpenSand Universal Coding Agent CLI
 * Standalone entrypoint
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const relativeCandidate = resolve(__dirname, '../../packages/cli/dist/src/cli-app.js');
const homeCandidate = resolve(process.env.HOME || '', 'dev/opensand/packages/cli/dist/src/cli-app.js');

const target = existsSync(relativeCandidate) ? relativeCandidate : homeCandidate;
const { runCli } = await import(target);

runCli(process.argv.slice(2)).catch((err) => {
  console.error('\nOpenSand Fatal Error:', err.message);
  process.exit(1);
});
EOF

chmod +x "$STANDALONE_BIN"

# 3. Create SEA Config if postject / blob generation is desired
cat << 'EOF' > "$ROOT_DIR/dist/sea-config.json"
{
  "main": "packages/cli/dist/src/bin.js",
  "output": "dist/opensand.blob",
  "disableExperimentalSEAWarning": true
}
EOF

echo "===> Standalone CLI binary ready at: $STANDALONE_BIN"
"$STANDALONE_BIN" --version || true
