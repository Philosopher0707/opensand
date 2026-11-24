# Prose policy rules (design; build-ready slices)

Status: designed 2026-11-12; slices below were checked against code at `879c983c9e5ca6a10670128b91e362499b19d19e` (`origin/main`, 2026-11-24). Not implemented. The regex/prefix rules in `policy-engine.ts` remain the only enforced rules until Slice 3 lands.

## Problem

Grok Bot 1.0.1 accepts `allow_instructions` / `block_instructions` in plain language ("never push to main", "running the test suite is fine"). OpenSand rules are structured `PolicyRule` objects (`packages/local-exec-daemon/src/policy-engine.ts:12-27`), which are precise but awkward to write.

## Decision

**Compile prose into ordinary `PolicyRule`s once, when the rule is written. Never ask a model at tool-call time.**

Why: enforcement stays deterministic, auditable and offline; a tool call never waits on a model; a prompt-injected tool output cannot argue its way past a rule, because no model is in the path when the rule is checked.

Rejected: classifying each tool call against the prose at run time. It is slow, costs a call per tool use, gives different answers for the same call, and puts a model the attacker can talk to inside the security boundary.

## Current code map (verified at 879c983)

| Concern | File and symbol |
| --- | --- |
| Approval modes `ask` / `auto_edit` / `auto` | `packages/shared/src/approval.ts:10` (`APPROVAL_MODES`) — **not** in `packages/coordinator`. `packages/coordinator/src/engines/types.ts:8` is a different engine mode (`plan`/`agent`/`ask`/`auto_edit`); do not conflate them. |
| Hard stops that must never be widened | `packages/shared/src/approval.ts:37` (`NEVER_AUTO = control, spend, self`), checked at `:74`; `shell_outside` at `:75`; tainted shell (`note` + `SHELLS`) at `:76`; taint set in `packages/desktop/src/ipc-bridge.ts:870-873`. |
| Other must-prompt gates | Dangerous / nested shell at `packages/desktop/src/ipc-bridge.ts:886-903`; explicit `REQUIRE_APPROVAL` at `:905-912`; unsandboxed shell at `:915-920`; skill/memory writes at `:927-935`. The `autoAllows()` short-circuit sits **after** all of them at `:923` (this ordering fixes the F1 finding in `docs/security/2026-11-23-threat-model-and-audit.md`). |
| Rule shape and evaluation | `PolicyRule` at `packages/local-exec-daemon/src/policy-engine.ts:12-27`; `evaluate()` at `:125-206` — DENY `:130`, REQUIRE_APPROVAL `:145`, ALLOW `:160`, fallback `:188`; `matchesConditions()` at `:208-281`. |
| Built-in deny set | `loadDefaultPresets()` at `packages/local-exec-daemon/src/policy-engine.ts:302-355` — sensitive paths `:304-313`, destructive commands `:316-332`. There is **no exported deny-sample constant** today; the slices add one. |
| Audit log | `getAuditLog(limit = 100)` at `packages/local-exec-daemon/src/policy-engine.ts:110`; cap 500 at `:65`. A 200-entry preview must pass `getAuditLog(200)` explicitly. |
| Where rules plug into the approval path | `packages/desktop/src/ipc-bridge.ts:907` (`daemon.evaluatePolicy`) and `packages/coordinator/src/coordinator.ts:432-449` (turn loop). `evaluatePolicy` is declared at `packages/local-exec-daemon/src/daemon.ts:181`; DENY / REQUIRE_APPROVAL are re-enforced in `executeTool` at `daemon.ts:198-224`. External engines gate at `packages/coordinator/src/engines/external-engine-runner.ts:117`. |
| Rule-facing API and UI | `packages/desktop/src/ipc-bridge.ts:1827-1841` (`getPolicies` / `setPolicy` / `deletePolicy` / `getPolicyAudit`); `POST /api/policies` at `packages/desktop/src/desktop-server.ts:1308-1313`; "Fail-Closed Boundaries" view at `packages/desktop/renderer/index.html:611`, controller `refreshBoundaries()` at `packages/desktop/renderer/app.js:2763`, create modal `:1341`, save handler `:5920`. The old doc's "Settings → Permissions" is not a real screen. |
| PR #229 (likely first to merge) | Adds `requestApprovalOutcome` in `packages/desktop/src/ipc-bridge.ts` and `denyModifiedArgs` in `packages/coordinator/src/coordinator.ts`; edited args are re-gated through `getGates()` + `evaluatePolicy()`, bash validation, nested-shell, unsandboxed and persistent-write gates. Prose rules must survive that path unchanged. |

Two verified gaps that shape the slices:

