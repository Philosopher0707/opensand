#!/usr/bin/env bash
# OpenSand Phase 5 screen starter kit.
# Scaffolds one new Phase 5 screen for the Preact app shell
# (packages/desktop/renderer-next) so every remaining Phase 5 row starts here:
#   1. the component  packages/desktop/renderer-next/src/views/<Name>.tsx
#   2. its real-window test  packages/desktop/test/<kebab>-real-window.test.ts
#      (a real Electron window at 960x740 and 1920x1080, screenshots into the
#      gitignored .opensand-snapshots/ folder -- never commit screenshots)
#   3. catalog rows in scripts/README.md so check-scripts-catalog.sh passes.
# Wiring the screen into Shell.tsx stays the row author's job.
set -euo pipefail

die() { echo "screen-kit: $*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/screen-kit.sh <ScreenName> [--selftest]
  <ScreenName>  PascalCase component name, e.g. Rooms, VaultCredentials.
  --selftest    Hermetic selftest; scaffolds into a temp copy and asserts the
                output. Never touches the repository or launches Electron.
Environment:
  OPENSAND_SCREEN_KIT_ROOT   Override the repo root (used by --selftest).
USAGE
  exit 1
}

NAME=""
SELFTEST=0
for arg in "$@"; do
  case "$arg" in
    --selftest) SELFTEST=1 ;;
    -h|--help) usage ;;
    -*) die "unknown flag: $arg" ;;
    *) [[ -z "$NAME" ]] || die "give exactly one screen name"; NAME="$arg" ;;
  esac
done

kebab_of() {
  echo "$1" \
    | sed -e 's/\([a-z0-9]\)\([A-Z]\)/\1-\2/g' -e 's/\([A-Z]\)\([A-Z][a-z]\)/\1-\2/g' \
    | tr '[:upper:]' '[:lower:]'
}

SELF="${BASH_SOURCE[0]}"

run_selftest() {
  local tmp comp testf cat
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/opensand-screen-kit-selftest.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/packages/desktop/renderer-next/src/views" "$tmp/packages/desktop/test" "$tmp/scripts"
  # Minimal fixture with the exact header the catalog append anchors on.
  printf '# OpenSand Scripts Catalog\n\n| Script | Purpose | Trigger / Caller | Selftest |\n| :--- | :--- | :--- | :--- |\n| `existing.sh` | fixture | manual | None |\n' > "$tmp/scripts/README.md"

  OPENSAND_SCREEN_KIT_ROOT="$tmp" bash "$SELF" SampleScreen >/dev/null \
    || die "selftest: scaffolding SampleScreen failed"

  comp="$tmp/packages/desktop/renderer-next/src/views/SampleScreen.tsx"
  testf="$tmp/packages/desktop/test/sample-screen-real-window.test.ts"
  cat="$tmp/scripts/README.md"
  [[ -f "$comp" ]] || die "selftest: component not scaffolded: $comp"
  [[ -f "$testf" ]] || die "selftest: real-window test not scaffolded: $testf"
  grep -q 'data-screen="sample-screen"' "$comp" || die "selftest: component lacks its data-screen hook"
  grep -q 'export function SampleScreen' "$comp" || die "selftest: component lacks its component function"
  for marker in "960, 740" "1920, 1080" ".opensand-snapshots" "withElectronLock" "__RESULT__"; do
    grep -qF "$marker" "$testf" || die "selftest: generated test lacks marker: $marker"
  done
  grep -qF 'SampleScreen.tsx' "$cat" || die "selftest: catalog index row not added"
  grep -qF 'sample-screen-real-window.test.ts' "$cat" || die "selftest: catalog test entry not added"

  if OPENSAND_SCREEN_KIT_ROOT="$tmp" bash "$SELF" SampleScreen >/dev/null 2>&1; then
    die "selftest: scaffolding an existing screen must be refused"
  fi
  if OPENSAND_SCREEN_KIT_ROOT="$tmp" bash "$SELF" sampleScreen >/dev/null 2>&1; then
    die "selftest: a non-PascalCase name must be refused"
  fi

  echo "PASS: screen-kit selftest (scaffold, catalog rows, refusals)."
  exit 0
}

[[ "$SELFTEST" -eq 1 ]] && run_selftest
[[ -n "$NAME" ]] || usage
[[ "$NAME" =~ ^[A-Z][A-Za-z0-9]*$ ]] || die "screen name must be PascalCase (got: $NAME)"

