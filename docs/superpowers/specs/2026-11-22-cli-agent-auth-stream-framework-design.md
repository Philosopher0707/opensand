# Design: CLI agent auth wrapper, chat-stream conventions and OpenSand framework fidelity

Date: 2026-11-22
Status: approved by owner in conversation ("continue" after scope presentation)
Baseline: `39a94f6`, branch `feat/agent-settings-ui`. `CONTEXT.md` gets a section-7 phase log updated after every phase.

## Problem

CLI coding agents (Grok, Kimi, Copilot via ACP; Claude Code and Codex via their runtimes) do not reliably
authenticate or follow the OpenSand framework. Evidence:
- Auth writes credentials into a per-instance home derived from a random `auth:<kind>:<uuid>` id
  (`provider-auth.ts:33`, `device-auth.ts:62-64`), but turn subprocesses build env as
  `{...process.env, ...input.environment}` with no credential home (`acp-runtime.ts:136`,
  `claude-runtime.ts:166`, `codex-runtime.ts:122`). Chat/catalog use different instance ids
  (`llm:`, `catalog:`) so the digest can never match.
- The login child's `exit` handler (`device-auth.ts:125-128`) resolves without re-checking
  `isSignedIn()`; no code produces `"authorized"` even though `provider-auth.ts:86` consumes it.
  `GET auth/status` without a flowId returns `cancelled` (`desktop-server.ts:1470-1474`).
- `AUTH_PROVIDER_KINDS` is a hardcoded 3-element set (`desktop-server.ts:1438`) instead of derived from
  registered drivers' auth capability.
- `dispatchDriverEvent` (`ipc-bridge.ts:821-843`) handles tool/reasoning events but drops
  `permission.request`; ACP/Codex approval requests wait for the 15-min fail-closed timeout.
  `text.delta` is **deliberately** not forwarded because the shim consolidates text — this is correct
  and must not be changed.
- The framework system prompt (`system-prompt.ts:16-69`) is joined into `turn.system` by the shim
  (`provider-llm.ts:77-92`) but each runtime concatenates it into the **user** text
  (`claude-runtime.ts:234-237`, `acp-runtime.ts:276`, `codex-runtime.ts:257`). The prompt also claims
  OpenSand tools while ACP passes `mcpServers: []` (`acp-runtime.ts:242`). Approval mode never reaches
  the shim, so Claude always spawns with `--permission-mode default`.

## Non-goals

- Do not replace the retained-process streaming protocols or change the shim's consolidated-text behavior.
- Do not delete the dead `AgentWrapper` (`coordinator/src/agent-wrapper.ts`) without owner approval.
- Do not add CLI-agent selection to the terminal CLI (`F10`, `cli-app.ts:399-403`).
- No live cloud sign-in; only local fake-CLI and already-installed binary probes.
- Do not weaken approval/security gates; fail-closed timeouts stay.

## Architecture

### P1 — Auth core: one credential home, observable sign-in
- In `device-auth.ts` export a pure `credentialHome(spec): string` using the existing base
  `~/.opensand/providers/<spec.provider>/<spec.homeDir leaf>` (no random instance digest) and
  `credentialEnv(spec, environment): Record<string,string>` returning
  `{...environment, [spec.homeEnv]: credentialHome(spec)}`.
- `createDeviceAuthController` uses `credentialEnv`; `instanceId` is no longer part of the home. Keep the
  bounded flow, URL/code allowlists and output cap unchanged.
- `auth start` → on login child `exit`, re-run `isSignedIn()` and `finish({status:"authorized"})` if the
  credential file is non-empty, else `failed` with `spec.failureMessage`. Expose `isSignedIn()` on the
  controller.
- `provider-auth.ts`: stable session per kind (`auth:${kind}`), `getProviderAuthState(kind)` returning
  `{signedIn:boolean, flowId:string|null}` by calling `isSignedIn()`; `getProviderAuthStatus` unchanged for
  flow polling. `ensureSession` uses `credentialEnv` through the driver instance so catalog/chat/turn
  instances share the home.
