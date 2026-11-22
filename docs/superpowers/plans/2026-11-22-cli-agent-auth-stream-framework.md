# CLI Agent Auth and Framework Fidelity Implementation Plan

> For agentic workers: use subagent-driven-development. Steps use `- [ ]`.

**Goal:** CLI agents sign in once into a stable credential home, every turn sees it, sign-in state is observable, permission requests are answered, and the OpenSand framework prompt is delivered honestly.

**Spec:** `docs/superpowers/specs/2026-11-22-cli-agent-auth-stream-framework-design.md`
**Baseline:** `e7c41d4`, branch `feat/agent-settings-ui`. Context phase log: `CONTEXT.md` section 7.

---

## P1 — Auth core

### Task 1: failing tests
**Files:** `packages/coordinator/test/device-auth.test.ts`, `packages/desktop/test/ipc-bridge.test.ts` (or a new `provider-auth.test.ts` extension)

- [ ] **Step 1:** In `device-auth.test.ts`, extend the fake-CLI helper so `loginArgs` writes a non-empty `auth.json` into the directory named by the `homeEnv` variable, then assert:
```ts
const flow = await controller.start();
await waitForStatus(controller, flow.flowId!, 'authorized');
assert.strictEqual(await controller.isSignedIn(), true);
```
Build the wait helper with polling bounded by 5 s (the fake CLI exits immediately).
- [ ] **Step 2:** Add a test that a second controller for the same spec/instance kind sees `isSignedIn() === true` immediately (stable home, not per-instance digest).
- [ ] **Step 3:** Run `pnpm --filter @opensand/coordinator run build && pnpm --filter @opensand/coordinator test`. New tests must FAIL (no `isSignedIn`, no authorized).

### Task 2: device-auth seam
**Files:** `packages/coordinator/src/providers/runtime/device-auth.ts`, `packages/shared/src/types.ts`, `packages/coordinator/src/providers/runtime/acp-runtime.ts`, `packages/coordinator/src/provider-auth.ts`

- [ ] **Step 1:** Add and export:
```ts
export function credentialHome(spec: DeviceAuthSpec): string {
  return path.join(os.homedir(), '.opensand', 'providers', spec.provider, spec.homeDir.replace(/^\./, ''));
}
export function credentialEnv(spec: DeviceAuthSpec, environment: Record<string, string>): Record<string, string> {
  return { ...environment, [spec.homeEnv]: credentialHome(spec) };
}
```
Remove the `createHash`/instanceId digest from the home path (keep `randomUUID` for flow ids).
- [ ] **Step 2:** In `createDeviceAuthController` use `credentialEnv(spec, environment)` as `env`. Add `lastStatus` to closure; `finish(status)` stores it before nulling `flow`; `get(flowId)` returns `lastStatus` when its `flowId` matches. Add `isSignedIn: async () => isSignedIn()` to `DeviceAuthController` (`device-auth.ts:47-53`).
- [ ] **Step 3:** On login child `exit` in `run()` (`device-auth.ts:125-128`), if this was the login flow, re-check `isSignedIn()` and `finish({status:'authorized', flowId:id, ...})` when true, else `failed` with `spec.failureMessage`; allow a later successful exit to overwrite an earlier timeout `failed`.
- [ ] **Step 4:** `shared/src/types.ts`: add `isSignedIn?: () => Promise<boolean>` to `ProviderInstance` (:511-534). In `acp-runtime.ts` instance authentication block (:304-313) add `isSignedIn: () => controller.isSignedIn()` — use the controller variable already created at :72-74.
- [ ] **Step 5:** `provider-auth.ts`: replace `auth:${kind}:${randomUUID()}` with `auth:${kind}`; add `getProviderAuthState(kind)` returning `{signedIn: boolean, flowId: string|null}` using `ensureSession()` and `instance.isSignedIn?.() ?? false`.
- [ ] **Step 6:** `acp-runtime.ts:136`: `const env = options.auth ? credentialEnv(options.auth, { ...process.env, ...input.environment }) : { ...process.env, ...input.environment };`
- [ ] **Step 7:** Run build + tests; green. Commit explicit paths; message `fix(auth): stable CLI credential home and observable sign-in`; append `CONTEXT.md` section 7 Phase 1 log and commit it.

---

## P2 — Auth API and UI

### Task 3: driver-derived capability
**Files:** `shared/src/types.ts`, `packages/coordinator/src/providers/factories/acp-driver.ts`, `packages/coordinator/src/provider-auth.ts`, `packages/desktop/src/desktop-server.ts`, renderer `app.js` / `model-picker.js`, tests