ROOT="${OPENSAND_SCREEN_KIT_ROOT:-$(cd "$(dirname "$SELF")/.." && pwd)}"
KEBAB="$(kebab_of "$NAME")"
[[ -n "$KEBAB" ]] || die "could not derive a kebab-case name from $NAME"
VIEWS="$ROOT/packages/desktop/renderer-next/src/views"
TESTS="$ROOT/packages/desktop/test"
CATALOG="$ROOT/scripts/README.md"
[[ -d "$VIEWS" ]] || die "not an OpenSand repo (missing $VIEWS)"
[[ -f "$CATALOG" ]] || die "scripts catalog not found: $CATALOG"
if [[ -e "$VIEWS/$NAME.tsx" || -e "$TESTS/$KEBAB-real-window.test.ts" ]]; then
  die "screen $NAME already exists ($VIEWS/$NAME.tsx or $TESTS/$KEBAB-real-window.test.ts)"
fi

COMPONENT_OUT="$VIEWS/$NAME.tsx"
TEST_OUT="$TESTS/$KEBAB-real-window.test.ts"

cat <<'COMPONENT' | sed -e "s|__NAME__|$NAME|g" -e "s|__KEBAB__|$KEBAB|g" > "$COMPONENT_OUT.tmp"
// __NAME__ screen, scaffolded by scripts/screen-kit.sh so every Phase 5 row
// starts from the same shape. States covered: loading (role=status), empty,
// ready, error (role=alert + Retry). Keyboard: rows are real buttons.
// Small screens: single column, no fixed widths, no horizontal overflow.
// Styles: add a `__KEBAB__` section to packages/desktop/renderer-next/src/shell.css
// when the screen gets its real look; the shared shell-empty/shell-note classes
// already style the loading and empty notes.
// The `items` / `error` props are demo input for the scaffold's real-window
// test; replace them with the row's real data source (ShellData) when porting.
export interface __NAME__Item {
  id: string;
  title: string;
}

export interface __NAME__Props {
  /** Items to show; undefined = loading, [] = empty. Demo input for the scaffold test. */
  items?: __NAME__Item[];
  error?: boolean;
  onRetry?: () => void;
}

