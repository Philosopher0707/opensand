# CLI Agent Auth and Framework Fidelity Implementation Plan

> For agentic workers: use subagent-driven-development. Steps use `- [ ]`.

**Goal:** CLI agents sign into one stable credential home, every turn sees it, sign-in state is observable, permission requests are answered through the existing approval UI, and the OpenSand framework prompt is delivered honestly.

**Spec:** `docs/superpowers/specs/2026-11-22-cli-agent-auth-stream-framework-design.md`
**Baseline:** `27186d3` (plan commit; spec amended after), branch `feat/agent-settings-ui`.
**Context:** create section 7 in `CONTEXT.md` with the first Phase 1 entry; update after every phase.

---

## P1 — Auth core

### Task 1: failing tests
**Files:** `packages/coordinator/test/device-auth.test.ts`, `packages/coordinator/test/helpers/fake-cli.ts` (if needed), an ACP runtime test file

- [ ] **Step 1:** Add a second fake body beside `FAKE_LOGIN` (`:9-12`), keeping the original unchanged:
```ts
const FAKE_LOGIN_EXIT = `
import('node:fs').then((fs) => {
  fs.mkdirSync(process.env.GROK_HOME, { recursive: true });
  fs.writeFileSync(process.env.GROK_HOME + '/auth.json', 'token');
  process.stderr.write('Visit https://x.ai/activate?code=ABCD1234 to sign in\\n');
  process.exit(0);
});
`;
```
Write it via the existing `writeFakeCli(tmpDir, 'fake-login-exit', FAKE_LOGIN_EXIT)`.
- [ ] **Step 2:** New `it`: save `process.env.HOME`, set it to `tmpDir` (so `credentialHome` is isolated), create the Grok instance with `config: GrokAgentDriver.decodeConfig({cli: exitCli})` and `instanceId:'auth-exit'`. With `strict: true`, `assert.ok(instance.startAuthentication && instance.getAuthentication && instance.isSignedIn)` before calling them (follow `device-auth.test.ts:37-40`). Call `start()`, poll `get(flowId)` for up to 5 s and assert `status === 'authorized'`, then `assert.equal(await instance.isSignedIn(), true)`. Restore HOME in `finally`. A second instance with a different instanceId must also report `isSignedIn()===true`.
- [ ] **Step 3:** ACP env test: register a fake ACP CLI that writes `process.env.GROK_HOME` into a temp marker file at startup; create an ACP instance with the grok auth spec; spawn a turn/probe and assert the marker equals `credentialHome(spec)`.
- [ ] **Step 4:** Build + coordinator tests; failures must be about missing `isSignedIn`/`authorized`/home propagation, not undefined test symbols.

### Task 2: implementation
**Files:** `device-auth.ts`, `shared/src/types.ts`, `acp-runtime.ts`, `provider-auth.ts`, tests

