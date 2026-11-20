# Provider parity plan (2026-11-20)

Reference: OpenMausBot `server/drivers/builtIn.ts` — 26 built-in drivers.
Baseline: OpenSand had 6 drivers, 5 of them copy-paste stubs, 6 broken tests, no production call path.

Parity scorecard (each dimension 0–100%):
1. **Driver coverage** — count of registered drivers vs the 26 reference kinds.
2. **Protocol fidelity** — handshake, transport, completion, permissions, timeouts (verified by fake-CLI tests).
3. **Test coverage** — every registered driver has config/metadata/instance tests; at least one fake-CLI protocol test per runtime family.
4. **Production reachability** — a user-selectable path that actually instantiates the driver; no `export *` dead code.
5. **Verification** — full build + full test + live dev app smoke.

## Phases

| Phase | Work | Depends on | Done when |
|---|---|---|---|
| 1 | Structural seams: widen coordinator to an LLM-stream interface; generic `defineAcpDriver` / `defineApiDriver` factories; CLI-driver text shim so every registered driver is callable from the app | baseline (done) | build green; existing 252 coordinator tests pass |
| 2 | Port the remaining OpenMausBot drivers as thin config modules using the factories (ACP family + API-key family) | Phase 1 | 26+ registered drivers; each has a config test |
| 3 | Production reachability: `GET /api/providers`, provider selection in settings, registry-backed client creation for every driver kind | Phase 1, 2 | a selected driver can be created through the app's own code path; covered by a test |
| 4 | Protocol-fidelity tests for each runtime family (fake CLI / mock HTTP), including permissions and resume | Phase 2 | all families covered; no test weaker than a contract assertion |
| 5 | Full verification and local commit; restart dev app on the final build | Phase 3, 4 | `pnpm build` + `pnpm test` green; pre-commit hook passes; app HTTP 200 |

## Residual pass (2026-11-20, second session)

- **Device/browser auth:** generic `device-auth.ts` controller (bounded flows, allowlisted URLs/codes, per-instance home, safe messages), wired into Grok/Kimi/Copilot ACP drivers; `ProviderAuthentication*` types widened for flow metadata. Real provider client IDs/tokens remain operator-supplied.
- **Managed installers:** pinned single-file installer (`sha256` + byte size + host allowlist + smoke test + atomic publish), exposed as `POST /api/runtimes/install`. No archive format is supported yet (no new dependency without approval).
- **Dynamic catalogs:** ACP reads `session/new` configOptions, Codex calls `model/list`, API drivers fetch `/models`; all fall back to the static catalog with `modelsUnconfirmed = true`.
- **Tool calls in CLI turns:** corrected finding — OpenMausBot does **not** execute agent tools inside CLI turns either (ACP/Codex/Claude CLIs run their own tools; the harness only answers permission requests and emits tool events). OpenSand does the same: tool/permission events are emitted and permissions are answered fail-closed. There is no external tool-result injection wire in either codebase.
- **Real binaries:** installed `claude 2.1.311`, `codex 0.166.0`, `opencode 2.0.20`, `agy 1.5.11` were probed; all flags OpenSand spawns are accepted. A test skips when a binary is absent and otherwise asserts flag acceptance plus the version regex.

## Remaining risk
- OAuth needs real provider credentials/endpoints; installer has no archive support; CLI drivers stay text-only in the app's HTTP tool loop (as in the reference).
