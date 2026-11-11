# OpenSand Desktop Shell: Target Preact Component Architecture & OSP Binding Map

## Executive Summary
This document specifies the target Preact + TypeScript frontend architecture for OpenSand Desktop, replacing the 6,026-line vanilla JS monolithic controller (`packages/desktop/renderer/app.js`).
This specification directly implements **Section 5 ("The desktop app")** and **Section 4 ("Architecture")** of `opensand-next.md`.

---

## 1. Target Component Hierarchy

```
<ShellApp>
  ├── <Sidebar>
  │     ├── <BrandHeader />
  │     ├── <InboxBadge count={needsYouCount} />          // ("NEEDS YOU")
  │     ├── <MissionGroup status="running" />
  │     ├── <MissionGroup status="verified" />
  │     ├── <MissionGroup status="failed" />
  │     ├── <ChatList />
  │     └── <SidebarFooterNav />
  ├── <MissionCenter>
  │     ├── <MissionHeader>
  │     │     ├── <StatusBadge status={mission.status} />
  │     │     ├── <MissionTitle editable={false} />
  │     │     └── <ViewToggle activeView={activeView} />  // [Timeline] [Chat] [Diff] [Receipt]
  │     ├── <TimelineView active={activeView === 'timeline'}>
  │     │     ├── <SnapshotNode />
  │     │     ├── <StepItem kind="tool | thought | check" />
  │     │     └── <TimelineForkActions />
  │     ├── <ChatView active={activeView === 'chat'}>
  │     │     ├── <MessageFeed />
  │     │     ├── <ApprovalBanner />
  │     │     └── <PromptComposer />
  │     ├── <DiffView active={activeView === 'diff'}>
  │     │     ├── <FileDiffList />
  │     │     └── <UnifiedDiffViewer />
  │     └── <ReceiptView active={activeView === 'receipt'}>
  │           ├── <VerificationCertificate />
  │           ├── <MutationProbeResults />
  │           └── <ExecutionBill />
  ├── <InspectorPane>
  │     ├── <PlanChecklist plan={currentPlan} />
  │     ├── <HarnessCheckStatus check={latestCheck} />
  │     ├── <BudgetMeter budget={missionBudget} />
  │     └── <ModelRoles roles={activeRoles} />
  ├── <TournamentView modal={isTournamentOpen} />          // Parallel attempt comparison
  ├── <QuickWindow />                                      // Global shortcut runner
  └── <ModalDialogs>                                      // Auth, Settings, Approvals
        ├── <ApprovalConsentModal />
        ├── <SettingsModal />
        └── <AuthChallengeModal />
```

---

## 2. Component Specifications & Prop Interfaces

### 2.1 Root Container: `<ShellApp>`
- **Role:** Top-level application layout controller. Manages window drag regions, platform detection (`.is-electron`), global keyboard shortcuts, and OSP client connection lifecycle.
- **State Ownership:**
  - `connectionState`: Signal<`'connecting' | 'connected' | 'reconnecting' | 'disconnected'`>
  - `selectedMissionId`: Signal<`string | null`>
  - `activeView`: Signal<`'timeline' | 'chat' | 'diff' | 'receipt'`>
  - `isSidebarCollapsed`: Signal<`boolean`>
- **Props:** None (root bootstrap component).
- **Layout:** Three-column flexbox container. At 960×740, sidebar collapses to 0px or compact spine, main center fills remaining width, inspector pane collapses to drawer.

```typescript
export interface ShellAppProps {
  initialMissionId?: string;
}
```

---

### 2.2 Navigation Spine: `<Sidebar>`
- **Role:** Collapsible left navigation pane hosting the priority inbox badge, missions grouped by state, and conversational chat threads.
- **Props:**
```typescript
export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeMissionId: string | null;
  onSelectMission: (missionId: string) => void;
}
```

#### `<InboxBadge>` ("NEEDS YOU")
- **Role:** Prominent triage badge anchored at the top of the sidebar. Shows count of items requiring user intervention (pending tool approvals, questions, decision forks).
- **Props:**
```typescript
export interface InboxBadgeProps {
  pendingCount: number;
  urgent: boolean;
  onSelectInbox: () => void;
}
```
- **OSP Event Binding:** Subscribes to `inbox.ApprovalRequested` and `inbox.ApprovalResolved`.

