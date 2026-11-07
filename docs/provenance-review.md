# Provenance review

**Date opened:** 2026-11-07
**Status:** REVIEWED: all 14 rows carry a verdict as of `6bb7ccc`. The go/no-go on distributing binaries remains with the repository owner.
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
| `packages/coordinator/src/orchestrator-tools.ts` | 42 | high — tool names and shapes may mirror the target | **clean** (behaviour note): all 42 matches are comments naming the mirrored tool; handlers are local TypeScript over OpenSand stores. First commit `5ee30ac` |
| `packages/desktop/src/rpc-gateway.ts` | 11 | high — wire method names are protocol facts, copied handlers are not | **clean** (protocol fact): service and method names recorded in `docs/protocol-notes.md`; bodies are OpenSand types, no vendored proto. First commit `b764ddd` |
| `packages/desktop/src/ipc-bridge.ts` | 7 | medium | **clean** (behaviour note): comments only, parity markers on locally implemented IPC handlers. First commit `bba1761` |
| `packages/desktop/src/desktop-server.ts` | 6 | medium | **clean** (protocol fact): seven HTTP route names, recorded in `docs/protocol-notes.md`. First commit `bba1761` |
| `packages/coordinator/src/room-manager.ts` | 6 | medium | **clean** (behaviour note): header lists the mirrored RPC names; room logic is local. First commit `107ad92` |
| `packages/coordinator/src/memory-store.ts` | 5 | low — layout parity | **clean** (behaviour note): method names only; tier and promotion logic local. First commit `78c8840` |
| `packages/coordinator/src/routine-engine.ts` | 5 | low | **clean** (behaviour note): header lists RPC names; cron matcher is local. First commit `107ad92` |
| `packages/coordinator/src/skill-store.ts` | 4 | low | **rewritten** (`6bb7ccc`): two comments cited decompiled symbol names (`nq`, `OOt`, `U(e)`); replaced with behaviour text. The parser underneath was already a plain YAML frontmatter implementation. First commit `ac20d8a` |
| `packages/native-bridge/src/native-tools.ts` | 4 | low | **clean** (behaviour note): descriptions name the parity target; implementations are local macOS calls. First commit `15718c5` |
| `packages/coordinator/src/agent-store.ts` | 2 | low | **clean** (behaviour note): template export/import docstrings. First commit `5ee30ac` |
| `packages/coordinator/src/coordinator.ts` | 2 | low | **clean** (behaviour note): BTW and rollback docstrings. First commit `810c9be` |
| `packages/cli/src/cli-app.ts` | 1 | low | **clean** (behaviour note): one banner string. First commit `15718c5` |
| `packages/coordinator/src/transcript-manager.ts` | 1 | low | **clean** (behaviour note): one docstring. First commit `810c9be` |
| `packages/coordinator/src/connectors.ts` | 1 | low | **clean** (behaviour note): one marker comment. First commit `741db5b` |

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

## Sign-off

- **Reviewer:** Gump, engineering review for the repository owner
- **Date:** 2026-11-07
- **Scope:** all 14 rows above, reviewed at commit `6bb7ccc`. Each row was checked by reading every
  match and the implementation around it, not by counting references.
- **Statement:** no decompiled source, prompt text, or string table was copied into this distribution.
  The only decompiled artefacts found were three comments naming minified symbols in `skill-store.ts`;
  they were rewritten in `6bb7ccc`, and the code beneath them was already an independent
  implementation. Every remaining reference is a comment naming a tool, RPC method or route kept for
  compatibility, or a banner string.
- **Not decided here:** whether to distribute binaries. This file records the engineering inventory;
  the distribution decision is the repository owner's.
