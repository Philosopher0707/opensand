# UI parity with OpenMausBot — bot cards & per-bot provider/model selection

**Status: ACTIVE WORK PLAN (task list). Owner goal: report only at ≥90% measured parity.**
Baseline: `4c465c0`. Reference: OpenMausBot `main` (explore facts recorded in `docs/agent-delegation-communication-map.md` and this doc).
Method: `reference-parity-port` — facts with `file:line`, measured scorecard, small verified phases, one-shot ship script, live screenshot.

## Reporting rule
Every phase ends with: build + hermetic test + window-harness DOM assertions + a live screenshot. Report the parity score with evidence; never say "90%" from intent. If a dimension cannot be measured, it stays below 90 and is named.

## Scorecard (baseline → target)

| # | Dimension | Now | Gate | Evidence |
|---|---|---:|---|---|
| 1 | Per-bot provider persisted + used at turn time | 5 | 95 | `provider` on AgentRecord, runtime selects driver by bot provider, test proves child turn uses bot's provider |
| 2 | Per-bot model picker UI | 10 | 95 | reusable picker module, provider rail + model list + search + pick → persisted selection |
| 3 | Bot card information density | 15 | 95 | card shows avatar, name, role, provider badge, model badge, status dot, quick actions |
| 4 | Visual identity (logoSvg/logoColor/avatar) | 10 | 95 | default renderer renders agent avatars, consistent sprite/emoji policy |
| 5 | Catalog UX (live models, source/unconfirmed) | 20 | 95 | picker uses `/api/providers` + `/api/models`, shows `source` label + unconfirmed hint |
| 6 | Auth-aware setup hints in picker | 20 | 92 | picker shows sign-in/CLI-needed state and deep-links to existing auth flow |
| 7 | Bot settings/edit surface (default renderer) | 5 | 92 | inspector/card edit: provider, model, endpoint, role, prompt, tools, avatar via existing IPC |
| 8 | Scope: "follow global" vs per-bot override | 0 | 90 | explicit override state + one-click reset to global, count of bots using a provider |
| 9 | Aesthetic system consistency | 50 | 92 | tokens replace hardcoded rgba, one card recipe, hover/focus/motion states, theme parity |
| 10 | UI tests + live verification | 10 | 95 | window-harness tests for cards/picker/selection; screenshots before/after |

Baseline mean ≈ **14.5%**. Target ≥90% on all dimensions before reporting.

## Reference facts that drive the design
- Bot card with provider/model badge: OpenMausBot `src/components/BotModelBadge.tsx:25-41`, `Sidebar.tsx:714-844` (avatar, status dots with `ring-2 ring-panel`, hover-only ⋯ at `:899-906`).
- Per-bot provider/model picker: `ModelPicker.tsx:203-1039` (chip `605-672`, scope toggle `704-719`, auth/setup card `787-808`), provider rail `ModelPickerFull.tsx:129-187` grouped CLOUD/API/LOCAL (`:102-125`), `ModelRow` `:24-58`.
- Scope + "follow bot's model": `ModelPickerFull.tsx:60-77`; reducer `setModel` `store.tsx:1397-1404`; bot default vs thread override `currentTaskBot` `store.tsx:360-377`.
- Auth states inline: `EngineSetup.tsx:422-505` ("Sign-in required", API key, CLI install with copy-command).
- Aesthetic: semantic tokens `styles.css:142-204`, elevated-card recipe `elevated.ts:1-9`, menu recipe `menu-recipe.ts:1-34`, 150ms transitions, `motion-reduce` guards; mascot avatars `Avatar.tsx:32-47,79-123`.
- Tests: `BotModelBadge.test.ts:32-100`, `ModelPicker.dom.test.ts`, `BotSettingsDialog.*.test.ts`, `follow-bot-model.test.ts`.