#### `<MissionGroup>`
- **Role:** Collapsible group representing missions filtered by execution lifecycle state.
- **Props:**
```typescript
export interface MissionGroupProps {
  status: 'running' | 'verified' | 'failed';
  title: string;
  missions: MissionSummary[];
  activeMissionId: string | null;
  onSelectMission: (id: string) => void;
}

export interface MissionSummary {
  id: string;
  title: string;
  status: 'running' | 'verified' | 'failed' | 'paused';
  startedAt: number;
  completedAt?: number;
  activeStep?: string;
  checkStatus?: 'pass' | 'fail' | 'running';
  totalCostUsd: number;
}
```
- **OSP Event Binding:** Subscribes to `mission.MissionStarted`, `mission.StatusChanged`, `mission.Completed`.

---

### 2.3 Main Work Area: `<MissionCenter>`
- **Role:** Center workspace displaying the active mission across four switchable views: Timeline (default), Chat, Diff, and Receipt.

#### `<MissionHeader>`
- **Role:** Mission metadata bar with status pill, mission name, and view switcher.
```typescript
export interface MissionHeaderProps {
  mission: MissionDetails;
  activeView: 'timeline' | 'chat' | 'diff' | 'receipt';
  onViewChange: (view: 'timeline' | 'chat' | 'diff' | 'receipt') => void;
}
```

#### `<TimelineView>` (Default View)
- **Role:** Interactive execution graph showing discrete chronological steps, tool calls, and snapshot checkpoints. Users can restore workspace or fork attempts directly from any step.
```typescript
export interface TimelineViewProps {
  missionId: string;
  steps: TimelineStep[];
  selectedStepId?: string;
  onSelectStep: (stepId: string) => void;
  onRestoreSnapshot: (stepId: string, snapshotId: string) => Promise<void>;
  onForkFromStep: (stepId: string) => Promise<void>;
}

export interface TimelineStep {
  id: string;
  timestamp: number;
  kind: 'start' | 'thought' | 'tool_call' | 'tool_result' | 'check' | 'snapshot';
  label: string;
  snapshotId?: string;
  exitCode?: number;
  diffSummary?: { added: number; removed: number };
  status: 'pending' | 'running' | 'success' | 'failed';
}
```
- **OSP Event Binding:** `mission.StepAppended`, `snapshot.Created`, `check.Completed`.

#### `<ChatView>`
- **Role:** Traditional conversational interface with markdown rendering, streaming assistant bubbles, interactive tool call cards, and prompt composer.
```typescript
export interface ChatViewProps {
  missionId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  onSubmit: (prompt: string, attachments?: StagedFile[]) => Promise<void>;
  onCancel: () => Promise<void>;
}
```
- **OSP Event Binding:** `chat.TokenEmitted`, `chat.TurnStarted`, `chat.TurnCompleted`.

#### `<DiffView>`
- **Role:** Side-by-side or unified file diff viewer displaying all modifications produced by the mission against the baseline snapshot.
```typescript
export interface DiffViewProps {
  missionId: string;
  filesChanged: FileDiffEntry[];
  selectedFile?: string;
  onSelectFile: (path: string) => void;
}

export interface FileDiffEntry {
  path: string;
  oldContent?: string;
  newContent?: string;
  addedLines: number;
  deletedLines: number;
}
```
- **OSP Event Binding:** `workspace.FileModified`, `mission.Completed`.

#### `<ReceiptView>`
- **Role:** Verifiable execution receipt showing test check results, exit codes, mutation probe passes, and cryptographic log verification.
```typescript
export interface ReceiptViewProps {
  receipt: MissionReceipt;
  onDownloadReceipt: () => void;
}

export interface MissionReceipt {
  missionId: string;
  verdict: 'verified' | 'failed';
  checkCommand: string;
  checkExitCode: number;
  checkDurationMs: number;
  hashChainVerified: boolean;
  costUsd: number;
  tokenCount: { prompt: number; completion: number; total: number };
  receiptSignature: string;
}
```
- **OSP Event Binding:** `receipt.Generated`.

---

### 2.4 Diagnostic Inspector: `<InspectorPane>`
- **Role:** Right rail pane tracking mission plan checklist, harness checks, live budget consumption, and active model roles.

