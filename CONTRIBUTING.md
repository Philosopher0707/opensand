# Contributing to OpenSand

OpenSand is a pnpm TypeScript monorepo implementing a clean-room, local-first
coding agent. This guide covers the workflow that keeps the tree safe and green.

## Setup

```sh
git clone https://github.com/Philosopher0707/opensand.git
cd opensand
pnpm install
pnpm run build
pnpm run test
```

Node 22+ is required. The build is `tsc -b` across all packages; tests use
`node --test` against compiled output.

## Layout

```
packages/
  coordinator/          Turn loop, orchestration, memory, rooms, routines,
                        orchestrator tool registration, token hygiene
  local-exec-daemon/    Command execution, file ops, bash validator,
                        policy engine, tool registry, state manager
  native-bridge/        macOS Vision OCR, window capture, 1Password runner,
                        Messages reader, speech synthesis
  cli/                  Terminal REPL + one-shot runner, config, doctor
  desktop/              Electron app, HTTP/SSE server, renderer UI
scripts/                Packaging (CLI bundle, macOS app), pre-commit hook,
                        opensand-desktop.sh supervisor (build + auto-restart)
dist/                   Build output (gitignored)
```

Runtime state (sessions, agents, vault, memories) lives in `~/.opensand/`,
outside the repo. The provider API key lives in the encrypted vault as
`default-api-key` (`~/.opensand/vault/`), never in `~/.opensand/config.json`
(`0600`, sanitized). Settings API: `GET /api/settings` returns
`apiKey: "********"` once the vault key is resolved at startup; a blank API
key field on save means "keep the saved key".

## Running the desktop server (no manual restarts)

Use the supervisor instead of launching `node .../desktop-server.js` directly:

```sh
./scripts/opensand-desktop.sh          # build if needed, start, watch src/ (auto rebuild+restart)
./scripts/opensand-desktop.sh --status
./scripts/opensand-desktop.sh --restart
./scripts/opensand-desktop.sh --stop
```

- Renderer-only edits (`packages/desktop/renderer/*`) need no restart — just refresh the browser.
- TypeScript edits (`packages/*/src`) — the watcher rebuilds and restarts for you.
- Authentication: The server enforces token auth on all REST, RPC, and SSE endpoints. The session token is persisted to `~/.opensand/server.token` (`0600`). Open the full link with `?token=...` printed in the startup log or enter the token into the UI's Authentication dialog.
- The old one-shot command `node packages/desktop/dist/src/desktop-server.js` still works
  for debugging, but does not watch for changes.

## Workflow rules (enforced by tooling, not memory)

1. **Check for in-progress work before editing.** Run `git status` and
   `git diff`. If there are uncommitted or untracked changes, **ask the user**
   whether work is in progress before touching anything. Never assume a
   clean tree.

2. **Stage by explicit path, never blanket.** Use `git add <explicit paths>`.
   Never `git add -A`, `git add .`, or `git commit -a` — a blanket add sweeps
   other people's in-flight work into your commit. The pre-commit hook
   (`scripts/pre-commit.sh`, installed as `.git/hooks/pre-commit`) refuses a
   commit that stages every modified file; the emergency override is
   `OPENSAND_ALLOW_BLANKET=1 git commit ...`.

3. **Verify before concluding.** Read files before modifying them. Reproduce a
   bug before fixing it. Run the build and tests after a change. Check the
   diff before reporting done.

4. **Backups before destructive changes.** Archive or copy anything you are
   about to delete or overwrite.

5. **Automate rules with tooling.** If a rule matters, it should be enforced
   by a hook, CI job, or a test — not by remembering.

6. **Read `AGENTS_LEARNING.md` before changing a gate, settings, or interactive
   behaviour.** It records the traps we already paid for. Run gates on the CI
   runtime: `.nvmrc` pins Node 22, and a gate that only passed locally is not
   proven.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm run build` | TypeScript build, all packages (`tsc -b`) |
| `pnpm run test` | `node --test` against compiled output, all packages |
| `pnpm --filter @opensand/desktop test` | Tests for one package |
| `pnpm --filter @opensand/desktop build` | Build one package |
| `scripts/pre-commit.sh` | Manual run of the pre-commit hook |

CI (`.github/workflows/ci.yml`) runs build + test on every push and pull
request to `main` on Node 22.

## Testing

- Tests live in `packages/<pkg>/test/*.test.ts`.
- Run a single package: `pnpm --filter @opensand/<pkg> test`.
- Build first: the test scripts run against `dist/`, so run
  `pnpm --filter @opensand/<pkg> build` if you've changed `src/` without
  rebuilding.

## Adding a tool

Tools are registered on the daemon via `registerCustomTool` (core tools in
`packages/local-exec-daemon/src/tool-registry.ts`, orchestrator tools in
`packages/coordinator/src/orchestrator-tools.ts`, native tools in
`packages/native-bridge/src/native-tools.ts`). A tool needs a definition
(name, description, JSON-schema `parameters`) and a handler. Gate tools that
touch the screen or shell behind `requiresGate`.

## Commits

Conventional-commit style: `feat(desktop): ...`, `fix(session): ...`,
`refactor(coordinator): ...`. The pre-commit hook runs build + tests and
blocks blanket staging; a commit is therefore also a verification artifact.
