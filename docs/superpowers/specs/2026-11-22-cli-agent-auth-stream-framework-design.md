# Design: CLI agent auth wrapper, chat-stream conventions and OpenSand framework fidelity

Date: 2026-11-22
Status: design approved by owner in conversation; rewritten after spec review
Baseline: `39a94f6`, branch `feat/agent-settings-ui`. `CONTEXT.md` section 7 is the running phase log.

## Problem (verified)

- Auth writes credentials into a home derived from a random `auth:<kind>:<uuid>` id
  (`provider-auth.ts:33`, `device-auth.ts:62-64`), but turn subprocesses build env as
  `{...process.env, ...input.environment}` with no credential home (`acp-runtime.ts:136`,
  `claude-runtime.ts:166`, `codex-runtime.ts:122`). Chat/catalog use `llm:`/`catalog:` ids, so the digest
  can never match. No turn sees sign-in credentials.
- The login child's `exit` handler resolves without re-checking `isSignedIn()` (`device-auth.ts:125-128`),
  and `finish()` nulls the flow so `get()` returns `cancelled` (`device-auth.ts:77-83,179-183`). No code
  produces `"authorized"` although `provider-auth.ts:86` consumes it.
- `AUTH_PROVIDER_KINDS` is a hardcoded 3-element set (`provider-auth.ts:21`, `desktop-server.ts:1438`);
  `GET auth/status` requires a flowId (`desktop-server.ts:1470-1474`).
- `dispatchDriverEvent` (`ipc-bridge.ts:821-843`) drops `permission.request`; ACP/Codex approvals wait for
  the fail-closed 15-min timeout (`acp-runtime.ts:64,178-185`, `codex-runtime.ts:51,175-178`).
  `text.delta` is deliberately **not** forwarded (shim consolidates text) — correct, do not change.
- Framework prompt is joined into `turn.system` (`provider-llm.ts:77-92`) then concatenated into **user**
  text by all three runtimes (`claude-runtime.ts:234-237`, `acp-runtime.ts:276`, `codex-runtime.ts:257`).
  It claims OpenSand tools while ACP passes `mcpServers: []` (`acp-runtime.ts:242`).

## Non-goals

- Do not replace retained-process streaming or change the shim's consolidated-text behavior.
- Do not delete dead `AgentWrapper` (`coordinator/src/agent-wrapper.ts`) without owner approval.
- Do not add CLI-agent selection to the terminal CLI (`cli-app.ts:399-403`).
- No live cloud sign-in; only fake-CLI tests and installed-binary probes.
- Do not weaken approval gates or fail-closed timeouts.
- No new `approvalMode` plumbing: `config.fullAuto` already yields Claude `bypassPermissions`
  (`claude-runtime.ts:48-53,163`); verify it, do not add a parallel flag.
- No `CLAUDE_CONFIG_DIR` change — `configDir` is currently unused but unrelated to auth; leave it.

## Architecture

### P1 — Auth core: one stable credential home, observable sign-in
- In `device-auth.ts` add a **new stable** layout (no random digest):
  `credentialHome(spec) = path.join(os.homedir(), '.opensand', 'providers', spec.provider, spec.homeDir.replace(/^\./,''))`.
  This intentionally replaces the per-instance digest; `spec.homeDir` becomes used for the first time.
- Export `credentialEnv(spec, environment)` = `{...environment, [spec.homeEnv]: credentialHome(spec)}`.
  Call sites must pass the full base env: `credentialEnv(spec, {...process.env, ...input.environment})`.
- `createDeviceAuthController` uses `credentialEnv`; extend `DeviceAuthController` with
  `isSignedIn(): Promise<boolean>` (wraps the existing `statSync(...).size > 0`) and keep a
  `lastStatus: ProviderAuthenticationStatus | null` that survives `finish()` nulling `flow`.
  `get(flowId)` returns `lastStatus` when its `flowId` matches, otherwise `cancelled`.
- In `start()` immediately after `await run(spec.loginArgs, ...)` (`device-auth.ts:152-169`) — `run()`
  resolves when the login child exits — re-run `isSignedIn()`; if true, `finish({status:'authorized',
  flowId:id, ...})`, otherwise `finish({status:'failed', ...})` with `spec.failureMessage`. Do this in
  `start()` (not inside generic `run()`, where `id` and flow identity are not in scope). `finish()` stores
  into `lastStatus` unconditionally, so an authorized result can overwrite an earlier timer `failed`.
  Define signed-in strictly as non-empty credential file; "corrupt" JSON is not detectable generically
  and is not claimed.
- Extend `ProviderInstance` (`shared/src/types.ts:511-534`) with optional `isSignedIn?: () => Promise<boolean>`
  and wire it in `acp-runtime.ts` instance (`authenticationMethod` block at :304-313) to the controller.
  `provider-auth.ts` adds `getProviderAuthState(kind)` using `ensureSession()` + `isSignedIn()`;
  keep stable session per kind by replacing `auth:${kind}:${randomUUID()}` with `auth:${kind}`.
- `acp-runtime.ts`: the auth spec lives on **`options.auth`** (`AcpRuntimeOptions.auth:37`, used at :72),
  not on `input`. At spawn (`:136`) use `credentialEnv(options.auth, {...process.env, ...input.environment})`
  when auth exists. Claude/Codex keep standard HOME behavior.