```typescript
export interface InspectorPaneProps {
  plan: PlanItem[];
  latestCheck: HarnessCheckResult | null;
  budget: MissionBudget;
  roles: ModelRoleAssignment[];
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export interface PlanItem {
  id: string;
  label: string;
  status: 'todo' | 'in_progress' | 'completed' | 'skipped';
}

export interface HarnessCheckResult {
  command: string;
  status: 'idle' | 'running' | 'pass' | 'fail';
  exitCode?: number;
  outputPreview?: string;
  lastRunTimestamp?: number;
}

export interface MissionBudget {
  usedUsd: number;
  limitUsd: number;
  tokenUtilizationPct: number;
}

export interface ModelRoleAssignment {
  role: 'planner' | 'coder' | 'reviewer' | 'checker';
  modelId: string;
  provider: string;
}
```
- **OSP Event Binding:** `plan.Updated`, `check.Started`, `check.Completed`, `budget.Updated`, `model.Assigned`.

---

## 3. OSP Event Subscription & State Flow Matrix

| Component | Inbound OSP Events | Emitted OSP Requests | Local State vs Global Store |
|---|---|---|---|
| `<ShellApp>` | `system.Heartbeat`, `system.Error` | `system.Ping` | Global store (connection, active window) |
| `<InboxBadge>` | `inbox.ApprovalRequested`, `inbox.Resolved` | `inbox.ListPending` | Derived signal (pending approvals count) |
| `<MissionGroup>` | `mission.Created`, `mission.StatusChanged` | `mission.List` | Global store (active missions catalog) |
| `<TimelineView>` | `mission.StepAppended`, `snapshot.Created` | `snapshot.Restore`, `mission.Fork` | Query projection from event log |
| `<ChatView>` | `chat.TokenEmitted`, `tool.Executed` | `chat.SendTurn`, `chat.AbortTurn` | Local input state + stream buffer |
| `<DiffView>` | `workspace.FileModified` | `workspace.GetDiff` | Cached diff signals |
| `<ReceiptView>` | `receipt.Generated` | `receipt.Verify` | Immutable receipt record |
| `<PlanChecklist>`| `plan.StepUpdated` | `plan.Update` | Mission plan state |
| `<HarnessCheckStatus>`| `check.Started`, `check.Completed` | `check.RunNow` | Live check status signal |
| `<BudgetMeter>` | `budget.Updated`, `token.Telemetry` | None | Telemetry subscription |

---

## 4. Interaction States & Accessibility

### 4.1 Layout Responsiveness
- **Default / Minimum Window Size (960×740):**
  - Traffic light clearance: 38px top padding on macOS.
  - Sidebar: 240–280px fixed width, collapsible via `Cmd+B` or toggle icon.
  - Center Pane: Flexible flex-grow layout filling the viewport without horizontal overflow (`scrollWidth <= innerWidth`).
  - Inspector Pane: Collapses into slide-over drawer triggered by topbar info button (`Cmd+I`).
- **Full Screen / Maximized (1920×1080):**
  - Three columns displayed side-by-side simultaneously (Sidebar 280px, Mission Center flex-1, Inspector Pane 320px).
  - No horizontal scrolling.

### 4.2 Interaction State Matrix
- **Loading / Thinking:** Pulse animation on status badge; glowing thinking shimmer; disabled composer input with cancel button active.
- **Empty States:** Clear guidance hero with suggested initial prompts ("Code Health Audit", "Inspect Repository").
- **Error States:** Distinct failure badges with expandable stderr output and "Retry from Snapshot" action button.
- **Keyboard Navigation:**
  - `Cmd+N`: New mission / session.
  - `Cmd+B`: Toggle sidebar.
  - `Cmd+I`: Toggle inspector pane.
  - `1`, `2`, `3`, `4`: Switch between Timeline, Chat, Diff, and Receipt views.
  - `Cmd+Enter`: Submit mission prompt.

---

## 5. Migration Strategy & Zero-Lockfile Seams

1. **Phase 5 Groundwork (Current PR):**
   - Retain existing `app.js` and renderer structure without touching `pnpm-lock.yaml`.
   - Validate window harness at 960×740 and full screen.
2. **Phase 5 Lockfile Release:**
   - Once owner confirms the lockfile gate, add `preact` and `vite` as build dependencies.
3. **Progressive View Replacement:**
   - Mount Preact root inside `<div class="app-layout">`.
   - Migrate views one by one (`<Sidebar>` $ightarrow$ `<TimelineView>` $ightarrow$ `<MissionCenter>` $ightarrow$ `<InspectorPane>`).
   - Deprecate and delete `packages/desktop/renderer/app.js` once the final view is verified.
