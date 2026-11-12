# OpenSand Desktop Shell: Monolithic View Inventory & Migration Audit

## Executive Summary & Architecture Context
- **Target Source:** `packages/desktop/renderer/app.js` (6,026 lines vanilla ECMAScript module).
- **Target Architecture:** Phase 5 Preact + TypeScript frontend bundled with Vite (per `opensand-next.md` Section 5).
- **Status:** Phase 5 Groundwork under the **Lockfile Gate** (zero dependency or lockfile changes in this phase).
- **Purpose:** Provide an exhaustive, line-by-line architectural breakdown of all UI subsystems, state machines, DOM dependencies, event handlers, and migration seams to guide the progressive componentization into Preact.

---

## 1. Architectural Section Breakdown

### 1.0 Foundations, Environment & OpenSandClient API Layer (Lines 1–728)
- **Line Range:** 1–728 (728 lines)
- **Primary Responsibility:**
  - Detect Electron host environment vs browser runtime via user-agent (`.is-electron`).
  - Provide unified `OpenSandClient` abstraction bridging native Electron IPC and local HTTP/SSE REST endpoints.
  - Implement dynamic token exchange, session storage persistence, and unconditional `window.fetch` authorization interceptor with 401 modal recovery (`AGENTS_LEARNING.md §10.1, §10.3`).
  - Provide typed API client wrapper methods for Sessions, Chat Turns, Approvals, Tools, Settings, Telemetry, Rooms, Routines, Skills, Vault, Memories, Attachments, Templates, Sentinel, Policy Boundaries, Inbound Webhooks, Agent Graphs, OAuth Connectors, and Community Gallery.
- **Key Symbols & Functions:**
  - `uiIcon(name, cls)` (L14): Inline SVG icon generator referencing symbol sprites in `index.html`.
  - `setBotAvatar(state)` (L17): Brand spark avatar animator keyed on bot activity state.
  - `OpenSandClient` (L26–728):
    - `constructor()` (L26): Reads `window.opensand` bridge or initializes fallback HTTP token and fetch interceptor.
    - `setToken(token)` (L84): Updates active authentication token in memory and `sessionStorage`.
    - `initSse()` (L108): Subscribes to Server-Sent Events at `/api/events`.
    - `dispatch(event)` (L144): Notifies registered UI event listeners.
    - `onEvent(listener)` (L154): Registers callback for streaming and lifecycle events.
    - Subsystem API client wrappers (L158–727): `sendQuery`, `cancelTurn`, `approveTool`, `listPendingApprovals`, `getSessions`, `loadSession`, `deleteSession`, `getSettings`, `updateSettings`, `getTokenTelemetry`, `getRooms`, `getRoutines`, `getSkills`, `getVaultSecrets`, `getMemories`, `getAttachments`, `getTemplates`, `getSentinelWatchers`, `getBoundaries`, `getWebhooks`, `getGraphs`, `getConnectors`, `getGalleryTemplates`.
- **State & DOM Dependencies:**
  - Window globals: `window.opensand`, `window.__OPENSAND_AUTH_TOKEN__`, `sessionStorage.opensand_token`.
  - Global DOM: `document.body.classList.add('is-electron')`, `#botStatusAvatar`.
- **Failure Modes & Traps:**
  - Token desynchronization between tabs if updated outside the active instance.
  - SSE reconnection backoff must not flood the server on restart.
- **OSP Target Equivalent:** Replaced by typed OSP client in `packages/protocol` using JSON lines over bidirectional transport.

---

### 1.1 Navigation & Session Sidebar (Lines 729–1250)
- **Line Range:** 729–1250 (522 lines)
- **Primary Responsibility:**
  - Bootstrap UI controller on `DOMContentLoaded`.
  - Manage application-wide view routing (`currentView`) across 14 distinct functional panels (`viewChat`, `viewRooms`, `viewRoutines`, `viewSkills`, `viewVault`, `viewMemories`, `viewAttachments`, `viewTemplates`, `viewGallery`, `viewSentinel`, `viewGraphs`, `viewBoundaries`, `viewWebhooks`, `viewConnectors`).
  - Manage primary destinations footer navigation (`Bots`, `Capabilities`, `Connections`) and account popup menu (`Settings`, `Admin/Sentinel`, `Theme`, `Clear History`).
  - Manage Session list rendering, active session selection, unread badges, and session search filtering.
  - Manage Turn Busy state machine (`setTurnBusy`), queue indicator, and hard abort/reset (`forceResetTurnState`).
  - Theme switching (dark / light mode with localStorage caching) and collapsible sidebar toggle with traffic-light clearance adjustments.
