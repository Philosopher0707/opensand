#!/usr/bin/env node
/**
 * Inspect or clear a CLI agent's credential home. Never prints credential values.
 *
 * Usage:
 *   node scripts/cli-agent-auth.mjs --provider <name> --home-env <ENV_VAR> --home-dir <dir> \
 *     [--signed-in-file <relative-path>] [--action status|clear]
 *   node scripts/cli-agent-auth.mjs --help
 */

const USAGE = `Usage: node scripts/cli-agent-auth.mjs [options]

Options:
  --provider <name>           Provider key used in the credential home path (required)
  --home-env <ENV_VAR>        Environment variable the CLI binary reads (required)
  --home-dir <dir>            Credential subdirectory name, e.g. .grok (required)
  --signed-in-file <path>     Credential file relative to home; enables sign-in detection
  --action status|clear       Action to perform (default: status)
  --help                      Show this help

Output: a single JSON line with only provider, home and signedIn.`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

function fail(message) {
  console.error(`cli-agent-auth: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`invalid or missing value for argument: ${name ?? ''}`);
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

const flags = parseFlags(args);
for (const required of ['provider', 'home-env', 'home-dir']) {
  if (!flags[required]) fail(`missing required --${required}`);
}
const action = flags.action ?? 'status';
if (action !== 'status' && action !== 'clear') fail(`invalid --action: ${action}`);

const spec = {
  provider: flags.provider,
  homeEnv: flags['home-env'],
  homeDir: flags['home-dir'],
  loginArgs: [],
  // Unused by status/clear; match nothing so no URL or code can ever be surfaced.
  urlPattern: /(?!)/,
  codePattern: /(?!)/,
  failureMessage: 'CLI agent auth inspection failed',
  ...(flags['signed-in-file'] ? { signedInFile: flags['signed-in-file'] } : {}),
};

const { wrapCliBinaryAuth } = await import(new URL('../packages/coordinator/dist/src/index.js', import.meta.url).href);
const auth = wrapCliBinaryAuth(spec);
if (action === 'clear') auth.clear();
const signedIn = action === 'clear' ? false : auth.isSignedIn();
console.log(JSON.stringify({ provider: spec.provider, home: auth.home, signedIn }));
