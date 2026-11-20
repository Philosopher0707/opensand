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

## Explicitly out of scope for 100% (tracked as residual risk)
- OAuth/device-auth flows, managed runtime installers, per-provider credential UIs.
- Dynamic model catalog probing where the driver config is static (fallback catalog is present).
- Full tool-call/MCP execution inside CLI-driver chat turns (the coordinator tool loop is API-client based; CLI drivers are text-only in that path, with their adapter API still exposing events and permissions).
