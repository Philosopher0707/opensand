# Provenance review

**Date opened:** 2026-11-07
**Status:** OPEN — binaries must not be distributed until every row below has a verdict
**Owner:** repository owner
**Scope:** source under `packages/*/src`, `scripts/`, and any text shipped in the UI

This is an engineering inventory, not a legal opinion.

## Why this exists

`README.md` and `CONTEXT.md` describe OpenSand as a clean-room implementation derived from
observed behaviour of Grok Bot 0.78.1. Observing behaviour and writing fresh code is fine.
Copying code, prompts, or distinctive strings out of a decompiled bundle is not, and it is the
one risk that cannot be fixed after a public release.

The review asks one question per file: **does this code exist because someone watched the app
behave, or because someone copied what was inside it?**

## Current inventory

14 source files mention Grok Bot, Anysphere, or the upstream endpoint. Reference counts are
line matches, not a risk score, but they show where to look first.

| File | References | Risk | Verdict |
|---|---:|---|---|
| `packages/coordinator/src/orchestrator-tools.ts` | 42 | high — tool names and shapes may mirror the target | — |
| `packages/desktop/src/rpc-gateway.ts` | 11 | high — wire method names are protocol facts, copied handlers are not | — |
| `packages/desktop/src/ipc-bridge.ts` | 7 | medium | — |
| `packages/desktop/src/desktop-server.ts` | 6 | medium | — |
| `packages/coordinator/src/room-manager.ts` | 6 | medium | — |
| `packages/coordinator/src/memory-store.ts` | 5 | low — layout parity | — |
| `packages/coordinator/src/routine-engine.ts` | 5 | low | — |
| `packages/coordinator/src/skill-store.ts` | 4 | low | — |
| `packages/native-bridge/src/native-tools.ts` | 4 | low | — |
| `packages/coordinator/src/agent-store.ts` | 2 | low | — |
| `packages/coordinator/src/coordinator.ts` | 2 | low | — |
| `packages/cli/src/cli-app.ts` | 1 | low | — |
| `packages/coordinator/src/transcript-manager.ts` | 1 | low | — |
| `packages/coordinator/src/connectors.ts` | 1 | low | — |

Checked and currently clean:

- No tracked binaries, bundles, `.asar`, `.wasm`, or extracted JavaScript (`git ls-files`).
- `dist/` is generated and not tracked.
- No "adapted from" or third-party copyright headers in `packages/*/src`.

## Procedure (one row at a time)

1. Find the file's first commit: `git log --follow --diff-filter=A --format='%h %ad %s' --date=short -- <file>`.
2. Read every match. Classify it as one of:
   - **behaviour note** — "returns the same shape because the UI expects it"; keep the note, keep the code.
   - **protocol fact** — endpoint or method name required for compatibility; keep, and document the source as observed traffic, not source code.
   - **copied artefact** — code, prompt text, or distinctive strings lifted from the bundle; rewrite from a written spec.
3. For a rewrite, first write the behaviour down in `docs/protocol-notes.md` (inputs, outputs, state
   changes, errors), then implement from that note with the original out of sight.
4. Record the verdict in the table: `clean`, `rewritten (<commit>)`, or `removed (<commit>)`.

## Exit criteria

- Every row has a verdict and a commit or note as evidence.
- `docs/protocol-notes.md` exists for anything marked *protocol fact*.
- A short sign-off at the bottom of this file: reviewer, date, and the statement that no decompiled
  source, prompt, or string table was copied into the distribution.
- Only then does `release.yml` get publishing credentials.