- [ ] **Step 1:** Add `supportsAuthentication?: boolean` to `ProviderDriver.metadata` (`shared/src/types.ts:641-654`); `defineAcpDriver` sets it from `Boolean(spec.auth)`.
- [ ] **Step 2:** Delete hardcoded `AUTH_PROVIDER_KINDS` usage in `desktop-server.ts:1438`; derive `auth: providerRegistry.getDriver(kind)?.metadata.supportsAuthentication === true`.
- [ ] **Step 3:** Add `GET /api/providers/:kind/auth/state` → `getProviderAuthState(kind)`; unknown kind → 404 in the file's existing response shape.
- [ ] **Step 4:** Renderer: `refreshProviders()` reads the state per CLI provider and `model-picker.js` shows a signed-in marker / hides the sign-in hint when `signedIn`; tooltip notes sign-out clears the shared home.
- [ ] **Step 5:** Tests: state route signed-out/signed-in with fake home; harness asserts the marker and hint toggle.
- [ ] **Step 6:** Build + tests; commit explicit paths; message `feat(providers): driver-derived auth capability and state`; update `CONTEXT.md` Phase 2 log and commit.

---

## P3 — Stream + framework fidelity

### Task 4: permission round-trip
**Files:** `packages/coordinator/src/provider-llm.ts`, `packages/desktop/src/ipc-bridge.ts`, `preload.cts`, `main.ts`, tests

- [ ] **Step 1:** Extend `DriverLlmClientInput` with `onPermissionRequest?: (req: {threadId:string; requestId:string; method?:string; options?:unknown}) => Promise<{behavior:'allow'|'reject'|'answer'; always?: boolean}>`.
- [ ] **Step 2:** In `createTextStreamShim`'s `onDriverEvent`, handle `event.type === 'permission.request'`: call `onPermissionRequest` (fallback `{behavior:'reject'}` if absent), then `instance.adapter.respondToRequest(threadId, requestId, decision)`. Catch and log errors; never approve by default.
- [ ] **Step 3:** In `ipc-bridge.ts` where `createDriverLlmClient` is called (`:698-712`), supply `onPermissionRequest` that reuses the existing approval system (`emit 'approval_required'` with tool name `provider_permission` and args `{threadId,requestId,method,options}` and awaits `approveTool`'s decision). Map `approve_once` → `{behavior:'allow'}`, `always_allow` → `{behavior:'allow', always:true}`, `reject` → `{behavior:'reject'}`. No new DesktopEvent type or IPC method.
- [ ] **Step 4:** Tests: approve calls `respondToRequest` with `allow`; reject with `reject`; no response → fail-closed timeout unchanged.

### Task 5: framework prompt honesty
**Files:** `system-prompt.ts`, `coordinator.ts`, `provider-llm.ts`, `ipc-bridge.ts`, `claude-runtime.ts`, `acp-runtime.ts`, `codex-runtime.ts`, tests

- [ ] **Step 1:** Add `toolClaim?: 'full' | 'none'` to `SystemPromptContext`; `buildSystemPrompt` emits the "Tools Available" block only for `'full'` (default). Add `toolClaim` to `AgentCoordinator` options and pass into `systemPromptContext`.
- [ ] **Step 2:** Bridge sets `toolClaim:'none'` for CLI driver kinds (those with `supportsAuthentication` or a CLI runtime), `'full'` otherwise.
- [ ] **Step 3:** Claude: check `claude --help` for `--system-prompt-file`; if supported, create a temp file with the system prompt on first spawn and add the flag; otherwise keep concatenation and add a one-line comment documenting the limitation. First-turn snapshot semantics documented.
- [ ] **Step 4:** ACP/Codex: keep concatenation with a one-line comment; no protocol system channel.
- [ ] **Step 5:** Tests: framework prompt appears once as system for Claude when flag supported; `toolClaim:'none'` removes tool claims; `fullAuto` still yields `--permission-mode bypassPermissions`.
- [ ] **Step 6:** Build + tests; commit explicit paths; update `CONTEXT.md` Phase 3 log and commit.

---

## P4 — Verification and docs
- [ ] Full hermetic gate (`HOME=/tmp/opensand-hermetic-home pnpm build && pnpm test`).
- [ ] `real-cli-compat.test.ts` smoke for installed binaries; report which were unavailable.
- [ ] Per-phase spec + quality reviews and final whole-implementation review.
- [ ] `AGENTS_LEARNING.md` lesson, commonplace source note (`~/commonplace/sources/2026-11-22-cli-agent-auth-framework.md`), daily memory, final `CONTEXT.md` status.

## Guardrails
- Explicit `git add <paths>`; never stage `pnpm-lock.yaml`, CI, or pre-existing untracked files.
- Do not change shim consolidated text; do not weaken approval gates; no push/merge.