- `evaluatePolicy` accepts `context` (`daemon.ts:184`) and `matchesConditions` reads `initiators` / `actors` (`policy-engine.ts:224-233`), but **all three callers omit context**: `ipc-bridge.ts:907`, `coordinator.ts:433`, `external-engine-runner.ts:117`. An `initiators`-based prose rule would never match. The compiler refuses `initiators` and `actors` instead; wiring context through three call sites is a separate decision.
- The existing rule writer sends flat fields (`commandRegex`, top-level `tools`/`pathsPrefix`, `enabled: true`) at `packages/desktop/renderer/app.js:5930-5939`, and `POST /api/policies` stores the body verbatim (`desktop-server.ts:1310`). `PolicyRule.conditions` is nested and plural (`conditions.commandsRegex`, `policy-engine.ts:20`), so a rule created in the UI today has no `conditions`. Slice 3 fixes the writer because prose rules need it; `app.js:2788` also displays `p.commandRegex` instead of `p.conditions.commandsRegex`.

## Shape

```ts
interface PolicyRule {
  // ...existing fields...
  source?: {
    kind: "prose";
    text: string;          // what the user wrote
    textSha256: string;    // recompile when it changes
    compiledAt: number;
    compiler: string;      // model id that proposed the conditions
  };
}
```

Compiled fields are exactly `conditions.tools`, `conditions.commandsRegex`, `conditions.pathsPrefix`, `conditions.pathsRegex`, `conditions.domains` (`policy-engine.ts:18-26`). `initiators` and `actors` are refused by the compiler (see above).

## Flow

1. The user writes a sentence in the Fail-Closed Boundaries create-rule modal (`index.html:1341`) and presses **Preview**. Nothing is saved.
2. The compiler (one model call, strict JSON schema whose fields are `PolicyRule.conditions`) proposes the conditions and issues, or returns no conditions with a plain reason.
3. **Dry run:** the proposal is evaluated against `getAuditLog(200)`. The user sees "would have allowed 14 calls, would have blocked 2" with examples. Empty audit says so; it never invents samples.
4. The validated rule is saved with `enabled: false` and `source`. Only the user's explicit **Turn on** action enables it. A routine, a subagent, a model or an edited-approval outcome cannot enable it.
5. If the compiler cannot produce conditions, or the proposal is ambiguous, the sentence is kept as an unenforced note and the UI says so. Nothing is ever enforced from a guess.

## Asymmetry and hard-stop invariants