- **Key Symbols & Functions:**
  - `switchView(viewName)` (L770): Shows requested view panel, updates topbar title, and triggers panel-specific refresher.
  - `setSessionLabel(title)` (L875): Updates session title in header and active list item.
  - `showAuthModal()` / `hideAuthModal()` / `handleAuthSubmit()` (L955–970): Manages token challenge dialog on 401 responses.
  - `persistSession(id)` / `persistAgent(id)` (L1165–1172): Caches active session and agent to `localStorage`.
  - `setTurnBusy(busy)` (L1188): Manages UI locking, prompt textarea disabled state, stop button visibility, and thinking shimmer.
  - `updateQueueIndicator(count)` (L1200): Displays queued query depth.
  - `forceResetTurnState()` (L1210): Recovers UI from stuck/deadlocked turns.
  - `initTheme()` (L1232): Restores or toggles light/dark themes.
- **State & DOM Dependencies:**
  - State: `currentSessionId`, `activeAgentId`, `isTurnBusy`, `currentView`, `userScrolledUp`.
  - Elements: `#sessionList`, `#conversationSearchInput`, `#btnNewSession`, `#btnCollapseSidebar`, `#btnToggleSidebar`, `#viewHeaderTitle`, `#authModal`, `#accountPopup`, `#accountMenuTrigger`.
- **Responsive & Layout Constraints:**
  - Collapsed sidebar transitions to 0px width (`.sidebar.collapsed`), adding `padding-left: 84px` to `.topbar` in Electron mode for macOS traffic lights.
  - Search input filters sessions in place without refetching.
- **Preact Target Component:** `<Sidebar>`, `<MissionGroup>`, `<ChatList>`, `<InboxBadge>`.

---

### 1.2 View Controllers, Data Refreshers & Telemetry Counters (Lines 1251–2400)
- **Line Range:** 1251–2400 (1,150 lines)
- **Primary Responsibility:**
  - Populate and synchronize administrative panels: Bots, Tasks, Sessions, Rooms, Routines, Skills, Vault, Memories, Attachments, Templates, and Community Gallery.
  - Context window utilization tracking: Format token counts, calculate percentage utilization against model context limit, and update context meter progress bar.
  - Manage bot detail inspector panel (`#detailPanel`) with model parameters, system prompt preview, and tools whitelist.
  - Community Agent Store & Template Gallery: Filter by category (Engineering, Writing, Security, Data, Automation), search by keywords, open preview modal, and install templates.
- **Key Symbols & Functions:**
  - `toggleSidebar()` / `initSidebarCollapse()` (L1259–1271): Toggles sidebar collapse state and persists preference.
  - `toggleDetailPanel()` / `refreshDetailPanel()` (L1304–1331): Slides in bot detail pane.
  - `formatTokenCount(n)` / `formatPercentage(p)` (L1500–1513): Humanizes token counts (e.g. `12.4k`).
  - `updateTokenDisplay(used, total)` / `refreshTokenBadge()` (L1522–1581): Animates token badge and context progress bar.
  - Refreshers: `refreshBots` (L1613), `refreshTasks` (L1673), `refreshSessions` (L1714), `refreshRooms` (L1794), `refreshRoutines` (L1848), `refreshSkills` (L1918), `refreshVault` (L1963), `refreshMemories` (L2032), `refreshAttachments` (L2099), `refreshTemplates` (L2141), `refreshGallery` (L2225).
  - `openTemplatePreviewModal(template)` (L2315): Renders full template manifest preview.
- **State & DOM Dependencies:**
  - Elements: `#badgeTokens`, `#contextMeterProgress`, `#detailPanel`, `#sessionList`, `#botList`, `#roomsContainer`, `#routinesContainer`, `#skillsContainer`, `#vaultContainer`, `#galleryGrid`.
- **Preact Target Component:** `<InspectorPane>`, `<BudgetMeter>`, `<ModelRoles>`, `<TemplateStoreModal>`.

---