## OpenSand seams to extend (already verified)
- `AgentRecord` `shared/src/types.ts:93-159` (model/endpoint/logoSvg/logoColor exist; **no provider**); `CreateAgentInput` `:161-190`; `UpdateAgentSettingsInput` `:282-291`.
- `AgentStore.create/update` spread `...updates` (`coordinator/src/agent-store.ts:303-...`) — new field persists without a migration.
- Runtime **ignores** bot provider today: `ipc-bridge.ts:649-669` uses global `settings.provider`/`apiKey` even when bot model/endpoint override (`:633-642`).
- Catalog endpoints ready: `/api/providers` `desktop-server.ts:1389-1407`, `/api/models` `:1468-1519` (source/unconfirmed from `provider-catalog.ts:23-29,88-112`). Existing global widget: `app.js:1149-1234`, `:5590-5705`.
- IPC update methods already exposed but unused by default renderer: `preload.cts:47-60`, `main.ts:215-249`, bridge `ipc-bridge.ts:1014-1073`.
- Cards: `refreshBots()` `app.js:1709-1767` (Default Assistant row + agent rows, delete only); roster CSS `styles.css:1984-2068` (dead `.bot-item-icon` vs used `.bot-icon`); inline grid override `index.html:484`.
- Default renderer has no avatar rendering; Preact preview does (`renderer-next/src/views/Avatar.tsx:19-40`) — port the idea, not the React code.

## Phases (dependencies)

```
P0 plan (done) ──► P1 data+runtime ──► P2 picker module ─┬─► P3 cards ─┐
                                                         ├─► P4 settings ┤─► P6 verify+commit ──► P7 score
                                                         └─► P5 scope/theme┘
```

- **P1 — Per-bot provider/model data + runtime (no UI).** Add `provider?` to AgentRecord/CreateAgentInput/UpdateAgentSettingsInput; widen `updateAgentSettings` bridge/REST to accept `model`,`endpoint`,`provider`,`allowedTools`; make `createSessionCoordinator` build the LLM client with bot provider (fall back to global). Tests: agent-store persists provider; bridge uses bot provider for driver client.
- **P2 — Reusable model picker module** (`renderer/modules/model-picker.js` + CSS): provider rail (Cloud/API/Local from catalog access), searchable model list from `/api/models`, source/unconfirmed hints, auth state, pick → `updateAgentSettings`, no new dependency. Vanilla JS, mounted into cards + settings + (optionally) composer chip.
- **P3 — Bot card redesign**: avatars (inline SVG/logoColor/initial tile), provider badge, model badge, status dot (data-driven `data-status`), hover actions (picker, settings, delete), CSS with tokens and 150ms transitions; remove inline grid override.
- **P4 — Bot settings inspector**: extend `detailPanel` (or a dedicated modal) with editable provider/model/endpoint/role/system prompt/allowed tools/avatar, Save → existing IPC. Keep read-only telemetry.
- **P5 — Scope + aesthetic pass**: "uses global provider" default with one-click per-bot override; bot list shows count per provider; tokenize remaining hardcoded rgba; unify card recipe; motion-reduce; theme variables.
- **P6 — Verification**: window-harness DOM tests (cards render badges; picker opens, provider switch changes model list; save persists; selection flows to sendQuery), full hermetic gate, live Electron screenshots (default cards + picker open), commit via `ship_phase.sh`.
- **P7 — Score & report**: remeasure all 10 dimensions with evidence; present only if mean ≥90; list residual gaps.

## Automation for repeated work
- `scripts/ship_phase.sh` (existing): build+test+scan+stage+commit+JSON receipt.
- **New in P6**: `scripts/capture-ui.sh` — start Electron with CDP, open a view via `Runtime.evaluate`, `Page.captureScreenshot`, copy into `.workmate-shots/`. One command, repeatable.
- Learning log after every phase: `AGENTS_LEARNING.md` (`date · what · cause · rule now`) + global `LESSONS.md`; a recurring mistake becomes a test.

## Risks
- The reference picker is deeply coupled to a global per-instance credential model and a `models.dev` catalog. Port the *UX contract* (rail, source labels, auth hints, scope) onto OpenSand's existing catalog endpoints; do not fake a models.dev clone.
- Default renderer is vanilla JS with a monolithic `app.js`; new UI must be a module with a clean mount API, initialised inside `DOMContentLoaded` (lesson 11.12).
- Per-bot provider changes must not break the global settings flow or parallel sessions (bot provider affects `createSessionCoordinator` only).
- No new dependencies; no secrets in code or screenshots.
