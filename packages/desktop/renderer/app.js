/**
 * OpenSand Desktop Renderer Application Controller
 * Universal Multi-Agent & Orchestrator UI
 */

// Dual-mode backend client: native Electron IPC or local HTTP/SSE
class OpenSandClient {
  constructor() {
    this.isElectron = typeof window.opensand !== 'undefined';
    this.listeners = new Set();

    if (this.isElectron) {
      window.opensand.onEvent((event) => this.dispatch(event));
    } else {
      this.initSse();
    }
  }

  initSse() {
    const sse = new EventSource('/api/events');
    sse.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        this.dispatch(event);
      } catch {
        // Ignore parse error
      }
    };
  }

  dispatch(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Listener error:', err);
      }
    }
  }

  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async sendQuery(query, sessionId, agentId) {
    if (this.isElectron) {
      return window.opensand.sendQuery(query, sessionId, agentId);
    }
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, sessionId, agentId }),
    });
    return res.json();
  }

  async approveTool(approvalId, decision) {
    if (this.isElectron) {
      return window.opensand.approveTool(approvalId, decision);
    }
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, decision }),
    });
    return res.json();
  }

  async getSessions() {
    if (this.isElectron) {
      return window.opensand.getSessions();
    }
    const res = await fetch('/api/sessions');
    return res.json();
  }

  async loadSession(sessionId) {
    if (this.isElectron) {
      return window.opensand.loadSession(sessionId);
    }
    const res = await fetch(`/api/sessions/${sessionId}`);
    return res.json();
  }

  async getSettings() {
    if (this.isElectron) {
      return window.opensand.getSettings();
    }
    const res = await fetch('/api/settings');
    return res.json();
  }

  async updateSettings(settings) {
    if (this.isElectron) {
      return window.opensand.updateSettings(settings);
    }
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    return res.json();
  }

  async getAgents() {
    const res = await fetch('/api/agents');
    return res.json();
  }

  async createAgent(agent) {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(agent),
    });
    return res.json();
  }

  async getTasks() {
    const res = await fetch('/api/tasks');
    return res.json();
  }

  async createTask(task) {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    });
    return res.json();
  }

  async updateTask(id, updates) {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return res.json();
  }

  async getLearnedRules() {
    const res = await fetch('/api/learned-rules');
    return res.json();
  }

  async refreshLearnedRules() {
    const res = await fetch('/api/learned-rules/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return res.json();
  }

  // --- Rooms API ---
  async getRooms() {
    const res = await fetch('/api/rooms');
    return res.json();
  }

  async createRoom(room) {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(room),
    });
    return res.json();
  }

  async runRoomDiscussion(roomId, topic) {
    const res = await fetch(`/api/rooms/${roomId}/discuss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
    return res.json();
  }

  async deleteRoom(roomId) {
    const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
    return res.json();
  }

  // --- Routines API ---
  async getRoutines() {
    const res = await fetch('/api/routines');
    return res.json();
  }

  async createRoutine(routine) {
    const res = await fetch('/api/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(routine),
    });
    return res.json();
  }

  async setRoutineEnabled(routineId, isEnabled) {
    const res = await fetch(`/api/routines/${routineId}/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEnabled }),
    });
    return res.json();
  }

  async triggerRoutine(routineId) {
    const res = await fetch(`/api/routines/${routineId}/trigger`, { method: 'POST' });
    return res.json();
  }

  async deleteRoutine(routineId) {
    const res = await fetch(`/api/routines/${routineId}`, { method: 'DELETE' });
    return res.json();
  }

  // --- Skills API ---
  async getSkills(category) {
    const url = category ? `/api/skills?category=${encodeURIComponent(category)}` : '/api/skills';
    const res = await fetch(url);
    return res.json();
  }

  async createSkill(skill) {
    const res = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(skill),
    });
    return res.json();
  }

  async deleteSkill(skillId) {
    const res = await fetch(`/api/skills/${skillId}`, { method: 'DELETE' });
    return res.json();
  }

  // --- Vault API ---
  async getSecrets() {
    const res = await fetch('/api/vault/secrets');
    return res.json();
  }

  async storeSecret(secret) {
    const res = await fetch('/api/vault/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(secret),
    });
    return res.json();
  }

  async deleteSecret(idOrName) {
    const res = await fetch(`/api/vault/secrets/${encodeURIComponent(idOrName)}`, { method: 'DELETE' });
    return res.json();
  }

  async getCredentials() {
    const res = await fetch('/api/vault/credentials');
    return res.json();
  }

  async storeCredential(cred) {
    const res = await fetch('/api/vault/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    });
    return res.json();
  }

  async deleteCredential(idOrTitle) {
    const res = await fetch(`/api/vault/credentials/${encodeURIComponent(idOrTitle)}`, { method: 'DELETE' });
    return res.json();
  }

  // --- Memories API ---
  async getMemories(tier) {
    const url = tier ? `/api/memories?tier=${encodeURIComponent(tier)}` : '/api/memories';
    const res = await fetch(url);
    return res.json();
  }

  async addMemory(memory) {
    const res = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memory),
    });
    return res.json();
  }

  async getTeamReviewItems() {
    const res = await fetch('/api/team-review');
    return res.json();
  }

  async resolveReviewItem(itemId, decision) {
    const res = await fetch(`/api/team-review/${itemId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    return res.json();
  }

  // --- Attachments API ---
  async getAttachments() {
    const res = await fetch('/api/attachments');
    return res.json();
  }

  async stageAttachment(filePath) {
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    return res.json();
  }

  async deleteAttachment(id) {
    const res = await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.json();
  }

  // --- Templates API ---
  async exportAgentTemplate(agentId) {
    const res = await fetch(`/api/templates/${encodeURIComponent(agentId)}`);
    return res.json();
  }

  async importAgentTemplate(template) {
    const res = await fetch('/api/templates/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof template === 'string' ? template : JSON.stringify(template),
    });
    return res.json();
  }

  // --- BTW Side Question & Rollback & Compact ---
  async askBtw(question) {
    const res = await fetch('/api/btw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    return res.json();
  }

  async rollbackTurns(turns) {
    const res = await fetch('/api/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turns }),
    });
    return res.json();
  }

  async compactHistory(keepRecentTurns) {
    const res = await fetch('/api/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepRecentTurns }),
    });
    return res.json();
  }

  // --- Workspace Sentinel API ---
  async getWatchers() {
    const res = await fetch('/api/sentinels');
    return res.json();
  }

  async startWatcher(options) {
    const res = await fetch('/api/sentinels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    return res.json();
  }

  async stopWatcher(watcherId) {
    const res = await fetch(`/api/sentinels/${encodeURIComponent(watcherId)}`, { method: 'DELETE' });
    return res.json();
  }

  async getSentinelLogs(watcherId) {
    const url = watcherId ? `/api/sentinels/logs?watcherId=${encodeURIComponent(watcherId)}` : '/api/sentinels/logs';
    const res = await fetch(url);
    return res.json();
  }
}

// UI Controller
document.addEventListener('DOMContentLoaded', async () => {
  const client = new OpenSandClient();

  // Navigation Tabs & Views
  const navTabs = document.querySelectorAll('.nav-tab');
  const viewPanels = {
    chat: document.getElementById('viewChat'),
    rooms: document.getElementById('viewRooms'),
    routines: document.getElementById('viewRoutines'),
    skills: document.getElementById('viewSkills'),
    vault: document.getElementById('viewVault'),
    memories: document.getElementById('viewMemories'),
    attachments: document.getElementById('viewAttachments'),
    templates: document.getElementById('viewTemplates'),
    sentinel: document.getElementById('viewSentinel'),
  };

  let currentView = 'chat';

  function switchView(viewName) {
    currentView = viewName;
    navTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    Object.keys(viewPanels).forEach((key) => {
      const panel = viewPanels[key];
      if (panel) {
        panel.classList.toggle('hidden', key !== viewName);
      }
    });

    // Auto-refresh data on tab switch
    if (viewName === 'rooms') refreshRooms();
    if (viewName === 'routines') refreshRoutines();
    if (viewName === 'skills') refreshSkills();
    if (viewName === 'vault') refreshVault();
    if (viewName === 'memories') refreshMemories();
    if (viewName === 'attachments') refreshAttachments();
    if (viewName === 'templates') refreshTemplates();
    if (viewName === 'sentinel') refreshSentinel();
  }

  navTabs.forEach((tab) => {
    tab.onclick = () => switchView(tab.dataset.view);
  });

  // Chat Elements
  const chatContainer = document.getElementById('chatContainer');
  const messageFeed = document.getElementById('messageFeed');
  const welcomeBanner = document.getElementById('welcomeBanner');
  const promptInput = document.getElementById('promptInput');
  const btnSend = document.getElementById('btnSend');
  const btnNewSession = document.getElementById('btnNewSession');
  const sessionList = document.getElementById('sessionList');
  const botList = document.getElementById('botList');
  const taskList = document.getElementById('taskList');
  const activeSessionTitle = document.getElementById('activeSessionTitle');
  const badgeActiveBot = document.getElementById('badgeActiveBot');
  const badgeModel = document.getElementById('badgeModel');
  const badgeAutoApprove = document.getElementById('badgeAutoApprove');
  const botStatusAvatar = document.getElementById('botStatusAvatar');
  const botStatusText = document.getElementById('botStatusText');

  // Approval modal elements
  const approvalModal = document.getElementById('approvalModal');
  const approvalToolName = document.getElementById('approvalToolName');
  const approvalArgsBox = document.getElementById('approvalArgsBox');
  const btnApproveOnce = document.getElementById('btnApproveOnce');
  const btnAlwaysAllow = document.getElementById('btnAlwaysAllow');
  const btnRejectTool = document.getElementById('btnRejectTool');

  // Bot Modal Elements
  const btnOpenCreateBot = document.getElementById('btnOpenCreateBot');
  const createBotModal = document.getElementById('createBotModal');
  const btnCloseCreateBot = document.getElementById('btnCloseCreateBot');
  const btnSaveBot = document.getElementById('btnSaveBot');
  const botName = document.getElementById('botName');
  const botRole = document.getElementById('botRole');
  const botSystemPrompt = document.getElementById('botSystemPrompt');
  const botModel = document.getElementById('botModel');

  // Task Modal Elements
  const btnOpenCreateTask = document.getElementById('btnOpenCreateTask');
  const createTaskModal = document.getElementById('createTaskModal');
  const btnCloseCreateTask = document.getElementById('btnCloseCreateTask');
  const btnSaveTask = document.getElementById('btnSaveTask');
  const taskTitle = document.getElementById('taskTitle');
  const taskPriority = document.getElementById('taskPriority');

  // Room Modal Elements
  const btnOpenCreateRoom = document.getElementById('btnOpenCreateRoom');
  const createRoomModal = document.getElementById('createRoomModal');
  const btnCloseCreateRoom = document.getElementById('btnCloseCreateRoom');
  const btnSaveRoom = document.getElementById('btnSaveRoom');
  const roomName = document.getElementById('roomName');
  const roomDesc = document.getElementById('roomDesc');
  const roomMemberCheckboxes = document.getElementById('roomMemberCheckboxes');

  // Convene Modal Elements
  const conveneDiscussionModal = document.getElementById('conveneDiscussionModal');
  const btnCloseConvene = document.getElementById('btnCloseConvene');
  const conveneModalTitle = document.getElementById('conveneModalTitle');
  const discussionTopic = document.getElementById('discussionTopic');
  const btnStartDiscussion = document.getElementById('btnStartDiscussion');
  const discussionLiveResults = document.getElementById('discussionLiveResults');
  const discussionFeedBox = document.getElementById('discussionFeedBox');
  const consensusBox = document.getElementById('consensusBox');
  const btnCloseDiscussionDone = document.getElementById('btnCloseDiscussionDone');
  let activeConveneRoomId = null;

  // Routine Modal Elements
  const btnOpenCreateRoutine = document.getElementById('btnOpenCreateRoutine');
  const createRoutineModal = document.getElementById('createRoutineModal');
  const btnCloseCreateRoutine = document.getElementById('btnCloseCreateRoutine');
  const btnSaveRoutine = document.getElementById('btnSaveRoutine');
  const routineName = document.getElementById('routineName');
  const routinePrompt = document.getElementById('routinePrompt');
  const routineScheduleType = document.getElementById('routineScheduleType');
  const groupInterval = document.getElementById('groupInterval');
  const groupCron = document.getElementById('groupCron');
  const routineIntervalMinutes = document.getElementById('routineIntervalMinutes');
  const routineCron = document.getElementById('routineCron');

  routineScheduleType.onchange = () => {
    if (routineScheduleType.value === 'cron') {
      groupInterval.classList.add('hidden');
      groupCron.classList.remove('hidden');
    } else {
      groupInterval.classList.remove('hidden');
      groupCron.classList.add('hidden');
    }
  };

  // Skill Modal Elements
  const btnOpenCreateSkill = document.getElementById('btnOpenCreateSkill');
  const createSkillModal = document.getElementById('createSkillModal');
  const btnCloseCreateSkill = document.getElementById('btnCloseCreateSkill');
  const btnSaveSkill = document.getElementById('btnSaveSkill');
  const skillName = document.getElementById('skillName');
  const skillDescription = document.getElementById('skillDescription');
  const skillContent = document.getElementById('skillContent');

  // Vault Modal Elements
  const btnOpenAddSecret = document.getElementById('btnOpenAddSecret');
  const addSecretModal = document.getElementById('addSecretModal');
  const btnCloseAddSecret = document.getElementById('btnCloseAddSecret');
  const btnSaveSecret = document.getElementById('btnSaveSecret');
  const secretName = document.getElementById('secretName');
  const secretValue = document.getElementById('secretValue');
  const secretDesc = document.getElementById('secretDesc');

  const btnOpenAddCredential = document.getElementById('btnOpenAddCredential');
  const addCredentialModal = document.getElementById('addCredentialModal');
  const btnCloseAddCredential = document.getElementById('btnCloseAddCredential');
  const btnSaveCredential = document.getElementById('btnSaveCredential');
  const credTitle = document.getElementById('credTitle');
  const credUsername = document.getElementById('credUsername');
  const credPassword = document.getElementById('credPassword');
  const credSites = document.getElementById('credSites');

  // Memory Modal Elements
  const btnOpenAddMemory = document.getElementById('btnOpenAddMemory');
  const addMemoryModal = document.getElementById('addMemoryModal');
  const btnCloseAddMemory = document.getElementById('btnCloseAddMemory');
  const btnSaveMemory = document.getElementById('btnSaveMemory');
  const memText = document.getElementById('memText');
  const memScope = document.getElementById('memScope');
  const memTier = document.getElementById('memTier');

  // Learned Rules Elements
  const btnViewLearnedRules = document.getElementById('btnViewLearnedRules');
  const learnedRulesModal = document.getElementById('learnedRulesModal');
  const btnCloseLearnedRules = document.getElementById('btnCloseLearnedRules');
  const btnCloseLearnedRulesAction = document.getElementById('btnCloseLearnedRulesAction');
  const btnRefreshLearnedRules = document.getElementById('btnRefreshLearnedRules');
  const learnedRulesContent = document.getElementById('learnedRulesContent');

  // Native Quick Tools
  const btnQuickOcr = document.getElementById('btnQuickOcr');
  const btnQuickWindow = document.getElementById('btnQuickWindow');

  // Settings Modal Elements
  const btnSettings = document.getElementById('btnSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const settingProvider = document.getElementById('settingProvider');
  const settingEndpoint = document.getElementById('settingEndpoint');
  const settingModel = document.getElementById('settingModel');
  const settingApiKey = document.getElementById('settingApiKey');
  const settingAutoApprove = document.getElementById('settingAutoApprove');

  // State
  let currentSessionId = null;
  let activeAgentId = null;
  let activeApprovalId = null;
  let currentAssistantBubble = null;
  let currentAssistantText = '';

  // --- REFRESH FUNCTIONS ---

  async function refreshSettings() {
    const s = await client.getSettings();
    badgeModel.textContent = s.model || 'Default';
    badgeAutoApprove.textContent = s.autoApprove ? '⚡ Auto-Approve' : '🛡 Safe Mode';
    badgeAutoApprove.className = s.autoApprove ? 'badge badge-warning' : 'badge badge-success';
  }

  async function refreshBots() {
    const agents = await client.getAgents();
    botList.innerHTML = '';

    const defaultItem = document.createElement('div');
    defaultItem.className = `bot-item ${activeAgentId === null ? 'active' : ''}`;
    defaultItem.innerHTML = `<span class="bot-icon">🤖</span><span class="bot-name">Default Assistant</span>`;
    defaultItem.onclick = () => {
      activeAgentId = null;
      badgeActiveBot.textContent = '🤖 Default Assistant';
      refreshBots();
    };
    botList.appendChild(defaultItem);

    for (const a of agents) {
      const item = document.createElement('div');
      item.className = `bot-item ${activeAgentId === a.id ? 'active' : ''}`;
      const icon = a.kind === 'ROOM' ? '👥' : '⚡';
      item.innerHTML = `<span class="bot-icon">${icon}</span><span class="bot-name">${escapeHtml(a.name)}</span>`;
      item.title = a.role || a.name;
      item.onclick = () => {
        activeAgentId = a.id;
        badgeActiveBot.textContent = `${icon} ${a.name}`;
        refreshBots();
      };
      botList.appendChild(item);
    }
  }

  async function refreshTasks() {
    const tasks = await client.getTasks();
    taskList.innerHTML = '';

    for (const t of tasks) {
      const isDone = t.status === 'done';
      const item = document.createElement('div');
      item.className = 'task-item';
      item.innerHTML = `
        <input type="checkbox" class="task-checkbox" ${isDone ? 'checked' : ''}>
        <span class="task-text ${isDone ? 'completed' : ''}">${escapeHtml(t.title)}</span>
      `;
      const checkbox = item.querySelector('.task-checkbox');
      checkbox.onchange = async () => {
        await client.updateTask(t.id, { status: checkbox.checked ? 'done' : 'todo' });
        refreshTasks();
      };
      taskList.appendChild(item);
    }
  }

  async function refreshSessions() {
    const sessions = await client.getSessions();
    sessionList.innerHTML = '';

    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = `session-item ${s.id === currentSessionId ? 'active' : ''}`;
      item.textContent = s.title || s.id;
      item.onclick = () => selectSession(s.id);
      sessionList.appendChild(item);
    }
  }

  // --- ROOMS VIEW CONTROLLER ---
  async function refreshRooms() {
    const grid = document.getElementById('roomsCardGrid');
    const rooms = await client.getRooms();
    grid.innerHTML = '';

    if (rooms.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;">No multi-agent rooms created yet. Click "+ Create Room" to convene a team.</div>`;
      return;
    }

    for (const r of rooms) {
      const card = document.createElement('div');
      card.className = 'dashboard-card';
      card.innerHTML = `
        <div class="card-top">
          <div class="card-title">👥 ${escapeHtml(r.name)}</div>
          <span class="badge badge-bot">${r.memberAgentIds.length} Agents</span>
        </div>
        <div class="card-desc">${escapeHtml(r.description || 'No description.')}</div>
        <div class="card-meta">
          <span class="badge">Discussions: ${r.discussionCount || 0}</span>
          ${r.activeTopic ? `<span class="badge" title="${escapeHtml(r.activeTopic)}">Active Topic: ${escapeHtml(r.activeTopic.slice(0, 28))}...</span>` : ''}
        </div>
        <div class="card-footer">
          <button class="btn btn-primary btn-xs btn-convene">Convene Meeting</button>
          <button class="btn btn-ghost btn-xs btn-del-room" style="color: var(--danger);">Delete</button>
        </div>
      `;

      card.querySelector('.btn-convene').onclick = () => {
        activeConveneRoomId = r.roomId;
        conveneModalTitle.textContent = `Convene Deliberation: ${r.name}`;
        discussionTopic.value = r.activeTopic || '';
        discussionLiveResults.classList.add('hidden');
        btnStartDiscussion.classList.remove('hidden');
        btnStartDiscussion.disabled = false;
        btnStartDiscussion.textContent = 'Start Deliberation';
        btnCloseDiscussionDone.classList.add('hidden');
        conveneDiscussionModal.classList.remove('hidden');
      };

      card.querySelector('.btn-del-room').onclick = async () => {
        if (confirm(`Delete room "${r.name}"?`)) {
          await client.deleteRoom(r.roomId);
          refreshRooms();
          refreshBots();
        }
      };

      grid.appendChild(card);
    }
  }

  // --- ROUTINES VIEW CONTROLLER ---
  async function refreshRoutines() {
    const grid = document.getElementById('routinesCardGrid');
    const routines = await client.getRoutines();
    grid.innerHTML = '';

    if (routines.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;">No background routines configured. Click "+ New Routine" to schedule one.</div>`;
      return;
    }

    for (const r of routines) {
      const card = document.createElement('div');
      card.className = 'dashboard-card';
      const statusBadge = r.lastRunStatus === 'success'
        ? '<span class="badge badge-success">✓ Success</span>'
        : r.lastRunStatus === 'error'
        ? '<span class="badge badge-danger">✗ Error</span>'
        : r.lastRunStatus === 'running'
        ? '<span class="badge badge-warning">⚡ Running</span>'
        : '<span class="badge">Idle</span>';

      const nextRunStr = r.nextRunAtMs ? new Date(r.nextRunAtMs).toLocaleTimeString() : 'Disabled';

      card.innerHTML = `
        <div class="card-top">
          <div class="card-title">⏱ ${escapeHtml(r.name)}</div>
          ${statusBadge}
        </div>
        <div class="card-desc"><strong>Action:</strong> ${escapeHtml(JSON.parse(r.recordJson || '{}').prompt || r.name)}</div>
        <div class="card-meta">
          <span class="badge">${escapeHtml(r.triggerDescription)}</span>
          <span class="badge">Next: ${nextRunStr}</span>
          <span class="badge">Runs: ${r.runCount}</span>
        </div>
        <div class="card-footer">
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-secondary btn-xs btn-trigger">Run Now</button>
            <button class="btn btn-ghost btn-xs btn-toggle">${r.isEnabled ? 'Pause' : 'Enable'}</button>
          </div>
          <button class="btn btn-ghost btn-xs btn-del-routine" style="color: var(--danger);">Delete</button>
        </div>
      `;

      card.querySelector('.btn-trigger').onclick = async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Running...';
        await client.triggerRoutine(r.routineId);
        btn.disabled = false;
        btn.textContent = 'Run Now';
        refreshRoutines();
      };

      card.querySelector('.btn-toggle').onclick = async () => {
        await client.setRoutineEnabled(r.routineId, !r.isEnabled);
        refreshRoutines();
      };

      card.querySelector('.btn-del-routine').onclick = async () => {
        if (confirm(`Delete routine "${r.name}"?`)) {
          await client.deleteRoutine(r.routineId);
          refreshRoutines();
        }
      };

      grid.appendChild(card);
    }
  }

  // --- SKILLS VIEW CONTROLLER ---
  async function refreshSkills() {
    const grid = document.getElementById('skillsCardGrid');
    const skills = await client.getSkills();
    grid.innerHTML = '';

    if (skills.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;">No modular recipe skills in library. Click "+ New Skill" to add one.</div>`;
      return;
    }

    for (const s of skills) {
      const card = document.createElement('div');
      card.className = 'dashboard-card';
      card.innerHTML = `
        <div class="card-top">
          <div class="card-title">🧩 ${escapeHtml(s.name)}</div>
          <span class="badge">${escapeHtml(s.category || 'general')}</span>
        </div>
        <div class="card-desc">${escapeHtml(s.description || 'No description.')}</div>
        <div class="card-meta">
          <span class="badge">Origin: ${escapeHtml(s.origin || 'custom')}</span>
          <span class="badge">${(s.content || '').length} bytes</span>
        </div>
        <div class="card-footer">
          <button class="btn btn-secondary btn-xs btn-preview-skill">View Recipe</button>
          <button class="btn btn-ghost btn-xs btn-del-skill" style="color: var(--danger);">Delete</button>
        </div>
      `;

      card.querySelector('.btn-preview-skill').onclick = () => {
        alert(`=== Skill: ${s.name} ===\n\n${s.content}`);
      };

      card.querySelector('.btn-del-skill').onclick = async () => {
        if (confirm(`Delete skill "${s.name}"?`)) {
          await client.deleteSkill(s.id);
          refreshSkills();
        }
      };

      grid.appendChild(card);
    }
  }

  // --- VAULT VIEW CONTROLLER ---
  async function refreshVault() {
    const secGrid = document.getElementById('vaultSecretsGrid');
    const credGrid = document.getElementById('vaultCredentialsGrid');
    secGrid.innerHTML = '';
    credGrid.innerHTML = '';

    const secrets = await client.getSecrets();
    const credentials = await client.getCredentials();

    if (secrets.length === 0) {
      secGrid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No encrypted secrets stored.</div>`;
    } else {
      for (const s of secrets) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">🔑 ${escapeHtml(s.name)}</div>
            <span class="badge badge-success">Encrypted</span>
          </div>
          <div class="card-desc">${escapeHtml(s.description || 'Environment secret token')}</div>
          <div class="card-meta">
            <span class="vault-value-mask" title="Click to reveal">${s.preview || '••••••••'}</span>
          </div>
          <div class="card-footer">
            <button class="btn btn-ghost btn-xs btn-del-sec" style="color: var(--danger);">Delete</button>
          </div>
        `;
        card.querySelector('.btn-del-sec').onclick = async () => {
          if (confirm(`Delete secret "${s.name}"?`)) {
            await client.deleteSecret(s.name);
            refreshVault();
          }
        };
        secGrid.appendChild(card);
      }
    }

    if (credentials.length === 0) {
      credGrid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No account credentials stored.</div>`;
    } else {
      for (const c of credentials) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">👤 ${escapeHtml(c.title)}</div>
            <span class="badge">${escapeHtml(c.username || 'user')}</span>
          </div>
          <div class="card-desc"><strong>Sites:</strong> ${escapeHtml((c.sites || []).join(', ') || 'Any')}</div>
          <div class="card-meta">
            <span class="vault-value-mask">••••••••••••</span>
          </div>
          <div class="card-footer">
            <button class="btn btn-ghost btn-xs btn-del-cred" style="color: var(--danger);">Delete</button>
          </div>
        `;
        card.querySelector('.btn-del-cred').onclick = async () => {
          if (confirm(`Delete credential "${c.title}"?`)) {
            await client.deleteCredential(c.id);
            refreshVault();
          }
        };
        credGrid.appendChild(card);
      }
    }
  }

  // --- MEMORIES VIEW CONTROLLER ---
  async function refreshMemories() {
    const revGrid = document.getElementById('teamReviewGrid');
    const memGrid = document.getElementById('memoriesGrid');
    revGrid.innerHTML = '';
    memGrid.innerHTML = '';

    const reviewItems = await client.getTeamReviewItems();
    const memories = await client.getMemories();

    if (reviewItems.length === 0) {
      revGrid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No pending team memory review proposals.</div>`;
    } else {
      for (const item of reviewItems) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">📝 ${escapeHtml(item.action)}: ${escapeHtml(item.proposedFact.text.slice(0, 40))}...</div>
            <span class="badge badge-warning">${item.status}</span>
          </div>
          <div class="card-desc">${escapeHtml(item.proposedFact.text)}</div>
          <div class="card-meta">
            <span class="badge">Proposed by: ${escapeHtml(item.proposedByAgentId)}</span>
            <span class="badge">Tier: ${escapeHtml(item.proposedFact.tier)}</span>
          </div>
          <div class="card-footer">
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-primary btn-xs btn-approve-rev">Approve</button>
              <button class="btn btn-ghost btn-xs btn-reject-rev" style="color: var(--danger);">Reject</button>
            </div>
          </div>
        `;
        card.querySelector('.btn-approve-rev').onclick = async () => {
          await client.resolveReviewItem(item.id, 'approve');
          refreshMemories();
        };
        card.querySelector('.btn-reject-rev').onclick = async () => {
          await client.resolveReviewItem(item.id, 'reject');
          refreshMemories();
        };
        revGrid.appendChild(card);
      }
    }

    if (memories.length === 0) {
      memGrid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No memory facts recorded yet.</div>`;
    } else {
      for (const m of memories) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">🧠 ${escapeHtml(m.tier || 'fact').toUpperCase()}</div>
            <span class="badge badge-bot">${escapeHtml(m.scope || 'user')}</span>
          </div>
          <div class="card-desc">${escapeHtml(m.text)}</div>
          <div class="card-meta">
            <span class="badge">Confidence: ${Math.round((m.confidence || 1) * 100)}%</span>
            <span class="badge">${new Date(m.updatedAtMs || m.createdAtMs || Date.now()).toLocaleDateString()}</span>
          </div>
        `;
        memGrid.appendChild(card);
      }
    }
  }

  // --- ATTACHMENTS VIEW CONTROLLER ---
  async function refreshAttachments() {
    const grid = document.getElementById('attachmentsCardGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const list = await client.getAttachments();
    if (!Array.isArray(list) || list.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No staged context attachments. Use "+ Stage Attachment" to add files.</div>`;
      return;
    }

    for (const att of list) {
      const card = document.createElement('div');
      card.className = 'dashboard-card';
      const sizeKb = Math.round(((att.byteLength || 0) / 1024) * 10) / 10;
      card.innerHTML = `
        <div class="card-top">
          <div class="card-title">📎 ${escapeHtml(att.fileName || 'Attachment')}</div>
          <span class="badge badge-success">Staged</span>
        </div>
        <div class="card-desc" style="word-break: break-all;"><strong>Path:</strong> ${escapeHtml(att.filePath || 'in-memory')}</div>
        <div class="card-meta">
          <span class="badge">${sizeKb} KB</span>
          <span class="attachment-hash" title="SHA-256 Digest">SHA: ${escapeHtml((att.sha256 || '').slice(0, 16))}...</span>
        </div>
        <div class="card-footer">
          <button class="btn btn-ghost btn-xs btn-del-att" style="color: var(--danger);">Unstage</button>
        </div>
      `;

      card.querySelector('.btn-del-att').onclick = async () => {
        if (confirm(`Unstage attachment "${att.fileName}"?`)) {
          await client.deleteAttachment(att.id);
          refreshAttachments();
        }
      };

      grid.appendChild(card);
    }
  }

  // --- TEMPLATES VIEW CONTROLLER ---
  async function refreshTemplates() {
    const grid = document.getElementById('templateAgentsGrid');
    const selectExport = document.getElementById('selectExportBot');
    if (grid) grid.innerHTML = '';
    if (selectExport) selectExport.innerHTML = '';

    const agents = await client.getAgents();
    if (!Array.isArray(agents) || agents.length === 0) {
      if (grid) grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No agents registered. Create an agent persona first.</div>`;
      return;
    }

    for (const a of agents) {
      if (selectExport) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = `${a.name} (${a.role})`;
        selectExport.appendChild(opt);
      }

      if (grid) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">🤖 ${escapeHtml(a.name)}</div>
            <span class="badge badge-bot">${escapeHtml(a.role)}</span>
          </div>
          <div class="card-desc">${escapeHtml((a.systemPrompt || '').slice(0, 120))}...</div>
          <div class="card-meta">
            <span class="badge">Model: ${escapeHtml(a.model || 'default')}</span>
            <span class="badge">Tools: ${a.allowedTools ? a.allowedTools.length : 'All'}</span>
          </div>
          <div class="card-footer">
            <button class="btn btn-secondary btn-xs btn-export-agent">Export Template</button>
          </div>
        `;

        card.querySelector('.btn-export-agent').onclick = async () => {
          if (selectExport) selectExport.value = a.id;
          exportTemplateModal.classList.remove('hidden');
          const tpl = await client.exportAgentTemplate(a.id);
          exportTemplateJson.textContent = JSON.stringify(tpl, null, 2);
        };

        grid.appendChild(card);
      }
    }
  }

  // --- SENTINEL VIEW CONTROLLER ---
  async function refreshSentinel() {
    const watchersGrid = document.getElementById('sentinelWatchersGrid');
    const feed = document.getElementById('sentinelFeed');
    if (watchersGrid) watchersGrid.innerHTML = '';
    if (feed) feed.innerHTML = '';

    const watchers = await client.getWatchers();
    const logs = await client.getSentinelLogs();

    if (!Array.isArray(watchers) || watchers.length === 0) {
      if (watchersGrid) {
        watchersGrid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No active workspace watchers. Click "+ New Watcher" to monitor code changes and enable auto-healing.</div>`;
      }
    } else {
      for (const w of watchers) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">🛡️ ${escapeHtml(w.id)}</div>
            <span class="badge ${w.autoHeal ? 'badge-success' : ''}">${w.autoHeal ? 'Auto-Heal Active' : 'Passive'}</span>
          </div>
          <div class="card-desc"><strong>Target:</strong> ${escapeHtml(w.targetDir)}</div>
          <div class="card-meta">
            <span class="badge">Check: ${escapeHtml(w.checkCommand || 'Filesystem Only')}</span>
            <span class="badge">Debounce: ${w.debounceMs}ms</span>
          </div>
          <div class="card-footer">
            <button class="btn btn-ghost btn-xs btn-stop-watcher" style="color: var(--danger);">Stop Watcher</button>
          </div>
        `;

        card.querySelector('.btn-stop-watcher').onclick = async () => {
          if (confirm(`Stop watcher ${w.id}?`)) {
            await client.stopWatcher(w.id);
            refreshSentinel();
          }
        };

        watchersGrid.appendChild(card);
      }
    }

    if (!Array.isArray(logs) || logs.length === 0) {
      if (feed) {
        feed.innerHTML = `<div style="color: var(--text-muted); font-size: 13px;">No diagnostic events recorded yet. Modify a file in a watched directory to trigger Sentinel.</div>`;
      }
    } else {
      for (const log of logs.slice(-20).reverse()) {
        renderSentinelLogEntry(log, feed);
      }
    }
  }

  function renderSentinelLogEntry(log, container) {
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = `sentinel-item ${log.status || 'clean'}`;
    const timeStr = new Date(log.timestampMs || Date.now()).toLocaleTimeString();

    let proposalHtml = '';
    if (log.healingProposal) {
      proposalHtml = `
        <div style="font-weight: 600; margin-top: 4px; color: #93c5fd;">Autonomous Healer Action / Proposal:</div>
        <div class="sentinel-proposal-box">${escapeHtml(log.healingProposal)}</div>
      `;
    }

    entry.innerHTML = `
      <div class="sentinel-header-row">
        <div>
          <span class="status-badge ${log.status || 'clean'}">${log.status}</span>
          <strong style="margin-left: 8px;">Trigger: ${escapeHtml(log.triggerFile || 'change')}</strong>
        </div>
        <span style="color: var(--text-muted); font-size: 11px;">${timeStr}</span>
      </div>
      <div style="color: var(--text-muted); font-size: 11px;">Target: ${escapeHtml(log.targetDir || '')} | Command: ${escapeHtml(log.checkCommand || 'N/A')}</div>
      ${log.output ? `<div class="sentinel-output-box">${escapeHtml(log.output)}</div>` : ''}
      ${proposalHtml}
    `;

    container.appendChild(entry);
  }

  // --- MODAL DIALOG CONTROLLERS ---

  // Room creation
  btnOpenCreateRoom.onclick = async () => {
    roomName.value = '';
    roomDesc.value = '';
    roomMemberCheckboxes.innerHTML = '';
    const agents = await client.getAgents();

    for (const a of agents) {
      if (a.kind === 'ROOM') continue; // Don't nest rooms
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;';
      lbl.innerHTML = `<input type="checkbox" value="${a.id}" checked> <span>${escapeHtml(a.name)} (${escapeHtml(a.role)})</span>`;
      roomMemberCheckboxes.appendChild(lbl);
    }

    createRoomModal.classList.remove('hidden');
  };

  btnCloseCreateRoom.onclick = () => createRoomModal.classList.add('hidden');

  btnSaveRoom.onclick = async () => {
    const checked = Array.from(roomMemberCheckboxes.querySelectorAll('input:checked')).map((i) => i.value);
    if (!roomName.value.trim() || checked.length === 0) {
      alert('Please provide a room name and select at least one member agent.');
      return;
    }
    await client.createRoom({
      name: roomName.value.trim(),
      description: roomDesc.value.trim(),
      memberAgentIds: checked,
    });
    createRoomModal.classList.add('hidden');
    refreshRooms();
    refreshBots();
  };

  // Discussion Convening
  btnCloseConvene.onclick = () => conveneDiscussionModal.classList.add('hidden');
  btnCloseDiscussionDone.onclick = () => conveneDiscussionModal.classList.add('hidden');

  btnStartDiscussion.onclick = async () => {
    const topic = discussionTopic.value.trim();
    if (!topic || !activeConveneRoomId) return;

    btnStartDiscussion.disabled = true;
    btnStartDiscussion.textContent = 'Deliberating...';

    const res = await client.runRoomDiscussion(activeConveneRoomId, topic);

    discussionFeedBox.innerHTML = '';
    for (const turn of res.turns || []) {
      const turnDiv = document.createElement('div');
      turnDiv.className = 'discussion-turn';
      turnDiv.innerHTML = `
        <div class="turn-author">Turn ${turn.turnIndex}: ${escapeHtml(turn.memberName)} (${escapeHtml(turn.memberRole)})</div>
        <div>${escapeHtml(turn.content)}</div>
      `;
      discussionFeedBox.appendChild(turnDiv);
    }

    consensusBox.textContent = res.consensus || 'No consensus rendered.';
    discussionLiveResults.classList.remove('hidden');

    btnStartDiscussion.classList.add('hidden');
    btnCloseDiscussionDone.classList.remove('hidden');
    refreshRooms();
  };

  // Routine creation
  btnOpenCreateRoutine.onclick = () => {
    routineName.value = '';
    routinePrompt.value = '';
    routineScheduleType.value = 'interval';
    routineIntervalMinutes.value = 60;
    routineCron.value = '';
    groupInterval.classList.remove('hidden');
    groupCron.classList.add('hidden');
    createRoutineModal.classList.remove('hidden');
  };

  btnCloseCreateRoutine.onclick = () => createRoutineModal.classList.add('hidden');

  btnSaveRoutine.onclick = async () => {
    if (!routineName.value.trim() || !routinePrompt.value.trim()) {
      alert('Please provide routine name and prompt instructions.');
      return;
    }
    await client.createRoutine({
      name: routineName.value.trim(),
      prompt: routinePrompt.value.trim(),
      scheduleType: routineScheduleType.value,
      intervalMinutes: parseInt(routineIntervalMinutes.value, 10) || 60,
      cron: routineCron.value.trim() || undefined,
    });
    createRoutineModal.classList.add('hidden');
    refreshRoutines();
  };

  // Skill creation
  btnOpenCreateSkill.onclick = () => {
    skillName.value = '';
    skillDescription.value = '';
    skillContent.value = '';
    createSkillModal.classList.remove('hidden');
  };

  btnCloseCreateSkill.onclick = () => createSkillModal.classList.add('hidden');

  btnSaveSkill.onclick = async () => {
    if (!skillContent.value.trim()) {
      alert('Please provide skill recipe markdown content.');
      return;
    }
    await client.createSkill({
      name: skillName.value.trim(),
      description: skillDescription.value.trim(),
      content: skillContent.value.trim(),
    });
    createSkillModal.classList.add('hidden');
    refreshSkills();
  };

  // Vault creation
  btnOpenAddSecret.onclick = () => {
    secretName.value = '';
    secretValue.value = '';
    secretDesc.value = '';
    addSecretModal.classList.remove('hidden');
  };
  btnCloseAddSecret.onclick = () => addSecretModal.classList.add('hidden');
  btnSaveSecret.onclick = async () => {
    if (!secretName.value.trim() || !secretValue.value.trim()) {
      alert('Please provide secret name and value.');
      return;
    }
    await client.storeSecret({
      name: secretName.value.trim(),
      value: secretValue.value.trim(),
      description: secretDesc.value.trim(),
    });
    addSecretModal.classList.add('hidden');
    refreshVault();
  };

  btnOpenAddCredential.onclick = () => {
    credTitle.value = '';
    credUsername.value = '';
    credPassword.value = '';
    credSites.value = '';
    addCredentialModal.classList.remove('hidden');
  };
  btnCloseAddCredential.onclick = () => addCredentialModal.classList.add('hidden');
  btnSaveCredential.onclick = async () => {
    if (!credTitle.value.trim()) {
      alert('Please provide account title.');
      return;
    }
    await client.storeCredential({
      title: credTitle.value.trim(),
      username: credUsername.value.trim(),
      password: credPassword.value.trim(),
      sites: credSites.value.split(',').map((s) => s.trim()).filter(Boolean),
    });
    addCredentialModal.classList.add('hidden');
    refreshVault();
  };

  // Memory creation
  btnOpenAddMemory.onclick = () => {
    memText.value = '';
    addMemoryModal.classList.remove('hidden');
  };
  btnCloseAddMemory.onclick = () => addMemoryModal.classList.add('hidden');
  btnSaveMemory.onclick = async () => {
    if (!memText.value.trim()) {
      alert('Please provide memory text.');
      return;
    }
    await client.addMemory({
      text: memText.value.trim(),
      scope: memScope.value,
      tier: memTier.value,
    });
    addMemoryModal.classList.add('hidden');
    refreshMemories();
  };

  // --- CHAT INTERACTION CONTROLLER ---

  async function selectSession(sessionId) {
    currentSessionId = sessionId;
    activeSessionTitle.textContent = `Session: ${sessionId}`;
    messageFeed.innerHTML = '';
    welcomeBanner.classList.add('hidden');

    const history = await client.loadSession(sessionId);
    for (const msg of history) {
      appendMessage(msg.role, msg.content, msg.toolCalls);
    }
    refreshSessions();
  }

  btnNewSession.onclick = () => {
    currentSessionId = null;
    activeSessionTitle.textContent = 'New Session';
    messageFeed.innerHTML = '';
    welcomeBanner.classList.remove('hidden');
    refreshSessions();
  };

  function appendMessage(role, content, toolCalls = []) {
    welcomeBanner.classList.add('hidden');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message message-${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const body = document.createElement('div');
    body.className = 'message-body';

    if (content) {
      const textDiv = document.createElement('div');
      textDiv.className = 'message-text';
      textDiv.textContent = content;
      body.appendChild(textDiv);
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call-block';
        toolDiv.innerHTML = `
          <div class="tool-call-header">⚡ Tool: <strong>${escapeHtml(tc.function.name)}</strong></div>
          <pre class="tool-call-args">${escapeHtml(JSON.stringify(JSON.parse(tc.function.arguments || '{}'), null, 2))}</pre>
        `;
        body.appendChild(toolDiv);
      }
    }

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(body);
    messageFeed.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return body;
  }

  async function submitQuery() {
    const q = promptInput.value.trim();
    if (!q) return;

    promptInput.value = '';
    promptInput.disabled = true;
    btnSend.disabled = true;
    botStatusAvatar.textContent = '⏳';
    botStatusText.textContent = 'Thinking...';

    appendMessage('user', q);

    currentAssistantBubble = appendMessage('assistant', '');
    currentAssistantText = '';

    try {
      await client.sendQuery(q, currentSessionId, activeAgentId);
    } catch (err) {
      if (currentAssistantBubble) {
        currentAssistantBubble.innerHTML += `<div style="color: var(--danger);">Error: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      promptInput.disabled = false;
      btnSend.disabled = false;
      promptInput.focus();
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
    }
  }

  btnSend.onclick = submitQuery;
  promptInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuery();
    }
  };

  // Quick Prompt Chips
  document.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.onclick = () => {
      promptInput.value = chip.dataset.query;
      submitQuery();
    };
  });

  // Real-time Event Stream Handling
  client.onEvent((event) => {
    if (event.type === 'session_started') {
      currentSessionId = event.sessionId;
      activeSessionTitle.textContent = `Session: ${currentSessionId}`;
      refreshSessions();
    }

    if (event.type === 'text_delta') {
      if (currentAssistantBubble) {
        currentAssistantText += event.text;
        currentAssistantBubble.textContent = currentAssistantText;
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    if (event.type === 'tool_call') {
      if (currentAssistantBubble) {
        const toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call-block';
        toolDiv.innerHTML = `
          <div class="tool-call-header">⚡ Tool: <strong>${escapeHtml(event.toolCall.function.name)}</strong></div>
          <pre class="tool-call-args">${escapeHtml(JSON.stringify(JSON.parse(event.toolCall.function.arguments || '{}'), null, 2))}</pre>
        `;
        currentAssistantBubble.appendChild(toolDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    if (event.type === 'approval_required') {
      activeApprovalId = event.approvalId;
      approvalToolName.textContent = event.request.tool;
      approvalArgsBox.textContent = JSON.stringify(event.request.params, null, 2);
      approvalModal.classList.remove('hidden');
    }

    if (event.type === 'sentinel') {
      const feed = document.getElementById('sentinelFeed');
      if (feed) {
        if (feed.firstElementChild && feed.firstElementChild.textContent.includes('No diagnostic events')) {
          feed.innerHTML = '';
        }
        renderSentinelLogEntry(event.data, feed);
      }
    }
  });

  // Approvals
  btnApproveOnce.onclick = async () => {
    if (!activeApprovalId) return;
    approvalModal.classList.add('hidden');
    await client.approveTool(activeApprovalId, 'approve_once');
    activeApprovalId = null;
  };

  btnAlwaysAllow.onclick = async () => {
    if (!activeApprovalId) return;
    approvalModal.classList.add('hidden');
    await client.approveTool(activeApprovalId, 'always_allow');
    activeApprovalId = null;
  };

  btnRejectTool.onclick = async () => {
    if (!activeApprovalId) return;
    approvalModal.classList.add('hidden');
    await client.approveTool(activeApprovalId, 'reject');
    activeApprovalId = null;
  };

  // Bot creation modal
  btnOpenCreateBot.onclick = () => {
    botName.value = '';
    botRole.value = '';
    botSystemPrompt.value = '';
    botModel.value = '';
    createBotModal.classList.remove('hidden');
  };
  btnCloseCreateBot.onclick = () => createBotModal.classList.add('hidden');
  btnSaveBot.onclick = async () => {
    if (!botName.value.trim() || !botRole.value.trim()) {
      alert('Please provide bot name and role.');
      return;
    }
    await client.createAgent({
      name: botName.value.trim(),
      role: botRole.value.trim(),
      systemPrompt: botSystemPrompt.value.trim() || `You are ${botName.value}. Assist the user with ${botRole.value}.`,
      model: botModel.value.trim() || undefined,
    });
    createBotModal.classList.add('hidden');
    refreshBots();
  };

  // Task creation modal
  btnOpenCreateTask.onclick = () => {
    taskTitle.value = '';
    taskPriority.value = 'medium';
    createTaskModal.classList.remove('hidden');
  };
  btnCloseCreateTask.onclick = () => createTaskModal.classList.add('hidden');
  btnSaveTask.onclick = async () => {
    if (!taskTitle.value.trim()) return;
    await client.createTask({
      title: taskTitle.value.trim(),
      priority: taskPriority.value,
    });
    createTaskModal.classList.add('hidden');
    refreshTasks();
  };

  // Learned Rules
  btnViewLearnedRules.onclick = async () => {
    learnedRulesModal.classList.remove('hidden');
    learnedRulesContent.textContent = 'Loading learned rules...';
    const rules = await client.getLearnedRules();
    learnedRulesContent.textContent = rules.content || 'No learned rules yet.';
  };
  btnCloseLearnedRules.onclick = () => learnedRulesModal.classList.add('hidden');
  btnCloseLearnedRulesAction.onclick = () => learnedRulesModal.classList.add('hidden');
  btnRefreshLearnedRules.onclick = async () => {
    learnedRulesContent.textContent = 'Re-analyzing past conversation transcripts according to Grok Bot standards...';
    const report = await client.refreshLearnedRules();
    learnedRulesContent.textContent = report.markdownSummary || report.summary || 'Analysis complete.';
  };

  // Quick Tools
  btnQuickOcr.onclick = () => {
    promptInput.value = 'Call recognize_screen_text and extract text from the screen.';
    submitQuery();
  };
  btnQuickWindow.onclick = () => {
    promptInput.value = 'Call list_windows and show all open on-screen windows.';
    submitQuery();
  };

  // Settings
  btnSettings.onclick = async () => {
    const s = await client.getSettings();
    settingProvider.value = s.provider || 'openai';
    settingEndpoint.value = s.endpoint || '';
    settingModel.value = s.model || '';
    settingApiKey.value = s.apiKey || '';
    settingAutoApprove.checked = !!s.autoApprove;
    settingsModal.classList.remove('hidden');
  };
  btnCloseSettings.onclick = () => settingsModal.classList.add('hidden');
  btnSaveSettings.onclick = async () => {
    await client.updateSettings({
      provider: settingProvider.value,
      endpoint: settingEndpoint.value,
      model: settingModel.value,
      apiKey: settingApiKey.value,
      autoApprove: settingAutoApprove.checked,
    });
    settingsModal.classList.add('hidden');
    await refreshSettings();
  };

  // --- BTW Ephemeral Side Question Modal ---
  const btnOpenBtw = document.getElementById('btnOpenBtw');
  const btwModal = document.getElementById('btwModal');
  const btnCloseBtw = document.getElementById('btnCloseBtw');
  const btnCloseBtwDone = document.getElementById('btnCloseBtwDone');
  const btnSubmitBtw = document.getElementById('btnSubmitBtw');
  const btwQuestion = document.getElementById('btwQuestion');
  const btwAnswerContainer = document.getElementById('btwAnswerContainer');
  const btwAnswerContent = document.getElementById('btwAnswerContent');

  if (btnOpenBtw && btwModal) {
    btnOpenBtw.onclick = () => {
      btwQuestion.value = '';
      btwAnswerContainer.classList.add('hidden');
      btwAnswerContent.textContent = '';
      btnSubmitBtw.disabled = false;
      btnSubmitBtw.textContent = 'Ask Ephemeral';
      btwModal.classList.remove('hidden');
    };
    btnCloseBtw.onclick = () => btwModal.classList.add('hidden');
    btnCloseBtwDone.onclick = () => btwModal.classList.add('hidden');

    btnSubmitBtw.onclick = async () => {
      const q = btwQuestion.value.trim();
      if (!q) return;
      btnSubmitBtw.disabled = true;
      btnSubmitBtw.textContent = 'Evaluating...';
      try {
        const res = await client.askBtw(q);
        btwAnswerContent.textContent = res.answer || 'No response rendered.';
        btwAnswerContainer.classList.remove('hidden');
      } catch (err) {
        btwAnswerContent.textContent = `Error: ${err.message}`;
        btwAnswerContainer.classList.remove('hidden');
      } finally {
        btnSubmitBtw.disabled = false;
        btnSubmitBtw.textContent = 'Ask Another';
      }
    };
  }

  // --- Rollback Conversation Turns Modal ---
  const btnOpenRollback = document.getElementById('btnOpenRollback');
  const rollbackModal = document.getElementById('rollbackModal');
  const btnCloseRollback = document.getElementById('btnCloseRollback');
  const btnCloseRollbackAction = document.getElementById('btnCloseRollbackAction');
  const btnConfirmRollback = document.getElementById('btnConfirmRollback');
  const rollbackTurnCount = document.getElementById('rollbackTurnCount');
  const rollbackStatusBox = document.getElementById('rollbackStatusBox');

  if (btnOpenRollback && rollbackModal) {
    btnOpenRollback.onclick = () => {
      rollbackStatusBox.classList.add('hidden');
      rollbackStatusBox.textContent = '';
      rollbackModal.classList.remove('hidden');
    };
    btnCloseRollback.onclick = () => rollbackModal.classList.add('hidden');
    btnCloseRollbackAction.onclick = () => rollbackModal.classList.add('hidden');

    btnConfirmRollback.onclick = async () => {
      const turns = parseInt(rollbackTurnCount.value, 10) || 1;
      btnConfirmRollback.disabled = true;
      btnConfirmRollback.textContent = 'Rewinding...';
      try {
        const res = await client.rollbackTurns(turns);
        rollbackStatusBox.textContent = `Successfully rolled back ${res.removedMessages || 0} messages. Remaining in context: ${res.remainingMessages || 0}.`;
        rollbackStatusBox.classList.remove('hidden');
        if (currentSessionId) {
          await selectSession(currentSessionId);
        }
      } catch (err) {
        rollbackStatusBox.textContent = `Error: ${err.message}`;
        rollbackStatusBox.classList.remove('hidden');
      } finally {
        btnConfirmRollback.disabled = false;
        btnConfirmRollback.textContent = 'Rewind Conversation';
      }
    };
  }

  // --- Auto-Compaction Modal ---
  const btnOpenCompact = document.getElementById('btnOpenCompact');
  const compactModal = document.getElementById('compactModal');
  const btnCloseCompact = document.getElementById('btnCloseCompact');
  const btnCloseCompactAction = document.getElementById('btnCloseCompactAction');
  const btnConfirmCompact = document.getElementById('btnConfirmCompact');
  const compactKeepTurns = document.getElementById('compactKeepTurns');
  const compactResultBox = document.getElementById('compactResultBox');

  if (btnOpenCompact && compactModal) {
    btnOpenCompact.onclick = () => {
      compactResultBox.classList.add('hidden');
      compactResultBox.textContent = '';
      compactModal.classList.remove('hidden');
    };
    btnCloseCompact.onclick = () => compactModal.classList.add('hidden');
    btnCloseCompactAction.onclick = () => compactModal.classList.add('hidden');

    btnConfirmCompact.onclick = async () => {
      const keep = parseInt(compactKeepTurns.value, 10) || 2;
      btnConfirmCompact.disabled = true;
      btnConfirmCompact.textContent = 'Compacting...';
      try {
        const res = await client.compactHistory(keep);
        compactResultBox.textContent = `Auto-Compaction succeeded! Original: ~${res.originalTokens} tokens -> Compacted: ~${res.compactedTokens} tokens (condensed ${res.compactedTurnCount} turns).`;
        compactResultBox.classList.remove('hidden');
        if (currentSessionId) {
          await selectSession(currentSessionId);
        }
      } catch (err) {
        compactResultBox.textContent = `Error: ${err.message}`;
        compactResultBox.classList.remove('hidden');
      } finally {
        btnConfirmCompact.disabled = false;
        btnConfirmCompact.textContent = 'Run Auto-Compaction';
      }
    };
  }

  // --- Attachments Modal ---
  const btnOpenStageAttachment = document.getElementById('btnOpenStageAttachment');
  const stageAttachmentModal = document.getElementById('stageAttachmentModal');
  const btnCloseStageAttachment = document.getElementById('btnCloseStageAttachment');
  const btnSaveStageAttachment = document.getElementById('btnSaveStageAttachment');
  const attachmentFilePath = document.getElementById('attachmentFilePath');

  if (btnOpenStageAttachment && stageAttachmentModal) {
    btnOpenStageAttachment.onclick = () => {
      attachmentFilePath.value = '';
      stageAttachmentModal.classList.remove('hidden');
    };
    btnCloseStageAttachment.onclick = () => stageAttachmentModal.classList.add('hidden');
    btnSaveStageAttachment.onclick = async () => {
      const fp = attachmentFilePath.value.trim();
      if (!fp) {
        alert('Please specify a valid file path.');
        return;
      }
      try {
        await client.stageAttachment(fp);
        stageAttachmentModal.classList.add('hidden');
        refreshAttachments();
      } catch (err) {
        alert(`Failed to stage file: ${err.message}`);
      }
    };
  }

  // --- Template Export/Import Modals ---
  const btnOpenExportTemplate = document.getElementById('btnOpenExportTemplate');
  const exportTemplateModal = document.getElementById('exportTemplateModal');
  const btnCloseExportTemplate = document.getElementById('btnCloseExportTemplate');
  const btnGenerateExportTemplate = document.getElementById('btnGenerateExportTemplate');
  const btnCopyExportTemplate = document.getElementById('btnCopyExportTemplate');
  const selectExportBot = document.getElementById('selectExportBot');
  const exportTemplateJson = document.getElementById('exportTemplateJson');

  if (btnOpenExportTemplate && exportTemplateModal) {
    btnOpenExportTemplate.onclick = () => {
      exportTemplateModal.classList.remove('hidden');
    };
    btnCloseExportTemplate.onclick = () => exportTemplateModal.classList.add('hidden');

    btnGenerateExportTemplate.onclick = async () => {
      const botId = selectExportBot.value;
      if (!botId) return;
      const tpl = await client.exportAgentTemplate(botId);
      exportTemplateJson.textContent = JSON.stringify(tpl, null, 2);
    };

    btnCopyExportTemplate.onclick = () => {
      navigator.clipboard.writeText(exportTemplateJson.textContent);
      alert('Template JSON copied to clipboard.');
    };
  }

  const btnOpenImportTemplate = document.getElementById('btnOpenImportTemplate');
  const importTemplateModal = document.getElementById('importTemplateModal');
  const btnCloseImportTemplate = document.getElementById('btnCloseImportTemplate');
  const btnConfirmImportTemplate = document.getElementById('btnConfirmImportTemplate');
  const importTemplateJson = document.getElementById('importTemplateJson');

  if (btnOpenImportTemplate && importTemplateModal) {
    btnOpenImportTemplate.onclick = () => {
      importTemplateJson.value = '';
      importTemplateModal.classList.remove('hidden');
    };
    btnCloseImportTemplate.onclick = () => importTemplateModal.classList.add('hidden');

    btnConfirmImportTemplate.onclick = async () => {
      const raw = importTemplateJson.value.trim();
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        await client.importAgentTemplate(parsed);
        importTemplateModal.classList.add('hidden');
        refreshBots();
        refreshTemplates();
      } catch (err) {
        alert(`Invalid template JSON: ${err.message}`);
      }
    };
  }

  // --- Sentinel Watcher Creation Modal ---
  const btnOpenCreateWatcher = document.getElementById('btnOpenCreateWatcher');
  const createWatcherModal = document.getElementById('createWatcherModal');
  const btnCloseCreateWatcher = document.getElementById('btnCloseCreateWatcher');
  const btnSaveWatcher = document.getElementById('btnSaveWatcher');
  const watcherTargetDir = document.getElementById('watcherTargetDir');
  const watcherCheckCommand = document.getElementById('watcherCheckCommand');
  const watcherAutoHeal = document.getElementById('watcherAutoHeal');
  const watcherDebounce = document.getElementById('watcherDebounce');

  if (btnOpenCreateWatcher && createWatcherModal) {
    btnOpenCreateWatcher.onclick = () => {
      watcherTargetDir.value = '';
      watcherCheckCommand.value = '';
      watcherAutoHeal.checked = true;
      watcherDebounce.value = 500;
      createWatcherModal.classList.remove('hidden');
    };
    btnCloseCreateWatcher.onclick = () => createWatcherModal.classList.add('hidden');

    btnSaveWatcher.onclick = async () => {
      const targetDir = watcherTargetDir.value.trim();
      if (!targetDir) {
        alert('Please specify target directory to watch.');
        return;
      }
      await client.startWatcher({
        targetDir,
        checkCommand: watcherCheckCommand.value.trim() || undefined,
        autoHeal: watcherAutoHeal.checked,
        debounceMs: parseInt(watcherDebounce.value, 10) || 500,
      });
      createWatcherModal.classList.add('hidden');
      refreshSentinel();
    };
  }

  // Escape HTML helper
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Boot Initial Load
  await refreshSettings();
  await refreshBots();
  await refreshTasks();
  await refreshSessions();
});