- [ ] **Step 1:** Add to `device-auth.ts` (new stable layout, no instance digest):
```ts
export function credentialHome(spec: DeviceAuthSpec): string {
  return path.join(os.homedir(), '.opensand', 'providers', spec.provider, spec.homeDir.replace(/^\./, ''));
}
export function credentialEnv(spec: DeviceAuthSpec, environment: Record<string, string>): Record<string, string> {
  return { ...environment, [spec.homeEnv]: credentialHome(spec) };
}
```
Keep `randomUUID` for flow ids; remove `createHash` if now unused.
- [ ] **Step 2:** `createDeviceAuthController` sets `const env = credentialEnv(spec, environment)`. Add `lastStatus: ProviderAuthenticationStatus | null` and make `finish(status)` store it **before** nulling `flow`; `get(flowId)` returns `lastStatus` when its `flowId` matches else `cancelled`. Add `isSignedIn: async () => isSignedIn()` to `DeviceAuthController` (`:47-53`).
- [ ] **Step 3:** Add an optional `onExit?: () => void` parameter to `run()` (`device-auth.ts:85-90`) and call it inside the existing `child.on('exit', ...)` handler (`:125-128`), before resolving. `run()` may resolve earlier via `isReady()` (`:113-117`), so the re-check must hang off the real exit event, not the returned promise. In `start()` pass:
```ts
onExit: () => finish(isSignedIn()
  ? { status: 'authorized', flowId: id, authorizationUrl: null, expiresAt: null }
  : { status: 'failed', flowId: id, authorizationUrl: null, expiresAt: null, message: spec.failureMessage })
```
`id` is in scope at the `start()` call site. `finish()` stores `lastStatus` unconditionally, so an authorized exit overwrites an earlier timer `failed`. The original `FAKE_LOGIN` never exits, so its `status === 'pending'` assertions stay valid.
- [ ] **Step 4:** `shared/src/types.ts`: add `isSignedIn?: () => Promise<boolean>` to `ProviderInstance` (:511-534). In `acp-runtime.ts` the auth controller variable is `auth` (:72-74) and the instance block (:297-314) is in the same closure — add `isSignedIn: () => auth.isSignedIn()` beside `startAuthentication`.
- [ ] **Step 5:** `provider-auth.ts`: replace `auth:${kind}:${randomUUID()}` with `auth:${kind}`; add `getProviderAuthState(kind)` returning `{signedIn, flowId}` or `null` for unknown kinds, using `ensureSession()` and `instance.isSignedIn?.() ?? false`.
- [ ] **Step 6:** `acp-runtime.ts`: import `credentialEnv`; at spawn (`:136`) use `options.auth ? credentialEnv(options.auth, { ...process.env, ...input.environment }) : { ...process.env, ...input.environment }`. `options.auth` is the real seam (`AcpRuntimeOptions.auth:37`), not `input.auth`.
- [ ] **Step 7:** Build + tests green. Commit explicit paths, message `fix(auth): stable CLI credential home and observable sign-in`. Create `CONTEXT.md` section 7 with Phase 1 log (hash, counts, evidence) and commit it.

---

## P2 — Auth API and UI

### Task 3
**Files:** `shared/src/types.ts`, `factories/acp-driver.ts`, Claude/Codex driver factory files, `desktop-server.ts`, renderer `app.js` / `model-picker.js`, tests

- [ ] **Step 1:** Add `supportsAuthentication?: boolean` and `cli?: boolean` to `ProviderDriver.metadata` (`shared/src/types.ts:641-654`). `defineAcpDriver` sets `supportsAuthentication: Boolean(spec.auth)` and `cli:true`; Claude/Codex drivers set `cli:true`.
- [ ] **Step 2:** In `desktop-server.ts` the provider-map callback has `driver` (not `kind`) and `providerRegistry` is not imported — use `auth: driver.metadata.supportsAuthentication === true` directly at `:1438`; delete the hardcoded set import/use.
- [ ] **Step 3:** Import `getProviderAuthState` from the coordinator; add `GET /api/providers/:kind/auth/state` returning `{signedIn, flowId}`; unknown kind → `404 {error:'Unknown provider'}` using the same response shape as `:1461-1462`.
- [ ] **Step 4:** `model-picker.js:47-51` independently fetches `/api/providers`, so attaching state only in `app.js`'s `providerCatalog` would never reach it. In `desktop-server.ts` provider-list serialization (`~1429-1478`), for providers with `auth:true` compute `signedIn` via `getProviderAuthState(kind)` and include it in each provider object (no new endpoint needed for the picker; keep the state route for harness/tests). `model-picker.js` renders `mp-key-dot` (`:95`) and the sign-in hint (`:131-139`) from `provider.signedIn` instead of capability alone. In `app.js`, `loadProviderCatalog(selected)` (`:1201-1222`) and `updateProviderAuthPanel(kind)` (`:1231-1248`) use the same field. Tooltip notes sign-out clears the shared home.
- [ ] **Step 5:** Tests: state route signed-out/signed-in with a temp HOME; harness asserts dot/hint toggle.
- [ ] **Step 6:** Build + tests; commit explicit paths; message `feat(providers): driver-derived auth capability and state`; update `CONTEXT.md` Phase 2 log and commit.

---

## P3 — Stream + framework fidelity

### Task 4: permission round-trip
**Files:** `provider-llm.ts`, `ipc-bridge.ts`, tests (no preload/main changes)