- Block prose may compile to `DENY` or `REQUIRE_APPROVAL`.
- Allow prose compiles only to `ALLOW`, only with at least one named tool, and for `exec_command` an anchored `commandsRegex` (`^...`). Refuse an unanchored `.*`, shell chaining (`;`, `&&`, `|`, `` ` ``, `$(`), a tool wildcard, or an empty condition set.
- A compiled `ALLOW` is refused if it matches any built-in DENY sample (`/etc/`, `.ssh`, `.env`, `rm -rf`, ...). DENY is evaluated first (`policy-engine.ts:130`), so this stops the user being told they are allowed something that is still blocked.
- **No prose rule widens a hard stop.** Rules are data consumed only by `PolicyEngine.evaluate()`; they carry no effect. `NEVER_AUTO` (`control`, `spend`, `self`), `shell_outside`, tainted shell, the safety ceiling and persistent-write gates are checked in `autoAllows()` (`approval.ts:74-76`) and `requestUserApproval()` (`ipc-bridge.ts:886-935`), outside `evaluate()`. The `DENY` phase stays first. A compiled rule cannot add authority it does not have, and enabling one never removes a gate.

## Build slices

Ordered so the first slice is user-visible with **zero enforcement surface**; the gate lands before anything can be enabled; PR #229 parity lands last.

### Slice 1 — Dry-run preview (no save, no enforcement)

**Goal:** a user types a sentence in the Boundaries modal and sees what it *would* have done. Nothing is persisted, no rule is enabled, `evaluate()` is untouched.

**Files / symbols:**
- New `packages/local-exec-daemon/src/prose-compiler.ts`: `compileProse(text)` (strict JSON schema, stubbed in CI); `prosePreview(conditions, audit)` → counts + up to two examples.
- `packages/local-exec-daemon/src/daemon.ts:181` area: expose `compileProse(text)` and `previewProse(text)` (reads `getAuditLog(200)`).
- `packages/desktop/src/ipc-bridge.ts:1839` area: `previewProse(text)`.
- `packages/desktop/src/desktop-server.ts:1308` area: `POST /api/policies/preview`.
- `packages/desktop/renderer/index.html:1341` (textarea + Preview button), `packages/desktop/renderer/app.js:607-629` (client method), `app.js:5920` (preview handler).

**Done when** (runnable, compiler stubbed, no live model in CI):
- `pnpm --filter @opensand/local-exec-daemon run test` — `test/prose-compiler.test.ts`: golden fixtures ("never push to main" → `DENY` + `^git push\b`; "running the test suite is fine" → `ALLOW`) and the preview counts from a seeded 200-entry audit; empty audit reports no samples.
- Failure paths in the same file: bad prose (empty / uncompilable) and ambiguous prose ("be careful with stuff") return `issues` and **no** conditions; `getRules()` length unchanged; a spy asserts zero model calls during `daemon.evaluatePolicy`.
- `pnpm --filter @opensand/desktop run test` — `test/prose-policy-preview.test.ts`: preview endpoint returns counts + examples; malformed body → HTTP 400, no bridge state change.

**Depends on:** nothing.

### Slice 2 — Safety gate (no UI change)

**Goal:** nothing that could widen a hard stop can become an enforceable rule.

**Files / symbols:**
- `packages/local-exec-daemon/src/policy-engine.ts:302-355`: export `getDenySamples()` derived from the active DENY presets (single source of truth).
- `packages/local-exec-daemon/src/prose-compiler.ts`: `validateCompiledRule(rule)` — anchoring, chaining, wildcard, non-empty tool, deny-sample collision, refused `initiators`/`actors`. `evaluate()` and its phase order (`policy-engine.ts:125-206`) are **not** changed.

**Done when:**
- `pnpm --filter @opensand/local-exec-daemon run test` — property test: for every accepted ALLOW fixture × every `getDenySamples()` entry, `evaluate()` still returns `DENY`; mutation probe: removing the anchoring check makes the named fixture fail.
- Failure paths: unanchored `.*`, `;`, `&&`, `|`, backtick, `$(`, `*`, empty conditions, and `initiators`/`actors` each refused with a reason.
- `pnpm --filter @opensand/shared run test` — `test/approval.test.ts`: a compiled ALLOW rule enabled for `control`/`spend`/`self`/`shell_outside`/tainted shell still leaves `autoAllows()` false or prompts in `requestUserApproval`.

**Depends on:** Slice 1.

### Slice 3 — Save as disabled draft, explicit Turn on

**Goal:** a validated preview can be saved and enforced, but only after the user's own click.

**Files / symbols:**
- `packages/local-exec-daemon/src/policy-engine.ts:12-27`: add `source?`; keep `setRule` (`97`) / `persistToDisk` (`371`) round-tripping it.
- `packages/desktop/src/ipc-bridge.ts:1831` `setPolicy` (reject invalid or `enabled: true` prose drafts); new `enableProseRule(id, userAction)`.
- `packages/desktop/src/desktop-server.ts:1308` `POST /api/policies` (draft only) + `POST /api/policies/:id/enable`.
- `packages/desktop/renderer/app.js:5930-5939`: write nested `conditions` (`commandsRegex`, plural) and `enabled: false`; `app.js:2788` display the nested field; modal shows "Not enforced" + **Turn on**.

**Done when:**
- `pnpm --filter @opensand/local-exec-daemon run test`: prose rule round-trips through `setRule`/`getRule`; `evaluate()` on a saved draft returns the fallback (rule not enforced) and does not throw on missing conditions.
- `pnpm --filter @opensand/desktop run test`: enabling requires the explicit user action; a routine / subagent / model path and a direct `setPolicy({ enabled: true })` cannot flip a prose rule; bad prose is stored as a note with zero rules added; `textSha256` present.

**Depends on:** Slice 2 (validation) and Slice 1 (preview).

### Slice 4 — Drift and edited-approval parity

**Goal:** stale prose stops enforcing; an approval edit cannot dodge the prose rule or a hard stop.

**Files / symbols:**
- `packages/local-exec-daemon/src/prose-compiler.ts`: `textSha256` drift check; changed text keeps the rule disabled until recompiled and re-previewed.
- After PR #229 merges: `packages/coordinator/src/coordinator.ts` `denyModifiedArgs` and `packages/desktop/src/ipc-bridge.ts` `requestApprovalOutcome` re-gate edited args through the same `evaluatePolicy()` and hard stops.

**Done when:**
- `pnpm --filter @opensand/local-exec-daemon run test`: changing `source.text` disables enforcement until explicit re-enable; compiler unavailable → note only, no change to enforced rules, no model call at tool time.
- `pnpm --filter @opensand/coordinator run test` — `test/approval-modified-args.test.ts` plus `pnpm --filter @opensand/desktop run test` — `test/ipc-bridge.test.ts`: an `approve_modified` edit of a tainted shell / `control` / `spend` / `self` / `shell_outside` call still prompts or DENYs in **both** paths; an edit that raises the policy tier is refused (PR #229 rule).

**Depends on:** Slice 3; lands after PR #229.

## Deferred, with tripwires

- Wiring `initiators` / `actors` context through `ipc-bridge.ts:907`, `coordinator.ts:433` and `external-engine-runner.ts:117` — separate decision; until then the compiler refuses those fields.
- A general rewrite of the manual rule editor's data shape is folded into Slice 3 (prose needs the same writer); if it lands earlier, Slice 3 shrinks.
- The F1 `autoAllows()` ordering (`ipc-bridge.ts:923`) is an invariant, not a cleanup target: no slice may move that short-circuit above the must-prompt gates.

Effort: the original "one PR, medium" is now four small PRs; no change to `evaluate()`.
