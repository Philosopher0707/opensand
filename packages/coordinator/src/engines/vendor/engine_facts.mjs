// engine_facts: the facts every consumer of a coding-agent engine shares, in one module: the engines' labels and program
// names, how to find a program, how to read and check its version, the child environment, and the plain-language reason
// for a failure. Consumers keep what is theirs (their output parser, their tested range, their protocol); this file holds
// none of that. Zero dependencies; imports only node:* modules; Node >= 18. Spec: scratchpad engine_facts_spec.md.
//
// The same facts also live in WorkMate (~/active/tools/workmate, phase B: a byte-identical vendored copy). Edit only here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Label as the user sees it, and the program name (or, for WorkBuddy, the Node script that is the program). */
export const ENGINE_FACTS = Object.freeze({
  claude: Object.freeze({ label: "Claude Code", bin: "claude" }),
  codex: Object.freeze({ label: "Codex", bin: "codex" }),
  copilot: Object.freeze({ label: "GitHub Copilot", bin: "copilot" }),
  antigravity: Object.freeze({ label: "Antigravity", bin: "agy" }),
  opencode: Object.freeze({ label: "OpenCode", bin: "opencode" }),
  // WorkBuddy's own agent: the CodeBuddy Code CLI bundled in the WorkBuddy app, a Node script. It has its own sign-in.
  workbuddy: Object.freeze({
    label: "WorkBuddy (CodeBuddy)",
    script: "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs",
  }),
});

const factsOf = (id) => (Object.hasOwn(ENGINE_FACTS, id) ? ENGINE_FACTS[id] : null);

const isFileWith = (p, mode) => {
  try { fs.accessSync(p, mode); return fs.statSync(p).isFile(); } catch { return false; }
};

/** The first executable `name` in `dirs`, as an absolute path, or null. Empty entries are skipped. */
export function findOnPath(name, dirs = []) {
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isFileWith(p, fs.constants.X_OK)) return p;
  }
  return null;
}

/** PATH, then the usual install folders (Homebrew, /usr/local, ~/.local, ~/.npm-global, ~/.bun), without repeats. */
export function defaultPathDirs() {
  const home = os.homedir();
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin")];
  const dirs = [...(process.env.PATH || "").split(path.delimiter), ...extra].filter(Boolean);
  return [...new Set(dirs)];
}

/**
 * Absolute path of an engine's program, or null.
 * - An explicit `bin` is returned only when it exists and is executable (no search happens after it).
 * - A script engine (WorkBuddy) has no program name to search for: its script (or the explicit `bin`) only has to be readable.
 * - Otherwise the first executable named by the engine's `bin` in pathDirs (default: defaultPathDirs()).
 */
export function findBinary(id, { bin, pathDirs } = {}) {
  const f = factsOf(id);
  if (!f) return null;
  if (f.script) {
    const p = bin || f.script;
    return isFileWith(p, fs.constants.R_OK) ? p : null;
  }
  if (bin) return isFileWith(bin, fs.constants.X_OK) ? bin : null;
  return f.bin ? findOnPath(f.bin, pathDirs ?? defaultPathDirs()) : null;
}