- [ ] **Step 1:** Extend `DriverLlmClientInput` with `onPermissionRequest?: (req: {threadId:string; requestId:string; method?:string; options?:unknown}) => Promise<{behavior:'allow'|'reject'}>`.
- [ ] **Step 2:** In `createTextStreamShim`'s `onDriverEvent`, handle `event.type === 'permission.request'` (events carry `threadId`/`requestId` at `acp-runtime.ts:178`, `codex-runtime.ts:175`): call `onPermissionRequest` (fallback `{behavior:'reject'}`), then `instance.adapter.respondToRequest(threadId, requestId, decision)` — `respondToRequest` is on `ProviderAdapter` (`shared/src/types.ts:586`), and the shim already holds `instance` (`provider-llm.ts:58-62,150`). Catch/log errors; never approve by default.
- [ ] **Step 3:** At the `createDriverLlmClient` call site (`ipc-bridge.ts:698-712`) pass:
```ts
onPermissionRequest: async (req) => {
  const ok = await this.requestUserApproval(
    'provider_permission',
    { ...req },
    'CLI agent requests permission to continue',
    activeSessionId,
    true // forcePrompt: never silently auto-approve
  );
  return { behavior: ok ? 'allow' : 'reject' };
}
```
Add the optional 5th `forcePrompt` parameter to `requestUserApproval` (`:959-1007`) and skip the `settings.autoApprove` shortcut when true. No new DesktopEvent type or IPC method.
- [ ] **Step 4:** Tests: approve → `respondToRequest(...,{behavior:'allow'})`; reject → `reject`; `autoApprove:true` with `forcePrompt` still emits `approval_required`; no response → existing fail-closed timeout.

### Task 5: framework prompt honesty
**Files:** `system-prompt.ts`, `coordinator.ts`, `provider-llm.ts`, `ipc-bridge.ts`, `claude-runtime.ts`, `acp-runtime.ts`, `codex-runtime.ts`, tests

- [ ] **Step 1:** Add `toolClaim?: 'full'|'none'` to `SystemPromptContext`; `buildSystemPrompt` emits `## Tools Available` only for `'full'` (default). Add `toolClaim` to `AgentCoordinator` options and pass into `systemPromptContext`.
- [ ] **Step 2:** Bridge sets `toolClaim:'none'` for drivers with `metadata.cli === true`, `'full'` otherwise.
- [ ] **Step 3:** Claude: at first spawn `spawnSession(threadId, turn)` (`claude-runtime.ts:155,217`) has `turn.system` in scope. Add `...(['--system-prompt', turn.system] when present and first spawn)` to args, store a flag on `ClaudeSession`, and **remove** the per-turn concatenation at `:234-237` when the flag was used. No temp file needed; first-turn snapshot semantics documented in a one-line comment. This environment's `claude --help` lists `--system-prompt <prompt>`; if absent in another version, fall back to concatenation.
- [ ] **Step 4:** ACP/Codex: keep concatenation with a one-line comment (no protocol system channel).
- [ ] **Step 5:** Tests: assert `## Tools Available` absent for `'none'`, framework prompt appears once (not duplicated in user text) for Claude when flag is used, and `fullAuto` still yields `--permission-mode bypassPermissions`.
- [ ] **Step 6:** Build + tests; commit explicit paths; message `feat(coordinator): CLI permission bridge and framework prompt fidelity`; update `CONTEXT.md` Phase 3 log and commit.

---

## P4 — Verification and docs
- [ ] Full hermetic gate: `HOME=/tmp/opensand-hermetic-home pnpm build && HOME=/tmp/opensand-hermetic-home pnpm test`.
- [ ] `real-cli-compat.test.ts` smoke for installed binaries; do **not** add `--system-prompt-file` to its flag list (the pinned flag is `--system-prompt`).
- [ ] Per-phase spec + quality reviews and final whole-implementation review.
- [ ] `AGENTS_LEARNING.md`, `~/commonplace/sources/2026-11-22-cli-agent-auth-framework.md`, daily memory, final `CONTEXT.md` Phase 4 status. Commit docs explicitly.

## Guardrails
- Explicit `git add <paths>`; never stage `pnpm-lock.yaml`, CI, or pre-existing untracked files.
- Do not change shim consolidated text, weaken approval gates, delete `AgentWrapper`, or push/merge.