export function __NAME__({ items, error, onRetry }: __NAME__Props) {
  const state = error
    ? "error"
    : items === undefined
      ? "loading"
      : items.length === 0
        ? "empty"
        : "ready";
  return (
    <section
      class="__KEBAB__"
      data-screen="__KEBAB__"
      data-state={state}
      aria-labelledby="__KEBAB__-heading"
    >
      <h2 class="__KEBAB__-heading" id="__KEBAB__-heading">__NAME__</h2>
      {state === "loading" && (
        <div class="shell-note" role="status">Loading…</div>
      )}
      {state === "error" && (
        <div class="__KEBAB__-error" role="alert">
          <span>Could not load the list.</span>
          <button type="button" class="btn-retry" onClick={() => onRetry?.()}>
            Retry
          </button>
        </div>
      )}
      {state === "empty" && (
        <div class="shell-empty">Nothing here yet.</div>
      )}
      {state === "ready" && (
        <ul class="__KEBAB__-list" role="list">
          {items!.map((item) => (
            <li key={item.id}>
              <button type="button" class="__KEBAB__-row" data-item-id={item.id}>
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
COMPONENT
mv "$COMPONENT_OUT.tmp" "$COMPONENT_OUT"

cat <<'TEST' | sed -e "s|__NAME__|$NAME|g" -e "s|__KEBAB__|$KEBAB|g" > "$TEST_OUT.tmp"
// Real-window test for the __KEBAB__ screen scaffolded by scripts/screen-kit.sh.
// A vite dev server (the same devDependency the shell builds with) serves the
// scaffolded component, and a real Electron window -- never a mocked
// BrowserWindow -- loads it at 960x740 (the minimum size) and 1920x1080 (full
// screen). It asserts the scaffold's states fit without horizontal overflow and
// captures screenshots into .opensand-snapshots/ (gitignored; never commit
// screenshots). When the screen is wired into Shell.tsx, move these assertions
// onto the window-harness (test/window-harness.test.ts) like the other
// real-window tests.
import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { withElectronLock } from "./electron-lock.js";
import { hermeticElectronEnv, makeTempHome } from "./hermetic-env.js";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(pkgRoot, "..", "..");
const COMPONENT = path.join(pkgRoot, "renderer-next", "src", "views", "__NAME__.tsx");
const SIZES: Array<[number, number, string]> = [[960, 740, "960x740"], [1920, 1080, "full-1920x1080"]];
const SHOT_DIR =
  process.env.OPENSAND_SCREEN_KIT_SHOTS ||
  path.join(repoRoot, ".opensand-snapshots", "screen-kit", "__KEBAB__");

function skipReason(): string | undefined {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Skipping Electron real-window test on Linux CI without DISPLAY/WAYLAND_DISPLAY";
  }
  if (!fs.existsSync(path.join(pkgRoot, "node_modules", ".bin", "electron"))) return "Electron binary not found";
  return undefined;
}

// Bundles the scaffolded component into one self-contained page: a throwaway
// vite build (the same devDependency the shell builds with) resolves preact
// through a node_modules symlink into the package and inlines it, so the test
// window loads a plain file:// page with no dev server and no module graph.
async function buildPage(): Promise<{ page: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-screen-kit-vite-"));
  fs.symlinkSync(path.join(pkgRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(dir, "mount.tsx"),
    [
      'import { render } from "preact";',
      `import { __NAME__ } from ${JSON.stringify(COMPONENT)};`,
      'const demo = [{ id: "demo-1", title: "Demo row one" }, { id: "demo-2", title: "Demo row two" }];',
      'render(<><div id="s-ready"><__NAME__ items={demo} /></div><div id="s-empty"><__NAME__ items={[]} /></div></>, document.body);',
    ].join("\n"),
    "utf8",
  );
  const result = (await build({
    configFile: false,
    root: dir,
    logLevel: "silent",
    cacheDir: path.join(dir, ".vite-cache"),
    esbuild: { jsx: "automatic", jsxImportSource: "preact" },
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: path.join(dir, "mount.tsx"), output: { format: "iife" } },
    },
  })) as unknown as { output?: Array<{ type: string; code?: string }> };
  const chunks = result.output ?? [];
  const js = chunks.find((chunk) => chunk.type === "chunk")?.code;
  assert.ok(js, "vite build produced no script chunk");
  const page = path.join(dir, "page.html");
  fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><title>__NAME__ scaffold</title></head><body><script>${js}</script></body></html>`, "utf8");
  return { page, dir };
}

const RUNNER = String.raw`
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
const shotDir = process.env.OPENSAND_SCREEN_KIT_SHOTS || "";
const SIZES = JSON.parse(process.env.OPENSAND_SCREEN_KIT_SIZES || "[]");
const pageUrl = process.env.OPENSAND_SCREEN_KIT_URL;
const timeout = setTimeout(() => { console.error("[runner] timeout"); app.quit(); process.exit(1); }, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 960,
      height: 740,
      useContentSize: true,
      webPreferences: { backgroundThrottling: false },
    });
    win.webContents.on("console-message", (_e, _level, message, line, sourceId) => {
      console.error("[console] " + message + " (" + sourceId + ":" + line + ")");
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      console.error("[did-fail-load] " + code + " " + desc + " " + url);
    });
    await win.loadURL(pageUrl);
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = async (fn) => {
      for (let i = 0; i < 100; i++) { if (await js("Boolean(" + fn + ")")) return; await sleep(100); }
      throw new Error("wait timed out: " + fn);
    };
    await wait('document.querySelector("#s-ready [data-screen]") && document.querySelector("#s-empty [data-screen]")');
    const bodySoFar = await js('document.body ? document.body.innerHTML.slice(0, 300) : "no body"');
    console.error("[body] " + bodySoFar);
    const METRICS = '(() => { const ready = document.querySelector("#s-ready [data-screen]"); const empty = document.querySelector("#s-empty [data-screen]"); const firstRow = ready ? ready.querySelector("[data-item-id]") : null; const rect = ready ? ready.getBoundingClientRect() : null; return { readyState: ready ? ready.dataset.state : null, emptyState: empty ? empty.dataset.state : null, readyRows: ready ? ready.querySelectorAll("[data-item-id]").length : 0, firstRowIsButton: firstRow ? firstRow.tagName === "BUTTON" : false, headingText: ready && ready.querySelector("h2") ? ready.querySelector("h2").textContent : "", inViewport: rect ? (rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight) : false, noOverflow: document.documentElement.scrollWidth <= window.innerWidth }; })()';
    const result = { sizes: {} };
    for (const [w, h, tag] of SIZES) {
      win.setContentSize(w, h);
      await sleep(300);
      const m = await js(METRICS);
      result.sizes[tag] = m;
      if (shotDir) {
        fs.mkdirSync(shotDir, { recursive: true });
        await js("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await sleep(250);
        fs.writeFileSync(path.join(shotDir, tag + ".png"), (await win.webContents.capturePage()).toPNG());
      }
    }
    console.log("__RESULT__:" + JSON.stringify(result));
    clearTimeout(timeout); app.quit(); process.exit(0);
  } catch (err) {
    try {
      console.error("[body on error] " + (await js('document.body ? document.body.innerHTML.slice(0, 400) : "no body"')));
    } catch {}
    console.error("[runner] error", err); clearTimeout(timeout); app.quit(); process.exit(1);
  }
});
`;

async function runElectron(url: string): Promise<any> {
  const electronBin = path.join(pkgRoot, "node_modules", ".bin", "electron");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-screen-kit-electron-"));
  const runner = path.join(tmpDir, "runner.mjs");
  fs.writeFileSync(runner, RUNNER, "utf8");
  // Hermetic: HOME points at a temp dir, so the launch never reads or writes
  // the owner's ~/.opensand; --user-data-dir keeps Chromium state inside tmp too.
  const env = hermeticElectronEnv(makeTempHome("opensand-screen-kit-home-"));
  env.OPENSAND_SCREEN_KIT_SHOTS = SHOT_DIR;
  env.OPENSAND_SCREEN_KIT_SIZES = JSON.stringify(SIZES);
  env.OPENSAND_SCREEN_KIT_URL = url;
  let stdout = "";
  let stderr = "";
  try {
    const code = await withElectronLock(async () => {
      const child = spawn(electronBin, [`--user-data-dir=${tmpDir}`, runner], {
        cwd: tmpDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 0)));
    });
    assert.strictEqual(code, 0, `runner failed (${code})\n${stdout}\n${stderr}`);
    const m = stdout.match(/__RESULT__:(.*)/);
    assert.ok(m, `no result in stdout:\n${stdout}\n${stderr}`);
    return JSON.parse(m[1]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("__NAME__ scaffold renders its states in a real window at 960x740 and full screen", async (t) => {
  const reason = skipReason();
  if (reason) return t.skip(reason);
  assert.ok(fs.existsSync(COMPONENT), `scaffolded component not found: ${COMPONENT}`);
  const { page, dir } = await buildPage();
  try {
    const r = await runElectron("file://" + page);
    for (const [, , tag] of SIZES) {
      const s = r.sizes[tag];
      assert.ok(s, `result for ${tag}`);
      assert.strictEqual(s.readyState, "ready", `${tag}: the ready state renders (${s.readyState})`);
      assert.strictEqual(s.emptyState, "empty", `${tag}: the empty state renders (${s.emptyState})`);
      assert.ok(s.readyRows >= 1, `${tag}: the ready rows render`);
      assert.strictEqual(s.firstRowIsButton, true, `${tag}: rows are keyboard-focusable buttons`);
      assert.strictEqual(s.headingText, "__NAME__", `${tag}: the screen heading is present`);
      assert.strictEqual(s.noOverflow, true, `${tag}: no horizontal overflow`);
      assert.strictEqual(s.inViewport, true, `${tag}: the screen is fully inside the window`);
      assert.ok(fs.existsSync(path.join(SHOT_DIR, `${tag}.png`)), `${tag}: screenshot written to ${SHOT_DIR}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
TEST
mv "$TEST_OUT.tmp" "$TEST_OUT"

# Catalog: index row right after the table header, detailed section at the end.
awk -v row="| \`$NAME.tsx\` | Phase 5 screen component scaffolded by \`screen-kit.sh\` (wired into Shell.tsx by the row's PR) | Phase 5 row work | $KEBAB-real-window.test.ts |" '
  { print }
  /^\| :---/ && !done { print row; done=1 }
' "$CATALOG" > "$CATALOG.tmp"

cat >> "$CATALOG.tmp" <<EOF

### \`$NAME.tsx\`
- **Purpose**: Phase 5 screen scaffolded by \`screen-kit.sh\`: component with loading / empty / ready / error(+Retry) states, keyboard-focusable rows, no small-screen overflow. Replace the demo \`items\`/\`error\` props with the row's real data source and wire it into \`Shell.tsx\`.
- **Usage**: \`scripts/screen-kit.sh $NAME\`.
- **Exit Codes**: \`0\` on success, \`1\` on refusal (existing screen, non-PascalCase name, unknown flag).
- **Selftest**: $KEBAB-real-window.test.ts (real Electron window at 960x740 and 1920x1080; screenshots land in the gitignored .opensand-snapshots/screen-kit/$KEBAB/ folder, never committed).
- **Trigger**: Phase 5 row work.
EOF
mv "$CATALOG.tmp" "$CATALOG"

echo "screen-kit: scaffolded $NAME"
echo "  component: packages/desktop/renderer-next/src/views/$NAME.tsx"
echo "  real-window test: packages/desktop/test/$KEBAB-real-window.test.ts"
echo "  screenshots (gitignored): .opensand-snapshots/screen-kit/$KEBAB/"
echo "  catalog: scripts/README.md"
echo "Next: replace the demo props with the row's real data, wire it into Shell.tsx, add the __KEBAB__ styles to shell.css."