/** [major, minor, patch] from the first x.y.z in the text, or null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""));
  return m ? m.slice(1, 4).map(Number) : null;
}

const asVersion = (v) => (Array.isArray(v) ? v : parseVersion(v));

/** Negative, zero or positive as a is older, equal or newer than b. Each side is a [maj,min,patch] array or a string. Throws if one is not a version. */
export function compareVersions(a, b) {
  const x = asVersion(a);
  const y = asVersion(b);
  if (!x || !y) throw new TypeError(`not a version: ${!x ? String(a) : String(b)}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Where a version stands against the range a consumer checked its output against, [lo, hi] (inclusive).
 * No range -> {status:"unchecked"}. Text with no version -> {status:"unknown", tested}. Otherwise
 * {status:"older"|"tested"|"newer", version:"x.y.z", tested}. The range belongs to the consumer, not to this module.
 */
export function versionStatus(text, range) {
  if (!Array.isArray(range) || range.length !== 2) return { status: "unchecked" };
  const [lo, hi] = range.map(parseVersion);
  if (!lo || !hi) throw new TypeError(`tested range must be two versions: ${JSON.stringify(range)}`);
  const v = parseVersion(text);
  if (!v) return { status: "unknown", tested: range };
  if (compareVersions(v, lo) < 0) return { status: "older", version: v.join("."), tested: range };
  if (compareVersions(v, hi) > 0) return { status: "newer", version: v.join("."), tested: range };
  return { status: "tested", version: v.join("."), tested: range };
}

/** The environment a child gets: `base` (default: this process's), minus Electron's ELECTRON_RUN_AS_NODE and the names in strip. Never changes base. */
export function childEnv(strip = [], base = process.env) {
  const env = { ...base };
  for (const k of ["ELECTRON_RUN_AS_NODE", ...strip]) delete env[k];
  return env;
}

/**
 * Plain-language reason for an engine failure, with the next step. Rules are checked in order; the first match wins.
 * options: where (a script engine's script that ran; WorkBuddy only), settings (the words for where the user changes
 * the model or sign-in: "Settings" in an app, "your settings" in a library), emptyIsRefusal (an empty message is read as
 * the system refusing to start the program; default: "ended without saying why").
 */
export function explainError(id, message, { where, settings = "Settings", emptyIsRefusal = false } = {}) {
  const m = String(message || "").trim();
  const f = factsOf(id);
  const label = f?.label || id;
  const bin = f?.bin || id;
  const refusal = `${label} could not start: macOS refused to run its program (security policy). Restarting the Mac usually clears this.`;
  // 1. The program was killed at start (SIGKILL, exit 137): on macOS, the security policy.
  if (!m) return emptyIsRefusal ? refusal : `${label} ended without saying why.`;
  if (/exited with code (137|-9|null)|SIGKILL|killed/i.test(m)) return refusal;
  // 2. OpenRouter (through OpenCode) reserves the whole max_tokens: "requires more credits ... can only afford N" is the
  // provider account's balance, not a sign-in or engine problem (live 2026-11-23).
  if (/requires more credits|can only afford|insufficient credits|\b402\b/i.test(m)) return `${label}: the model's provider account is out of credit (or the request asks for more tokens than it can pay for). Choose a free model in ${settings} or add credit. ${m.slice(0, 160)}`;
  // 3. A usage limit on the engine's account.
  if (/usage limit|upgrade to plus|rate limit|quota/i.test(m)) return `${label} reports a usage limit on your account: ${m.slice(0, 200)}`;
  // 4. The account cannot use the chosen model.
  if (/not supported when using .* (ChatGPT|account)|model.*not (supported|available)/i.test(m)) return `${label} cannot use that model on your account: ${m.slice(0, 200)} Set another model for ${label} in ${settings}.`;
  // 5. A Cloudflare challenge is the provider's network edge refusing this connection, not a missing sign-in.
  if (/attention required|cloudflare|just a moment|cf-ray/i.test(m)) return `${label} was blocked by its provider's network protection (Cloudflare), not a sign-in problem. Usually temporary: try again in a few minutes, or turn off a VPN or proxy. ${m.slice(0, 160)}`;
  // 6. OpenCode signs in per provider: this names the model's provider, not OpenCode itself.
  if (id === "opencode" && /provider authentication required/i.test(m)) {
    const model = m.match(/\(model ([^)]+)\)/)?.[1];
    return `OpenCode has no working sign-in for the provider of ${model ? `the model it used (${model})` : "the model it used"}. Choose a model of a provider you signed in to (set it in ${settings}), or sign in to that provider with \`opencode auth login\`. ${m.slice(0, 160)}`;
  }
  // 7. Not signed in. WorkBuddy's CLI is a Node script: its /login did not start in 2.165.0, so the web sign-in (--serve) is named too.
  if (/not logged in|log ?in|authenticat|unauthori[sz]ed|401|invalid api key|credentials/i.test(m)) {
    const how = id === "workbuddy"
      ? `In Terminal run: node "${where || f.script}" and type /login (once). If it exits at once, sign in with its web server: node "${where || f.script}" --serve.`
      : `Open a terminal and run \`${bin} login\` (or start it once) to sign in.`;
    return `${label} is not signed in. ${how} ${m.slice(0, 160)}`;
  }
  // 8. Anything else: the engine's own words, with its name.
  return `${label}: ${m.slice(0, 400)}`;
}