### 1.3 Security Sentinel, Policy Boundaries & Modal Setup (Lines 2401–3200)
- **Line Range:** 2401–3200 (800 lines)
- **Primary Responsibility:**
  - Workspace Sentinel & Self-Healing: Display autonomous tripwire monitoring rules, trigger manual heal cycles, and stream security audit events.
  - Agent Graphs & Cyclical Loops: Render autonomous graph definitions, visualize execution status, and trigger graph runs.
  - Policy Boundaries: Render fail-closed security rules (path restrictions, forbidden commands, tool whitelists), audit log history, and preset application.
  - Inbound Webhooks: Manage external webhook triggers, secret rotation, and payload delivery logs.
  - 3rd-Party OAuth Connectors: Manage Slack, GitHub App, Linear integrations, token configuration, and credential testing.
  - Modal dialog controllers for creation flows (Create Bot, Create Task, Create Room, Convene Discussion, Create Routine, Create Skill, Add Secret, Add Credential, Add Memory).
- **Key Symbols & Functions:**
  - `refreshSentinel()` / `renderSentinelLogEntry(entry)` (L2531–2585): Streams self-healing audit log entries.
  - `refreshGraphs()` / `runGraphExecution(id)` (L2616–2651): Dispatches cyclical multi-agent graph runs.
  - `refreshBoundaries()` (L2722): Loads active fail-closed security policies.
  - `refreshWebhooks()` (L2794): Lists active inbound webhook listeners.
  - `refreshConnectors()` / `openConfigureConnectorModal(type)` (L2872–3011): Configures external integration credentials.
  - Modal bindings (L3028–3200): Event listeners for opening/closing modals and submitting form payloads.
- **State & DOM Dependencies:**
  - Elements: `#sentinelWatchersList`, `#sentinelAuditLog`, `#graphsContainer`, `#boundariesList`, `#webhooksContainer`, `#connectorsContainer`, modal overlays.
- **Preact Target Component:** `<SecuritySentinelView>`, `<GraphRunnerView>`, `<BoundariesView>`, `<ModalsContainer>`.

---

### 1.4 Chat Interaction, Tool Cards, Subagents & Session History (Lines 3201–4100)
- **Line Range:** 3201–4100 (900 lines)
- **Primary Responsibility:**
  - Format, render, and update interactive tool call cards during streaming execution.
  - Map tool names to semantic icons, titles, and collapsed parameter summaries.
  - Group successive or concurrent tool calls into collapsible container cards with duration badges and exit code status.
  - Smart scroll hygiene: Track whether user has scrolled up to inspect history; suppress auto-scroll when user is reading past turns, but snap to bottom when at bottom or on new user submission.
  - Subagent activity cards: Render live subagent hierarchy for `delegate_to_agent`, nesting execution status, thinking indicators, and tool invocations.
  - Thought process blocks: Render collapsible reasoning / chain-of-thought accordion with live elapsed timers.
  - Session history reconstruction: Parse raw transcripts or structured JSON messages into formatted user turns, assistant responses, markdown text, tool cards, and approval requests.
- **Key Symbols & Functions:**
  - `inferToolIcon(toolName)` (L3228): Maps tool names (`read_file`, `run_command`, etc.) to icon symbols.
  - `formatToolName(name)` / `extractToolDetail(name, input)` (L3239–3246): Formats friendly card titles and summaries.
  - `formatToolOutputPayload(output)` (L3271): Truncates or formats command outputs and diffs.
  - `createToolLineElement(tool)` / `updateToolLineStatus(el, status, output)` (L3281–3339): Renders individual tool card item.
  - `createToolGroupElement()` (L3414): Renders container for sequential tool executions.
  - `isUserScrolledUp()` / `smartScrollToBottom(force)` (L3741–3746): Viewport hygiene controller.
  - `getOrCreateSubagentCard(subagentId, role)` / `handleSubagentEvent(ev)` (L3784–3837): Subagent hierarchy renderer.
  - `renderThoughtBlock(thoughtText, isStreaming)` (L3902): Collapsible reasoning renderer.
  - `reconstructDialogueTurns(messages)` (L3967): Replays session history into DOM.
  - `selectSession(sessionId)` (L4092): Loads session, sets active sidebar indicator, and reconstructs message feed.
- **State & DOM Dependencies:**
  - State: `activeToolGroups`, `subagentCardsMap`, `userScrolledUp`, `currentSessionId`.
  - Elements: `#messageFeed`, `#chatContainer`, `#btnScrollBottom`, `#welcomeBanner`.
