# Phase 5 view inventory: what `app.js` still serves

Status of Phase 5 in `opensand-next.md` §6.2 ("New shell"): replace the legacy
renderer `packages/desktop/renderer/app.js`, then delete it.

- **Baseline:** `origin/main` at `55d1f1f`. `renderer/app.js` is **6,041 lines**.
  Line ranges below are from that commit. Re-check them with `grep -n` before
  moving code, because they shift when `app.js` changes.
- **Shell:** the Preact renderer in `packages/desktop/renderer-next/src/`, served
  only with `OPENSAND_RENDERER=preact` (`src/desktop-server.ts`
  `resolveRendererDir`). Its entry is `Shell.tsx`; it renders the sidebar and
  main panel only, and says "Views are not ported yet" for everything else.
- **Migration order:** the numbered rows are the order the Phase 5 PRs follow.
  Row 1 (quick tools) goes first, as the brief asks. Rows 2 to 29 follow the
  order of the `app.js` sections, with the chat turn path (rows 2 to 7) before
  the other views, because the quick window and the chat depend on it.
- **Status values:** `none` = no shell equivalent; `partial` = the shell has a
  component for part of the behaviour (what is missing is listed);
  `done` = fully replaced and tested. Nothing is `done` yet except the
  mission/timeline/receipt views, which never existed in `app.js`.

## Already in the shell (not served by `app.js`)

These are Phase 5 views that do not come from `app.js` and need no move:
`MissionList`, `MissionTimeline`, `MissionDiff`, `MissionReceipt`,
`ForkDialog`, `RestoreDialog`. They are covered by the real-window tests
`fork-real-window.test.ts` and `restore-real-window.test.ts`.

## Remaining in `app.js`

