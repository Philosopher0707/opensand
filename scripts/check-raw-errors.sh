#!/usr/bin/env bash
# Fail on NEW places in packages/desktop where a raw error (err.message / String(err) / stack)
# is sent to the user instead of through a classify/format helper. Today's findings are seeded
# in scripts/raw-errors-allow.txt.
# Usage: scripts/check-raw-errors.sh
# Env (selftest): RAW_ERRORS_SCAN_DIR, RAW_ERRORS_ALLOW, RAW_ERRORS_ROOT
# Exit 0 no new raw errors, 1 a new raw error, 2 bad setup.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN="${RAW_ERRORS_SCAN_DIR:-$ROOT/packages/desktop}"
ALLOW="${RAW_ERRORS_ALLOW:-$ROOT/scripts/raw-errors-allow.txt}"
SRC_ROOT="${RAW_ERRORS_ROOT:-$ROOT}"

if [[ ! -d "$SCAN" ]]; then
  echo "FAIL: desktop source directory not found: $SCAN" >&2
  exit 2
fi
if [[ ! -f "$ALLOW" ]]; then
  echo "FAIL: raw-error allowlist not found: $ALLOW" >&2
  exit 2
fi

node - "$SCAN" "$ALLOW" "$SRC_ROOT" <<'JS'
const fs = require("fs");
const path = require("path");
const [scanDir, allowPath, repoRoot] = process.argv.slice(2);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "test") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

// A raw expression is only a finding when it lands in a user-facing sink (HTTP response,
// event, toast/dialog or failed-state message). Logging, control-flow checks and values
// already passing through a formatter helper are not findings.
const raw = /\b(?:err|error|e)\.message\b|\bString\((?:err|error|e)\)|\.stack\b/;
// The lookbehind keeps `err.message : ...` (a ternary extraction) from looking like `message: ...`.
const sink = /res\.end|JSON\.stringify|emitEvent|(?<!\.)\bmessage\s*:|(?<!\.)\berror\s*:|set[A-Z][A-Za-z]*Error\s*\(|authFailed\s*\(|type:\s*["']failed["']/;
const helper = /classifyError|formatError|friendly|toActionable|errorMessage\s*\(|authFailed\s*\(/;
const logging = /console\.(error|warn|log)|logger\./;
const controlFlow = /\.message\s*\.includes|\.message\s*&&|typeof\s+[^;]*\.message/;

const findings = [];
for (const f of walk(scanDir, [])) {
  const b = path.basename(f);
  if (b.endsWith(".d.ts") || /\.(test|spec)\./.test(b)) continue;
  const rel = path.relative(repoRoot, f);
  fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!raw.test(line) || !sink.test(line)) return;
    if (helper.test(line) || logging.test(line) || controlFlow.test(line)) return;
    const text = line.trim();
    findings.push({ key: `${rel}|${text.replace(/\s+/g, " ")}`, rel, line: i + 1, text });
  });
}
for (const f of findings) {
  console.log(`FINDING ${f.key}`);
  console.log(`${f.rel}:${f.line}: ${f.text}`);
}
const allow = new Set(
  fs.readFileSync(allowPath, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim())
);
const fresh = findings.filter((f) => !allow.has(f.key));
if (fresh.length) {
  console.error(`FAIL: ${fresh.length} NEW raw error path(s) reaching the user:`);
  for (const f of fresh) console.error(`FAIL: ${f.rel}:${f.line}: ${f.text}`);
  process.exit(1);
}
console.log(`PASS: ${findings.length} raw error path(s) all allowlisted.`);
JS