- **Preact Target Component:** `<ChatView>`, `<TimelineView>`, `<ToolCard>`, `<ToolGroup>`, `<SubagentCard>`, `<ThoughtAccordion>`.

---

### 1.5 Session Lifecycle, Attachments, Popovers & Query Submission (Lines 4101–4800)
- **Line Range:** 4101–4800 (700 lines)
- **Primary Responsibility:**
  - Session creation (`startNewSession`) and switching.
  - Message rendering (`appendMessage`) for user, assistant, system, and error turns with markdown formatting and code highlighting.
  - Staged context attachments strip: Preview images and file chips, display file sizes, remove staged items, and upload files via hidden file input or drag-and-drop.
  - Voice dictation via Web Speech API (`webkitSpeechRecognition`): Speech-to-text transcription, mic pulse animation, and transcription appending.
  - Autocomplete trigger popover: Detect `/` (slash commands / skills), `@` (bots / subagents), and `#` (workspace files); render interactive suggestion popover with keyboard navigation (Up, Down, Enter, Tab, Escape).
  - Query submission (`submitQuery`): Validate input, attach staged context, clear input textarea, dispatch user turn to backend, and lock UI via `setTurnBusy(true)`.
- **Key Symbols & Functions:**
  - `startNewSession(agentId)` (L4126): Creates new session, clears message feed, and displays welcome hero.
  - `appendMessage(role, text, options)` (L4202): Appends formatted bubble to feed.
  - `renderAttachmentStrip()` / `addFileToStaged(file)` (L4339–4392): Manages staged context files.
  - Voice dictation bindings (L4468–4535): Starts/stops Web Speech recognition.
  - Trigger popover controller (L4540–4780):
    - `updateTriggerSuggestions(query, type)` (L4555)
    - `renderTriggerPopover(items, selectedIndex)` (L4668)
    - `hideTriggerPopover()` (L4700)
    - `selectTriggerItem(item)` (L4710)
  - `submitQuery()` (L4790): Assembles payload, appends user bubble, and initiates turn loop.
- **State & DOM Dependencies:**
  - State: `stagedAttachments`, `triggerState`, `isDictating`.
  - Elements: `#promptInput`, `#triggerPopover`, `#attachmentStrip`, `#btnStageFile`, `#btnDictate`, `#fileAttachmentInput`.
- **Preact Target Component:** `<PromptComposer>`, `<AttachmentStrip>`, `<TriggerPopover>`, `<VoiceDictationButton>`.

---

### 1.6 Streaming Turn Execution, SSE/IPC Dispatch & Approval Flow (Lines 4801–5400)
- **Line Range:** 4801–5400 (600 lines)
- **Primary Responsibility:**
  - Asynchronous turn execution engine: Handle streaming response chunks (`token`, `thought`, `tool_call`, `tool_result`, `approval_request`, `turn_complete`, `error`).
  - Listen to backend events via both native Electron IPC (`window.opensand.onEvent`) and SSE (`client.onEvent`).
  - Approval Queue: Render human-in-the-loop decision cards, permission risk badges (low, medium, high, critical), command diff preview, and approval action buttons (Allow Once, Always Allow, Deny).
  - Approval Modal: Display modal overlay when consequential or dangerous tool actions require interactive confirmation.
  - Turn completion & error hygiene: Guarantee `setTurnBusy(false)` is executed regardless of HTTP errors, 401s, or network aborts (`AGENTS_LEARNING.md §10.1`).
- **Key Symbols & Functions:**
  - Turn execution event listener (L4801–5300):
    - On `token`: Streams markdown tokens into assistant bubble.
    - On `thought`: Streams reasoning tokens into thought accordion.
    - On `tool_call`: Instantiates or updates tool card.
    - On `tool_result`: Updates tool card status with execution output.
    - On `approval_request`: Invokes `renderApprovalQueue`.
    - On `turn_complete`: Resets turn busy state, updates token telemetry.
    - On `error`: Formats error card, recovers UI state.
  - `renderApprovalQueue(approvals)` (L5307): Renders pending approval items with risk badges.
  - Approval modal actions (L5390–5405): Dispatches approval or rejection decisions back to coordinator.
