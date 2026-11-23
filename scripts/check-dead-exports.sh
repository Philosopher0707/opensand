#!/usr/bin/env bash
# Fail on NEW exported functions/classes/consts under packages/*/src that no other file
# imports or references. Today's findings are seeded in scripts/dead-exports-allow.txt.
# Excludes tests, index.ts re-exports and package entry points from findings and references.
# Usage: scripts/check-dead-exports.sh
# Env (selftest): DEAD_EXPORTS_PACKAGES_DIR, DEAD_EXPORTS_ALLOW, DEAD_EXPORTS_ROOT
# Exit 0 no new dead exports, 1 a new dead export, 2 bad setup.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" # node - resolves require('typescript') from cwd
PKGS="${DEAD_EXPORTS_PACKAGES_DIR:-$ROOT/packages}"
ALLOW="${DEAD_EXPORTS_ALLOW:-$ROOT/scripts/dead-exports-allow.txt}"
SRC_ROOT="${DEAD_EXPORTS_ROOT:-$ROOT}"

if [[ ! -d "$PKGS" ]]; then
  echo "FAIL: packages directory not found: $PKGS" >&2
  exit 2
fi
if [[ ! -f "$ALLOW" ]]; then
  echo "FAIL: dead-export allowlist not found: $ALLOW" >&2
  exit 2
fi

node - "$PKGS" "$ALLOW" "$SRC_ROOT" <<'JS'
const fs = require("fs");
const path = require("path");
let ts;
try {
  ts = require("typescript"); // the repo's own compiler, already installed by pnpm install
} catch {
  console.error("FAIL: typescript is required; run pnpm install before this check");
  process.exit(2);
}
const [pkgsRoot, allowPath, repoRoot] = process.argv.slice(2);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

// Re-exports (index.ts) and package entry points are not findings, nor do they count as uses.
const skip = new Set();
function addEntry(file) {
  if (!file) return;
  const base = file.replace(/\.(js|mjs|cjs|d\.ts)$/, "");
  for (const ext of [".ts", ".tsx"]) skip.add(base + ext);
}
for (const pkg of fs.readdirSync(pkgsRoot)) {
  const pj = path.join(pkgsRoot, pkg, "package.json");
  if (!fs.existsSync(pj)) continue;
  const j = JSON.parse(fs.readFileSync(pj, "utf8"));
  const values = [];
  const collect = (v) => {
    if (!v) return;
    if (typeof v === "string") values.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (typeof v === "object") Object.values(v).forEach(collect);
  };
  [j.main, j.types, j.module, j.exports, j.bin].forEach(collect);
  for (const v of values) {
    const m = typeof v === "string" && v.replace(/^\.\//, "").match(/^dist\/(.+\.)(js|mjs|cjs|d\.ts)$/);
    if (m) addEntry(path.join(pkgsRoot, pkg, m[1].replace(/\.$/, "")));
  }
}

const files = [];
for (const pkg of fs.readdirSync(pkgsRoot)) {
  const src = path.join(pkgsRoot, pkg, "src");
  if (!fs.existsSync(src)) continue;
  for (const f of walk(src, [])) {
    const b = path.basename(f);
    if (b.endsWith(".d.ts") || /\.(test|spec)\./.test(b)) continue;
    files.push(f);
  }
}

const parsed = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const kind = f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  parsed.set(f, ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind));
}

const exported = [];
for (const [f, sf] of parsed) {
  const base = path.basename(f);
  if (skip.has(f) || base === "index.ts" || base === "index.tsx") continue;
  const rel = path.relative(repoRoot, f);
  const hasExport = (n) => !!ts.canHaveModifiers(n) && (ts.getModifiers(n) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const add = (nameNode, kind) => {
    const name = nameNode.text;
    const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
    exported.push({ key: `${rel}|${kind} ${name}`, rel, line, name, file: f });
  };
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name && hasExport(st)) {
      add(st.name, ts.isClassDeclaration(st) ? "class" : "function");
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name, "const");
    }
  }
}

// A name counts as used only when another file imports it (or a namespace import accesses it).
const usedBy = new Map();
const mark = (name, file) => {
  if (!usedBy.has(name)) usedBy.set(name, new Set());
  usedBy.get(name).add(file);
};
for (const [f, sf] of parsed) {
  // Every file counts as a reference, including index.ts and entry points; only their
  // own declarations are excluded from findings above.
  const namespaces = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const ic = node.importClause;
      if (ic.name) mark(ic.name.text, f);
      const nb = ic.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) mark((e.propertyName || e.name).text, f);
      } else if (nb && ts.isNamespaceImport(nb)) {
        namespaces.add(nb.name.text);
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      mark(node.name.text, f);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const allow = new Set(
  fs.readFileSync(allowPath, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim())
);
const findings = exported.filter((e) => {
  const external = [...(usedBy.get(e.name) || [])].filter((u) => u !== e.file);
  return external.length === 0;
});
for (const f of findings) {
  console.log(`FINDING ${f.key}`);
  console.log(`${f.rel}:${f.line}: ${f.key.split("|")[1]} is exported but not imported or referenced by another file`);
}
const fresh = findings.filter((f) => !allow.has(f.key));
if (fresh.length) {
  console.error(`FAIL: ${fresh.length} NEW dead export(s); add them to scripts/dead-exports-allow.txt only if intentional:`);
  for (const f of fresh) console.error(`FAIL: ${f.rel}:${f.line}: ${f.key.split("|")[1]}`);
  process.exit(1);
}
console.log(`PASS: ${exported.length} exports checked, ${findings.length} dead export(s) all allowlisted.`);
JS