| # | Feature | `app.js` lines | `index.html` | Shell component that replaces it | Status | What is missing |
|---|---|---|---|---|---|---|
| 1 | **Quick tools: Capture window** (`btnQuickWindow`) and Recognize screen text (`btnQuickOcr`) | element refs L1134–1137; handlers L5464–5475 | `btnQuickWindow` L161, `btnQuickOcr` L160 | none | none | Button in the topbar that sends a fixed prompt (`Call list_windows and show all open on-screen windows.`) through `submitQuery`. It needs a send path and turn events (row 2). OCR uses the same pattern with a different prompt. |
| 2 | **Chat turn: composer, send, streaming, cancel, queue** | composer and submit L4801–4893, 4915–4978, `setTurnBusy`/turn helpers L1195–1240, event stream L4994–5375, `renderMarkdownCached` L3230–3237 | `viewChat` L181–314, composer | none | none | The whole chat view. Quick window (row 1) can reuse the bridge's `sendQuery` and `onEvent`, but it has no transcript. |
| 3 | **Chat history and turn reconstruction** | L3942–4158 | `#messageFeed` | `Chat.tsx` | done | Rebuilds bubbles, thoughts and tool cards from stored turns. |
| 4 | **Tool cards, thought accordion, subagent cards, markdown, code highlight** | L3238–3506, 3794–3941, 3506–3747 (delegated actions), `modules/chat/markdown.js`, `modules/chat/highlight.js` | n/a | `Chat.tsx` | done | Tool execution cards, collapsible thought accordion, and markdown rendering. |
| 5 | **Artifact canvas** (side-by-side split view) | elements L923–951; code in `modules/chat/canvas.js` (702 lines) and `modules/chat/file-model.js` | `canvas*` elements | `Canvas.tsx` + `Shell.tsx` | done | Split view, multi-tab artifact management, open-in-canvas from tool cards and code blocks, line numbers, and preview toggle. |
| 6 | **Detail inspector** (slide-out panel, session actions) | L1314–1480 | detail panel | `Inspector.tsx` + `Shell.tsx` | done | Slide-out panel, active persona card, token telemetry gauge, cognitive memories list, granted skills chips, and session controls. |
| 7 | **Composer extras**: staged attachments, file picker, drag and drop, voice dictation, `/ @ #` autocomplete popover, quick prompt chips | L4339–4550, 4551–4914, 4979–4993 | composer | `Chat.tsx` | done | Staged attachments strip, file picker, drag-and-drop staging, quick prompt chips, and slash command autocomplete popover. |
| 8 | **Approvals**: approval queue and approve/reject | L952–959, 5376–5406; `modules/chat/approval-queue.js` | `approvalModal` L771 | `Inbox.tsx` + `Shell.tsx` approval detail | done | Interactive approval queue in sidebar Inbox and main detail view with native Approve Once, Always Allow, and Reject actions, epoch mismatch handling, and real Electron window tests at 960x740 and 1920x1080. |
| 9 | **Sessions list and navigation** (search, active session, delete, unread badges, session switch) | sidebar L729–1250, refresh L1481–1803 | `#sessionList` | `ChatList.tsx` + `Shell.tsx` | done | Interactive session list with real-time search filtering, empty states, session switching, chat view transcript hydration, `#activeSessionTitle` updates, unread badges with click-to-clear, localStorage active session persistence across reload, brand reset, deletion handling, and real Electron window tests at 960x740 and 1920x1080. |
| 10 | **Navigation footer and view switching** (`switchView`, subnav tabs, `?view=` / `#hash` deep links) | L743–873, L781 | footer nav, `.subnav-tab` | `navigation-model.ts` + `Shell.tsx` | done | View registry, footer nav (Bots, Capabilities, Connections), per-group subnav tabs, header titles, back-to-chat, `?view=` and `#hash` deep links, and all 15 view panels (chat live, the rest stubs ready for rows 13–26, including the Settings target for Row 11). Tested by `navigation-model.test.ts` and `navigation-real-window.test.ts` at 960x740 and 1920x1080. |
| 11 | **Account menu, theme, sidebar collapse, shortcuts** (Cmd+B, Cmd+I, Cmd+Shift+A, Esc) | L1241–1313, 4159–4338, 4888–4914 | account popup, theme toggle | `account-model.ts` + `Shell.tsx` + `shell.css` | done | Dark/light theme toggle (`#btnToggleTheme`, `#btnMenuToggleTheme`, `data-theme`, `opensand-theme`), sidebar collapse (`#btnCollapseSidebar`, `#btnToggleSidebar`, `.collapsed`, `opensand-sidebar-collapsed`), account popup (`#accountMenuTrigger` with outside-click and Esc dismissal, Sentinel/Settings/theme/Clear History items), and global Cmd+B / Cmd+I / Cmd+Shift+A / Esc shortcuts with topmost-layer precedence. Tested by `account-model.test.ts` and `account-shortcuts-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 12 | **Auth modal and token exchange** (401 recovery, `sessionStorage` token) | L960–1027; client L25–738 (auth interceptor, SSE) | `authModal` L795 | `auth-model.ts` + `Shell.tsx` + `shell.css` + `data.ts` | done | Auth modal (`#authModal`, `#serverAuthTokenInput`, `#authErrorMsg`, `#btnSubmitAuthToken`) opens on `opensand:auth_required` / bridge auth events; empty input validation, submitting state, server error display, Enter-key submit, token exchange via `window.opensand.authenticate` or `POST /api/auth/token-exchange` with `opensand_token` persisted in `sessionStorage`, then sessions/approvals refresh. `authenticate` and `onAuthRequired` added to `ShellData`. Tested by `auth-model.test.ts` and `auth-modal-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 13 | **Rooms** (view, creation, convene discussion) | view L1804–1857, API L364–392, creation L3041–3076, L3077–3108 | `viewRooms` L315, `createRoomModal` L878, `conveneDiscussionModal` L907 | `rooms-model.ts` + `RoomsView.tsx` + `Shell.tsx` + `data.ts` + `shell.css` | done | Room grid with empty state and formatted cards, create-room modal with roster checkboxes and name validation, convene-discussion modal with round-table feed and consensus verdict, and `getRooms`/`createRoom`/`conveneDiscussion` on `ShellData`. Tested by `rooms-model.test.ts` and `rooms-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 14 | **Routines** (view, creation) | L1858–1927, API L393–426, creation L3109–3138 | `viewRoutines` L339, `createRoutineModal` L933 | `routines-model.ts` + `RoutinesView.tsx` + `Shell.tsx` + `data.ts` + `shell.css` | done | Routine grid with empty state, status/action/trigger/next-run/run-count badges and Run Now (disabled while running), Pause/Enable and confirm-then-delete controls; New Routine modal with reset fields, interval/cron group toggling and inline validation. `getRoutines`/`createRoutine`/`setRoutineEnabled`/`triggerRoutine`/`deleteRoutine` added to `ShellData`. Tested by `routines-model.test.ts` and `routines-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 15 | **Skills** (view, creation) | L1928–1972, API L427–447, creation L3139–3162 | `viewSkills` L361, `createSkillModal` L971 | `SkillsView.tsx` + `skills-model.ts` | done | Skill grid and cards, inline-validated create modal, in-app recipe preview (replaces `alert`), delete with confirm, and bridge/HTTP data methods. Tested by `skills-model.test.ts` and `skills-real-window.test.ts` at 960x740 and 1920x1080. |
| 16 | **Vault** (view, add secret, add credential) | L1973–2041, API L448–486, creation L3163–3207 | `viewVault` L385, `addSecretModal` L998, `addCredentialModal` L1025 | `VaultView.tsx` + `vault-model.ts` + `data/vault.ts` + `shell.css` | done | Both grids and add modals, inline validation, confirm-delete and bridge/HTTP data methods. Values and previews are stripped at the data boundary; cards show a fixed `••••••••` mask. Tested by `vault-model.test.ts` and `vault-real-window.test.ts` with a canary value served by a mocked GET but never rendered, at 960x740 and 1920x1080 with zero horizontal overflow. |
| 17 | **Memories** (view, add memory) | L2042–2108, API L487–516, creation L3208–3227 | `viewMemories` L413, `addMemoryModal` L1056 | `memories-model.ts` + `MemoriesView.tsx` + `registry.ts` + `data/memories.ts` + `data.ts` + `shell.css` | done | 7-layer memory grid and team review queue with Approve and Reject actions hitting real POST /api/team-review/resolve route (fixing legacy 404 bug), inline-validated Add Memory modal with scope and tier selects, confirm-then-forget memory facts, and bridge/HTTP data methods. Tested by `memories-model.test.ts` and `memories-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 18 | **Attachments** (view, stage modal) | L2109–2150, API L517–536, `stageAttachmentModal` L5723–5751 | `viewAttachments` L438, `stageAttachmentModal` L1244 | `AttachmentsView.tsx` + `attachments-model.ts` + `data/attachments.ts` + `registry.ts` + `data.ts` + `shell.css` | done | Legacy card grid and stage modal: inline path validation, confirm-unstage, bridge/HTTP data methods with both legacy and real bridge field names, and Esc/close dismissal. Tested by `attachments-model.test.ts` and `attachments-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 19 | **Bots and templates** (view, export, import, create bot, create task) | L2151–2219, API L537–551, export/import L5752–5807, bot modal L5407–5431, task modal L5432–5448 | `viewTemplates` L464, `createBotModal` L819, `createTaskModal` L850, `exportTemplateModal` L1263, `importTemplateModal` L1287 | `BotsView.tsx` + `bots-model.ts` + `registry.ts` + `data/bots.ts` + `data.ts` + `shell.css` | done | Autonomous bot persona roster with default assistant, workspace task list with priority badges, and template generation cards grid with export and delete actions. Modals for Create Bot with validation and Esc close, Add Task, Export Template with copy-to-clipboard, and Import Template with JSON parse validation. Tested by `bots-model.test.ts` and `bots-real-window.test.ts` at 960x740 and 1920x1080 with zero horizontal overflow. |
| 20 | **Community gallery and template preview/publish** | L2220–2540, API L705–738 | `viewGallery` L499, `templatePreviewModal` L1445, `publishTemplateModal` L1486 | none | none | |
| 21 | **Sentinel watchers** (view, create watcher) | L2564–2658, API L580–605, `createWatcherModal` L5861–5898 | `viewSentinel` L538, `createWatcherModal` L1306 | `sentinel-model.ts` + `SentinelView.tsx` + `data/sentinel.ts` + `shell.css` | done | Watcher grid with auto-heal/passive badges, target/check/debounce details and confirm-then-stop; diagnostic feed with proposal and output boxes; live `sentinel` turn events appended to the feed; inline-validated Create Watcher modal (required target directory, default auto-heal and 500 ms debounce) with submitting state and Esc/close dismissal. Bridge/HTTP data methods. Tested by `sentinel-model.test.ts` and `sentinel-real-window.test.ts` at 960×740 and 1920×1080 with zero horizontal overflow. |
| 22 | **Agent graphs** (view) | L2626–2731, API L656–670 | `viewGraphs` L561 | `graphs-model.ts` + `GraphsView.tsx` + `data/graphs.ts` + `shell.css` | done | Graph grid with node badges, cycle-limit badge and Run Graph / Run Coding Graph actions; execution trace with running, empty, error, step/event and final-summary states, disabled buttons while a run is in flight, and bridge/HTTP data methods. Tested by `graphs-model.test.ts` and `graphs-real-window.test.ts` at 960×740 and 1920×1080 with zero horizontal overflow. |
| 23 | **Boundaries** (view, create rule) | L2762–2835, API L607–630, `createRuleModal` L5898–5947 | `viewBoundaries` L592, `createRuleModal` L1337 | `boundaries-model.ts` + `BoundariesView.tsx` + `data/boundaries.ts` + `shell.css` | done | Policy grid with action badges and tools/regex/path details, confirm-then-delete, paginated audit feed with decision/reason/args-summary, and inline-validated Create Rule modal (required name, action select, parsed tool/path lists) with submitting state and Esc/close dismissal. Bridge/HTTP data methods. Tested by `boundaries-model.test.ts` and `boundaries-real-window.test.ts` at 960×740 and 1920×1080 with zero horizontal overflow. |
| 24 | **Webhooks** (view, create webhook) | L2804–2881, API L631–655, `createWebhookModal` L5895–5937 | `viewWebhooks` L623, `createWebhookModal` L1380 | none | none | |
| 25 | **OAuth connectors** (view, configure) | L2923–3066, API L672–702, `configureConnectorModal` L5990–6032 | `viewConnectors` L654, `configureConnectorModal` L1419 | `connectors-model.ts` + `ConnectorsView.tsx` + `data/connectors.ts` + `shell.css` | done | Connector cards with connected/connecting/disconnected states, sanitised brand colour, scope pills and account/date line; OAuth connect with 60 s bounded polling of `getConnector`, inline test results, confirm-then-disconnect; Configure modal with provider hints, required token validation and a token field cleared on save. Bridge/HTTP data methods. Tested by `connectors-model.test.ts` and `connectors-real-window.test.ts` at 960×740 and 1920×1080 with zero horizontal overflow. |
| 26 | **Settings** (model suggestions, save, invalidate cache) | L5476–5599, 1138–1150 | `settingsModal` L1112 | none | none | |
| 27 | **Learned rules** | L1126–1133, 5449–5463 | `learnedRulesModal` L1092 | none | none | |
| 28 | **BTW side question, rollback, compact** | BTW L552–579 and L5600–5640; rollback L5641–5681; compact L5682–5722 | `btwModal` L1160, `rollbackModal` L1187, `compactModal` L1216 | none | none | |
| 29 | **Boot sequence** (theme, probe, hydrate bots/tasks/sessions, restore session) | L6031–6094, state L1151–1194 | n/a | `boot-model.ts` + `Shell.tsx` | done | Ordered boot phases (auth probe, agents, sessions, restore, ready) with an observable `data-boot-status`/`data-boot-phase` on the app root; HTTP-only 401 probe, persisted active-agent and session validation against live lists with stale-key cleanup, theme applied from storage, and approvals hydrated by the Inbox. Tested by `boot-model.test.ts` and `boot-real-window.test.ts` at 960×740 and 1920×1080 with zero horizontal overflow. |

## Files that go with `app.js` (delete in the final PR)

- `packages/desktop/renderer/app.js` (6,041 lines).
- `packages/desktop/renderer/modules/` (`chat/canvas.js`, `chat/markdown.js`,
  `chat/highlight.js`, `chat/file-model.js`, `chat/approval-queue.js`). `app.js`
  L5–8 imports four of them; `highlight.js` is imported by `canvas.js` and
  `markdown.js`. Nothing in `renderer-next/` imports them. Confirm this again
  before deleting. `modules/chat/README.md` describes how to wire them in and
  must be updated or removed with them.
- The `app.js` references in `renderer/index.html` (the `<script>` tag and the
  panel markup) and `renderer/styles.css` (rules for the legacy views).
- Not in scope: `renderer/welcome.html` and `welcome.js` (a separate page).

## Deletion gate

`app.js` is deleted only when every row above is `done` and the desktop test
suite passes. Until then, `OPENSAND_RENDERER` unset (the default) keeps serving
`app.js`, so no user loses a view while the shell catches up.

## Test requirement

Each moved view needs a real-window test (Electron, real `BrowserWindow`) at
**960×740** and at **full screen** (`1920×1080` in the existing harness). A
test that renders the component in jsdom or a fake window does not count.