- **State & DOM Dependencies:**
  - State: `currentStreamingMessageEl`, `currentThoughtBlock`, `pendingApprovalsList`.
  - Elements: `#approvalModal`, `#approvalQueueContainer`, `#btnApproveTool`, `#btnRejectTool`.
- **Preact Target Component:** `<ApprovalQueue>`, `<ApprovalModal>`, `<StreamingMessageRenderer>`.

---

### 1.7 Settings, Auxiliary Modals, Connectors & Bootstrap Lifecycle (Lines 5401–6026)
- **Line Range:** 5401–6026 (626 lines)
- **Primary Responsibility:**
  - Model suggestions and provider configuration: Dynamic endpoints, API key fields, default provider selection (OpenAI, Anthropic, OpenRouter, Ollama local), model hints and context window limits.
  - Settings Modal: Load and save global coordinator settings, invalidate server cache on update (`AGENTS_LEARNING.md §11.2`).
  - Auxiliary Modals & Workflows:
    - BTW Side Question Modal (`#btwModal`): Ephemeral side-query without dirtying primary session context.
    - Rollback Conversation Modal (`#rollbackModal`): Truncate turns back to prior snapshot.
    - Compaction Modal (`#compactModal`): Compact chat history using summary model.
    - Attachments Stage Modal (`#stageAttachmentModal`): Inspect and prune workspace context files.
    - Template Export/Import Modals (`#exportTemplateModal`, `#importTemplateModal`): Share bot personas.
    - Sentinel Watcher Creation Modal (`#createWatcherModal`).
    - Policy Boundary Rule Creation Modal (`#createRuleModal`).
    - Webhook Modal (`#createWebhookModal`).
    - Connector Configuration Modal (`#configureConnectorModal`).
  - Application Bootstrap Sequence (L5980–6026):
    - Initialize theme.
    - Run unauthenticated probe; display Auth Modal on 401.
    - Hydrate Settings, Bots, Tasks, and Sessions.
    - Restore persisted session ID from `localStorage` if still present on server.
    - Clear turn busy state and hydrate token telemetry badge.
- **Key Symbols & Functions:**
  - `populateModelSuggestions(provider, endpoint)` (L5484): Populates model dropdown options.
  - `updateModelHint(modelId)` (L5509): Displays context window size and pricing hint.
  - Modal event bindings (L5603–5975): Wire up open/close triggers for BTW, Rollback, Compact, Watchers, Boundaries, Webhooks, and Connectors.
  - Bootstrap execution (L5980–6026).
- **Preact Target Component:** `<SettingsModal>`, `<BtwModal>`, `<RollbackModal>`, `<CompactModal>`, `<ShellBootstrap>`.

---

## 2. Cross-Cutting Concerns & Invariant Matrix

| Concern | Monolithic app.js Behavior | Preact / OSP Target Architecture |
|---|---|---|
| **Traffic Light Clearance** | `body.is-electron .sidebar { padding-top: 38px; }` | CSS property in shell container with platform detection hook. |
| **Viewport Overflow** | Constrained to `scrollWidth <= innerWidth` at 960×740 | Flexbox/CSS Grid shell without fixed min-width overflow. |
| **Turn Deadlock Prevention** | `setTurnBusy(false)` in finally / error handlers | Signal-based mission state machine driven by OSP event log. |
| **Settings Invalidation** | Client calls `client.updateSettings()` | Settings write emits OSP event; coordinator invalidates client cache. |
| **Token Authentication** | Intercepts `fetch`, attaches Bearer, prompts on 401 | Secure HttpOnly cookie or OSP handshake challenge. |
| **History Reconstruction** | Parses DOM elements from transcript | Hydrates Preact component tree directly from OSP event log. |

---

## 3. Migration Seam Recommendations
1. **Seam 1 — Shell Frame & Navigation:** Replace `<aside class="sidebar">`, topbar, and view switching with `<ShellApp>` and `<Sidebar>`.
2. **Seam 2 — Mission Center & Timeline:** Replace `#viewChat` with `<MissionCenter>`, `<TimelineView>`, and `<ChatView>`.
3. **Seam 3 — Inspector & Budget:** Replace `#detailPanel` and token counters with `<InspectorPane>` and `<BudgetMeter>`.
4. **Seam 4 — Decision Queue:** Replace `#approvalModal` and inline approval cards with `<ApprovalQueue>`.
5. **Seam 5 — Modals & Settings:** Replace monolithic modal overlays with standalone Preact dialog components.