- ACP runtime spawn env (`acp-runtime.ts:136`) applies `credentialEnv(input.auth, input.environment)`
  when the driver has an auth spec; Claude/Codex keep standard HOME behavior but must not lose
  `configDir` if provided (set `CLAUDE_CONFIG_DIR` from `ClaudeConfig.configDir`).
- Regression: fake CLI writes a credential file into `homeEnv` during `loginArgs`; after `start()` exits,
  status is `authorized`; a subsequent ACP turn spawn asserts the same `homeEnv` value.

### P2 — Auth API and UI derive from drivers
- `desktop-server.ts`: `AUTH_PROVIDER_KINDS` derived from registered drivers that expose auth; add
  `GET /api/providers/:kind/auth/state` returning `{signedIn, flowId}` without requiring a flowId.
- Renderer (`model-picker.js`, `app.js`): show a signed-in/out marker per CLI provider and disable the
  "sign in" hint when already signed in. Keep the existing auth start/cancel/sign-out REST paths.
- Tests: REST state route for signed-out and signed-in fake homes; UI marker test in the harness.

### P3 — Stream conventions and framework fidelity
- `ipc-bridge.dispatchDriverEvent`: add a `permission.request` branch that emits a desktop approval event
  with `{requestId, method, options, sessionId}`; wire the response path back to the owning instance's
  `respondToRequest(threadId, requestId, decision)` via a new bridge method exposed through preload/main.
  Keep fail-closed timeout as the fallback.
- Framework prompt for CLI drivers:
  - Claude: pass the framework/system prompt through a real system channel (`--system-prompt` or temp file
    on the retained child's first spawn) instead of prefixing user text; keep stream-json parsing intact.
  - ACP/Codex: if the protocol has no system channel, keep the current concatenation but make it explicit
    in code with a one-line comment and stop claiming OpenSand tools in that path.
  - `system-prompt.ts`: add a `toolClaim` option (or omit the tools section) when the runtime has
    `mcpServers: []`; default behavior unchanged for the normal coordinator.
  - Propagate `approvalMode` from `SendTurnInput`/driver config into the shim/runtime so `fullAuto`
    reaches Claude's `--permission-mode`; ACP/Codex map it to their config option where supported.
- Tests: permission request → approve → `respondToRequest` called; denial → fail-closed; framework prompt
  appears as system (Claude) and not duplicated in user text; approval-mode flag reaches spawn args.

### P4 — Verification and documentation
- Full hermetic gate; `real-cli-compat.test.ts` smoke for installed binaries; live screenshot of provider
  auth panel if a CLI is installed; per-phase spec/quality reviews; `CONTEXT.md` section 7,
  `AGENTS_LEARNING.md`, commonplace source note and daily memory.

## Error handling / edge cases
- Unknown provider kind → sign-in/status routes return null/404, no crash.
- Corrupt/missing credential file → `signedIn:false`.
- Login timeout with credential present → `authorized` (recheck wins over timeout race if login already exited).
- Approval request with no UI response → existing timeout marks failed; no silent acceptance.
- No approval when `autoApprove` false? Existing gate policy unchanged.

## Testing
- P1: fake-CLI auth round-trip + env propagation + authorized status.
- P2: driver-derived auth capability + state route.
- P3: permission bridge response + system-prompt channel + approval-mode propagation.
- P4: full gate + real CLI probes + reviews + docs.

## Risks
- Several CLI binaries may not be installed; live probes are best-effort and reported honestly.
- Changing Claude's system prompt channel can alter model behavior; default path untouched and tested.
- Stable credential home means multiple OpenSand instances share CLI credentials — this is the intended
  "normal CLI login" behavior and removes the previous impossible instance-id mismatch.