- Regression: fake CLI writes a credential file under `homeEnv` during `loginArgs`; `start()` → child exit →
  `getProviderAuthStatus(kind, flowId)` returns `authorized`; a subsequent ACP turn spawn asserts
  `env[homeEnv] === credentialHome(spec)`.

### P2 — Auth API and UI derive from drivers
- Add `supportsAuthentication?: boolean` and `cli?: boolean` to `ProviderDriver.metadata`
  (`shared/src/types.ts:641-654`); `defineAcpDriver` (`factories/acp-driver.ts`) sets both (auth from
  `spec.auth`, CLI true), and Claude/Codex factories set `cli:true`. Remove the hardcoded
  `AUTH_PROVIDER_KINDS` set and derive auth capability from `providerRegistry` drivers.
- `desktop-server.ts`: add `GET /api/providers/:kind/auth/state` returning `{signedIn, flowId}` from
  `getProviderAuthState(kind)`; keep existing start/cancel/sign-out/status routes.
- Renderer: `model-picker.js` / `app.js` shows signed-in/out per provider from the state route and hides
  the "sign in" hint when already signed in. No credential values reach the UI.
- Security note: with a stable home, `signOut()` `rmSync(home, {recursive:true,force:true})`
  (`device-auth.ts:197`) removes credentials for all instances of that provider — intended CLI-like
  behavior, documented in the spec and UI tooltip.

### P3 — Stream conventions and framework fidelity
- Keep `dispatchDriverEvent`'s deliberate `text.delta` skip. Add permission handling in the **shim**
  (`provider-llm.ts`), not by adding a DesktopEvent type or new IPC method:
  - `DriverLlmClientInput` gains `onPermissionRequest?: (req) => Promise<{behavior:'allow'|'reject'}>`.
    The bridge supplies it via `requestUserApproval(toolName, args, reason, sessionId, forcePrompt=true)`
    — add the optional `forcePrompt` parameter so CLI permissions cannot be silently auto-approved by
    `settings.autoApprove` (`ipc-bridge.ts:990-992`). The approval system returns a boolean; map
    `true → {behavior:'allow'}`, `false → {behavior:'reject'}`. `always_allow` is treated as allow-once
    for CLI permissions (documented; no separate standing rule for provider permissions).
  - ACP/Codex `permission.request` events already carry `threadId`/`requestId` (`acp-runtime.ts:178`,
    `codex-runtime.ts:175`). The shim passes them with method/options to `onPermissionRequest`, then calls
    **`instance.adapter.respondToRequest(threadId, requestId, decision)`** — `respondToRequest` is on
    `ProviderAdapter` (`shared/src/types.ts:586`), not `ProviderInstance`. The shim already holds
    `instance` directly (`provider-llm.ts:58-62,150`); no instance-id round-trip is needed.
  - No UI response → existing fail-closed timeout; no silent approval.
- Framework prompt:
  - Add `toolClaim?: 'full' | 'none'` to `SystemPromptContext` (`system-prompt.ts:3-11`). `buildSystemPrompt`
    emits the "Tools Available" section only for `'full'` (default), so existing callers are unchanged.
    `AgentCoordinator` passes `systemPromptContext` through (`coordinator.ts:103`).
  - For CLI drivers (`metadata.cli === true`) the bridge sets `toolClaim:'none'`; normal in-process turns
    stay `'full'`.
  - Claude: this machine's `claude --help` lists `--system-prompt <prompt>` (not a file flag). On the
    retained child's **first spawn** pass the framework prompt with `--system-prompt <text>` from
    `turn.system`, and remove the per-turn concatenation at `claude-runtime.ts:234-237` when the flag is
    used. It is a first-turn snapshot; a changed system prompt requires a new child. If a future CLI lacks
    the flag, fall back to concatenation with a one-line comment.
  - ACP/Codex: no system channel exists in these protocols; keep concatenation with an explicit one-line
    comment and `toolClaim:'none'`.
- Tests: permission request → approve → `respondToRequest` called with `allow`; reject → `reject`; no response
  → timeout; framework prompt not duplicated in user text for Claude when the flag is supported;
  `toolClaim:'none'` removes tool claims; `fullAuto` still reaches `--permission-mode bypassPermissions`.

### P4 — Verification and documentation
- Full hermetic gate; `real-cli-compat.test.ts` smoke for installed binaries; per-phase spec + quality
  reviews; `CONTEXT.md` section 7, `AGENTS_LEARNING.md`, commonplace source note and daily memory.

## Error handling / edge cases
- Unknown provider kind → sign-in/state routes return null/404, never throw into the UI.
- Missing or empty credential file → `signedIn:false`.
- Login timeout with credential present → successful child exit overwrites `failed` with `authorized`.
- Approval request with no UI response → existing timeout; no silent acceptance.
- `signOut()` blast radius on a shared stable home documented and surfaced in the UI tooltip.

## Testing
- P1 fake-CLI credential round-trip + env propagation + authorized status.
- P2 driver-derived auth capability + state route + UI marker.
- P3 permission bridge response + system-prompt channel + tool-claim + fullAuto check.
- P4 gate + real CLI probes + reviews + docs.

## Risks
- CLI binaries may not be installed; live probes are best-effort and reported honestly.
- `--system-prompt` availability was checked in this environment's `claude --help`; other versions may lack it, with concatenation as the documented fallback.
- Stable credential home removes per-instance isolation by design; sign-out deletes all instances' creds.
