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

  // --- Boundaries API ---
  async getPolicies() {
    const res = await fetch('/api/policies');
    return res.json();
  }

  async createPolicy(rule) {
    const res = await fetch('/api/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    return res.json();
  }

  async deletePolicy(id) {
    const res = await fetch(`/api/policies/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.json();
  }

  async getPolicyAudit() {
    const res = await fetch('/api/policies/audit');
    return res.json();
  }

  // --- Webhooks API ---
  async getWebhooks() {
    const res = await fetch('/api/webhooks');
    return res.json();
  }

  async createWebhook(webhook) {
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhook),
    });
    return res.json();
  }

  async deleteWebhook(name) {
    const res = await fetch(`/api/webhooks/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return res.json();
  }

  async getWebhookDeliveries() {
    const res = await fetch('/api/webhooks/deliveries');
    return res.json();
  }

  // --- Graphs API ---
  async getGraphs() {
    const res = await fetch('/api/graphs');
    return res.json();
  }

  async runGraph(graphId, task) {
    const res = await fetch(`/api/graphs/${encodeURIComponent(graphId)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    return res.json();
  }
}

// UI Controller
document.addEventListener('DOMContentLoaded', async () => {
  const client = new OpenSandClient();

  // Navigation Tabs & Views
  const footerNavBtns = document.querySelectorAll('.footer-nav-btn');
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
    graphs: document.getElementById('viewGraphs'),
    boundaries: document.getElementById('viewBoundaries'),
    webhooks: document.getElementById('viewWebhooks'),
  };

  let currentView = 'chat';

  const viewTitles = {
    chat: '💬 Chat & Dialogue',
    graphs: '🕸️ Agent Graphs & Cyclical Loops',
    sentinel: '🛡️ Workspace Sentinel & Self-Healing',
    rooms: '👥 Multi-Agent Collaborative Rooms',
    routines: '⏱ Scheduled Background Routines',
    skills: '🧩 Modular Recipe Skills Library',
    templates: '🤖 Bots & Personas',
    boundaries: '🚧 Fail-Closed Policy Boundaries',
    vault: '🔐 Local Encrypted Secrets Vault',
    memories: '🧠 7-Layer Discrete Fact Memory',
    webhooks: '⚡ Inbound Proactive Webhooks',
    attachments: '📎 Staged Context Attachments',
  };

  function switchView(viewName) {
    currentView = viewName;

    // Update footer navigation buttons active states (OpenBot parity)
    footerNavBtns.forEach((btn) => {
      const navTarget = btn.dataset.view;
      if (navTarget === 'templates') {
        btn.classList.toggle('active', viewName === 'templates');
      } else if (navTarget === 'skills') {
        btn.classList.toggle('active', ['skills', 'memories', 'routines', 'vault'].includes(viewName));
      } else if (navTarget === 'boundaries') {
        btn.classList.toggle('active', ['boundaries', 'webhooks', 'attachments', 'graphs', 'rooms'].includes(viewName));
      }
    });

    // Update subnav tab buttons
    document.querySelectorAll('.subnav-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    // Update header title and back button
    const viewHeaderTitle = document.getElementById('viewHeaderTitle');
    const btnBackToChat = document.getElementById('btnBackToChat');
    if (btnBackToChat) {
      btnBackToChat.classList.toggle('hidden', viewName === 'chat');
    }

    if (viewHeaderTitle && viewTitles[viewName]) {
      viewHeaderTitle.textContent = viewTitles[viewName];
    }

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
    if (viewName === 'graphs') refreshGraphs();
    if (viewName === 'boundaries') refreshBoundaries();
    if (viewName === 'webhooks') refreshWebhooks();
  }

  footerNavBtns.forEach((btn) => {
    btn.onclick = () => {
      const view = btn.dataset.view;
      if (view) {
        window.location.hash = view;
        switchView(view);
      }
    };
  });

  document.querySelectorAll('.subnav-tab').forEach((tab) => {
    tab.onclick = () => {
      const view = tab.dataset.view;
      if (view) {
        window.location.hash = view;
        switchView(view);
      }
    };
  });

  const btnBackToChat = document.getElementById('btnBackToChat');
  if (btnBackToChat) {
    btnBackToChat.onclick = () => switchView('chat');
  }

  // Support direct URL query & hash navigation (?view=graphs or #graphs)
  const urlParams = new URLSearchParams(window.location.search);
  const initialView = urlParams.get('view') || window.location.hash.replace('#', '');
  if (initialView && viewPanels[initialView]) {
    switchView(initialView);
  }
  window.addEventListener('hashchange', () => {
    const h = window.location.hash.replace('#', '');
    if (h && viewPanels[h]) {
      switchView(h);
    }
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
  const badgeTokens = document.getElementById('badgeTokens');
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
  let currentAssistantMessage = null;
  let currentAssistantText = '';
  let activeToolLines = [];

  // Theme Controller
  const btnToggleTheme = document.getElementById('btnToggleTheme');
  function initTheme() {
    const saved = localStorage.getItem('opensand-theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    if (btnToggleTheme) {
      btnToggleTheme.textContent = theme === 'dark' ? '🌙' : '☀️';
      btnToggleTheme.title = `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`;
    }
  }

  if (btnToggleTheme) {
    btnToggleTheme.onclick = () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('opensand-theme', next);
      btnToggleTheme.textContent = next === 'dark' ? '🌙' : '☀️';
      btnToggleTheme.title = `Switch to ${next === 'dark' ? 'Light' : 'Dark'} Theme`;
    };
  }

  // --- REFRESH FUNCTIONS ---

  async function refreshSettings() {
    const s = await client.getSettings();
    badgeModel.textContent = s.model || 'Default';
    badgeAutoApprove.textContent = s.autoApprove ? '⚡ Auto-Approve' : '🛡 Safe Mode';
    badgeAutoApprove.className = s.autoApprove ? 'badge badge-warning' : 'badge badge-success';

    const composerModelBadge = document.getElementById('composerModelBadge');
    if (composerModelBadge) {
      composerModelBadge.textContent = s.model || 'Default';
    }
    const composerAutoApproveText = document.getElementById('composerAutoApproveText');
    if (composerAutoApproveText) {
      composerAutoApproveText.textContent = s.autoApprove ? 'Auto-Approve' : 'Safe Mode';
    }
  }

  async function refreshTokenBadge() {
    if (!badgeTokens) return;
    try {
      const res = await fetch('/api/tokens');
      if (!res.ok) return;
      const data = await res.json();
      const current = data.estimatedTokens || 0;
      const max = data.maxContextTokens || 32000;
      const pct = Math.min(100, Math.max(0, Math.round((current / max) * 100)));

      badgeTokens.textContent = `⚡ ${current.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`;
      badgeTokens.className = 'badge badge-tokens';
      if (pct > 80) {
        badgeTokens.classList.add('danger');
      } else if (pct > 50) {
        badgeTokens.classList.add('warn');
      }

      const meterBar = document.getElementById('contextMeterProgress');
      if (meterBar) {
        meterBar.style.width = `${pct}%`;
        if (pct > 80) {
          meterBar.style.backgroundColor = 'var(--danger)';
        } else if (pct > 50) {
          meterBar.style.backgroundColor = 'var(--warning)';
        } else {
          meterBar.style.backgroundColor = 'var(--accent)';
        }
      }
    } catch {
      // Ignore
    }
  }

  if (badgeTokens) {
    badgeTokens.addEventListener('click', async () => {
      const res = await fetch('/api/tokens');
      if (!res.ok) return;
      const data = await res.json();
      const confirmed = confirm(
        `Current Context Footprint:\n• Estimated Tokens: ${data.estimatedTokens.toLocaleString()} / ${data.maxContextTokens.toLocaleString()}\n• Turns: ${data.turnsCount}\n• Messages: ${data.messagesCount}\n• Tool Scoping: ${data.toolScopeMode}\n\nCompact conversation history now?`
      );
      if (confirmed) {
        await client.compactHistory(2);
        await refreshTokenBadge();
      }
    });
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

  const RELATIVE_UNITS = [
    { limit: 60_000, divisor: 1_000, unit: 'second' },
    { limit: 3_600_000, divisor: 60_000, unit: 'minute' },
    { limit: 86_400_000, divisor: 3_600_000, unit: 'hour' },
    { limit: 604_800_000, divisor: 86_400_000, unit: 'day' },
    { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: 'week' },
  ];
  const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  function relativeTime(iso) {
    if (!iso) return '';
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '';
    const elapsed = Date.now() - time;
    const scale = RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) || RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
    return relativeFormat.format(-Math.round(elapsed / scale.divisor), scale.unit);
  }

  const conversationSearchInput = document.getElementById('conversationSearchInput');

  async function refreshSessions(filterQuery = '') {
    const sessions = await client.getSessions();
    sessionList.innerHTML = '';

    const query = filterQuery || (conversationSearchInput ? conversationSearchInput.value.trim().toLowerCase() : '');
    const filtered = query
      ? sessions.filter(s => (s.title || s.id).toLowerCase().includes(query))
      : sessions;

    if (filtered.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'roster-empty';
      if (query) {
        emptyDiv.innerHTML = `
          <div class="roster-empty-title">No conversations match</div>
          <div class="roster-empty-desc">No conversation has “${escapeHtml(query)}” in its name.</div>
        `;
      } else {
        emptyDiv.innerHTML = `
          <div class="roster-empty-title">No conversations yet</div>
          <div class="roster-empty-desc">Start a conversation with a Bot and it shows up here.</div>
        `;
      }
      sessionList.appendChild(emptyDiv);
      return;
    }

    for (const s of filtered) {
      const item = document.createElement('div');
      item.className = `session-channel-item ${s.id === currentSessionId ? 'active' : ''}`;
      const timeStr = relativeTime(s.updatedAt || s.createdAt);
      const title = s.title || s.id || 'New conversation';
      const countSnippet = s.messageCount ? `${s.messageCount} messages` : 'New conversation';

      item.innerHTML = `
        <div class="channel-avatar">🤖</div>
        <div class="channel-info">
          <div class="channel-line-1">
            <span class="channel-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
            <span class="channel-time">${escapeHtml(timeStr)}</span>
          </div>
          <div class="channel-line-2">
            <span class="channel-snippet">${escapeHtml(countSnippet)}</span>
          </div>
        </div>
      `;
      item.onclick = () => selectSession(s.id);
      sessionList.appendChild(item);
    }
  }

  if (conversationSearchInput) {
    conversationSearchInput.addEventListener('input', () => {
      refreshSessions(conversationSearchInput.value.trim().toLowerCase());
    });
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

  // --- GRAPHS VIEW CONTROLLER ---
  async function refreshGraphs() {
    const grid = document.getElementById('graphsCardGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const graphs = await client.getGraphs();
    if (!Array.isArray(graphs) || graphs.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No agent graphs registered.</div>`;
      return;
    }

    for (const g of graphs) {
      const card = document.createElement('div');
      card.className = 'dashboard-card';
      const nodesBadges = (g.nodes || []).map((n) => `<span class="badge" style="background: rgba(99, 102, 241, 0.15); color: #818cf8;">${escapeHtml(n)}</span>`).join(' ➔ ');

      card.innerHTML = `
        <div class="card-top">
          <div class="card-title">🕸️ ${escapeHtml(g.name)}</div>
          <span class="badge badge-success">Cycle Limit: ${g.cycleLimit || 3}</span>
        </div>
        <div class="card-desc">${escapeHtml(g.description)}</div>
        <div class="card-meta" style="flex-wrap: wrap; gap: 4px; margin-top: 8px;">
          ${nodesBadges}
        </div>
        <div class="card-footer">
          <button class="btn btn-primary btn-xs btn-run-single-graph" data-graph-id="${escapeHtml(g.id)}">▶ Run Graph</button>
        </div>
      `;

      card.querySelector('.btn-run-single-graph').onclick = () => runGraphExecution(g.id, g.name);
      grid.appendChild(card);
    }
  }

  async function runGraphExecution(graphId, graphName) {
    const feed = document.getElementById('graphTraceFeed');
    if (!feed) return;
    feed.innerHTML = `
      <div class="sentinel-item clean">
        <div class="sentinel-header-row">
          <div><span class="status-badge warn">RUNNING</span><strong style="margin-left: 8px;">${escapeHtml(graphName || graphId)}</strong></div>
          <span style="color: var(--text-muted); font-size: 11px;">Starting cyclical state graph execution...</span>
        </div>
      </div>
    `;

    try {
      const result = await client.runGraph(graphId, 'Implement robust error-bounded worker queue with self-repair');
      feed.innerHTML = '';

      for (const ev of (result.trace || [])) {
        const item = document.createElement('div');
        const isError = ev.type === 'cycle_detected' || ev.type === 'graph_error';
        const isComplete = ev.type === 'graph_complete';
        item.className = `sentinel-item ${isError ? 'fail' : (isComplete ? 'clean' : 'warn')}`;
        const timeStr = new Date(ev.timestamp || Date.now()).toLocaleTimeString();

        let detailsHtml = '';
        if (ev.details) {
          detailsHtml = `<pre class="sentinel-output-box" style="margin-top: 6px;">${escapeHtml(typeof ev.details === 'object' ? JSON.stringify(ev.details, null, 2) : ev.details)}</pre>`;
        }

        item.innerHTML = `
          <div class="sentinel-header-row">
            <div>
              <span class="status-badge ${isError ? 'fail' : (isComplete ? 'clean' : 'warn')}">${escapeHtml(ev.type.toUpperCase())}</span>
              <strong style="margin-left: 8px;">${escapeHtml(ev.node ? `Node: ${ev.node}` : (ev.edge ? `Edge: ${ev.edge}` : 'State Transition'))}</strong>
              ${ev.step ? `<span style="color: var(--text-muted); font-size: 11px; margin-left: 6px;">(Step ${ev.step})</span>` : ''}
            </div>
            <span style="color: var(--text-muted); font-size: 11px;">${timeStr}</span>
          </div>
          ${detailsHtml}
        `;
        feed.appendChild(item);
      }

      if (result.finalState && result.finalState.finalSummary) {
        const summaryCard = document.createElement('div');
        summaryCard.className = 'sentinel-item clean';
        summaryCard.innerHTML = `
          <div class="sentinel-header-row">
            <div><span class="status-badge clean">SUMMARY</span><strong style="margin-left: 8px;">Final Output & Verification</strong></div>
          </div>
          <div class="sentinel-proposal-box" style="margin-top: 8px;">${escapeHtml(result.finalState.finalSummary)}</div>
        `;
        feed.appendChild(summaryCard);
      }
    } catch (err) {
      feed.innerHTML += `
        <div class="sentinel-item fail" style="margin-top: 8px;">
          <div class="sentinel-header-row">
            <div><span class="status-badge fail">ERROR</span><strong style="margin-left: 8px;">Execution Failure</strong></div>
          </div>
          <div class="sentinel-output-box">${escapeHtml(err.message)}</div>
        </div>
      `;
    }
  }

  const btnRunCodingGraph = document.getElementById('btnRunCodingGraph');
  if (btnRunCodingGraph) {
    btnRunCodingGraph.onclick = () => runGraphExecution('self_reflecting_coding', 'Autonomous Self-Reflecting Coding Graph');
  }

  // --- BOUNDARIES VIEW CONTROLLER ---
  async function refreshBoundaries() {
    const grid = document.getElementById('boundariesCardGrid');
    const feed = document.getElementById('boundariesAuditFeed');
    if (grid) grid.innerHTML = '';
    if (feed) feed.innerHTML = '';

    const policies = await client.getPolicies();
    const audit = await client.getPolicyAudit();

    if (!Array.isArray(policies) || policies.length === 0) {
      if (grid) grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No boundary policy rules defined. Fail-closed defaults apply.</div>`;
    } else if (grid) {
      for (const p of policies) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        const actionBadgeClass = p.action === 'DENY' ? 'badge-danger' : (p.action === 'REQUIRE_APPROVAL' ? 'badge-warning' : 'badge-success');

        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">🛡️ ${escapeHtml(p.name)}</div>
            <span class="badge ${actionBadgeClass}">${escapeHtml(p.action)}</span>
          </div>
          <div class="card-desc">${escapeHtml(p.description || 'No description.')}</div>
          <div class="card-meta">
            ${p.tools ? `<span class="badge">Tools: ${escapeHtml(p.tools.join(', '))}</span>` : ''}
            ${p.commandRegex ? `<span class="badge">Regex: ${escapeHtml(p.commandRegex)}</span>` : ''}
            ${p.pathsPrefix ? `<span class="badge">Paths: ${escapeHtml(p.pathsPrefix.join(', '))}</span>` : ''}
          </div>
          <div class="card-footer">
            <button class="btn btn-ghost btn-xs btn-delete-rule" style="color: var(--danger);">Delete Rule</button>
          </div>
        `;

        card.querySelector('.btn-delete-rule').onclick = async () => {
          if (confirm(`Delete policy rule "${p.name}"?`)) {
            await client.deletePolicy(p.id);
            refreshBoundaries();
          }
        };

        grid.appendChild(card);
      }
    }

    if (!Array.isArray(audit) || audit.length === 0) {
      if (feed) feed.innerHTML = `<div style="color: var(--text-muted); font-size: 13px;">No policy evaluations logged yet. Tool executions evaluate against fail-closed boundaries automatically.</div>`;
    } else if (feed) {
      for (const entry of audit.slice(-25).reverse()) {
        const item = document.createElement('div');
        const isDeny = entry.decision === 'DENIED';
        const isApproval = entry.decision === 'REQUIRE_APPROVAL';
        item.className = `sentinel-item ${isDeny ? 'fail' : (isApproval ? 'warn' : 'clean')}`;
        const timeStr = new Date(entry.timestamp || Date.now()).toLocaleTimeString();

        item.innerHTML = `
          <div class="sentinel-header-row">
            <div>
              <span class="status-badge ${isDeny ? 'fail' : (isApproval ? 'warn' : 'clean')}">${escapeHtml(entry.decision)}</span>
              <strong style="margin-left: 8px;">Tool: ${escapeHtml(entry.toolName)}</strong>
              ${entry.ruleName ? `<span style="color: var(--text-muted); font-size: 11px; margin-left: 6px;">(Rule: ${escapeHtml(entry.ruleName)})</span>` : ''}
            </div>
            <span style="color: var(--text-muted); font-size: 11px;">${timeStr}</span>
          </div>
          <div style="font-size: 12px; margin-top: 4px; color: ${isDeny ? '#f87171' : 'var(--text-muted)'};">${escapeHtml(entry.reason)}</div>
          ${entry.argsSummary ? `<pre class="sentinel-output-box" style="margin-top: 4px; max-height: 80px;">${escapeHtml(entry.argsSummary)}</pre>` : ''}
        `;
        feed.appendChild(item);
      }
    }
  }

  // --- WEBHOOKS VIEW CONTROLLER ---
  async function refreshWebhooks() {
    const grid = document.getElementById('webhooksCardGrid');
    const feed = document.getElementById('webhooksDeliveriesFeed');
    if (grid) grid.innerHTML = '';
    if (feed) feed.innerHTML = '';

    const webhooks = await client.getWebhooks();
    const deliveries = await client.getWebhookDeliveries();

    if (!Array.isArray(webhooks) || webhooks.length === 0) {
      if (grid) grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No inbound webhooks configured. Click "+ New Webhook" to register an HTTP trigger.</div>`;
    } else if (grid) {
      for (const w of webhooks) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        const hookUrl = `${window.location.origin}/api/webhooks/${encodeURIComponent(w.name)}`;

        card.innerHTML = `
          <div class="card-top">
            <div class="card-title">⚡ ${escapeHtml(w.name)}</div>
            <span class="badge badge-success">Triggers: ${w.triggerCount || 0}</span>
          </div>
          <div class="card-desc"><strong>Target:</strong> ${escapeHtml(w.targetType.toUpperCase())} ➔ ${escapeHtml(w.targetId)}</div>
          <div class="card-meta">
            <span class="badge">Auth: ${w.hasSecret ? 'HMAC-SHA256' : 'Open'}</span>
            ${w.filterEvent ? `<span class="badge">Event: ${escapeHtml(w.filterEvent)}</span>` : ''}
          </div>
          <div class="sentinel-output-box" style="font-size: 11px; margin-top: 8px; user-select: all;">${escapeHtml(hookUrl)}</div>
          <div class="card-footer" style="margin-top: 8px;">
            <button class="btn btn-secondary btn-xs btn-copy-curl">Copy curl</button>
            <button class="btn btn-ghost btn-xs btn-delete-webhook" style="color: var(--danger);">Delete</button>
          </div>
        `;

        card.querySelector('.btn-copy-curl').onclick = () => {
          const curl = `curl -X POST "${hookUrl}" -H "Content-Type: application/json" -d '{"event":"trigger","data":{"action":"run"}}'`;
          navigator.clipboard.writeText(curl);
          alert('Webhook cURL copied to clipboard.');
        };

        card.querySelector('.btn-delete-webhook').onclick = async () => {
          if (confirm(`Delete webhook "${w.name}"?`)) {
            await client.deleteWebhook(w.name);
            refreshWebhooks();
          }
        };

        grid.appendChild(card);
      }
    }

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      if (feed) feed.innerHTML = `<div style="color: var(--text-muted); font-size: 13px;">No webhook deliveries received yet. Post HTTP requests to your webhook URLs to trigger actions.</div>`;
    } else if (feed) {
      for (const d of deliveries.slice(-25).reverse()) {
        const item = document.createElement('div');
        const isSuccess = d.status === 'success';
        item.className = `sentinel-item ${isSuccess ? 'clean' : 'fail'}`;
        const timeStr = new Date(d.timestamp || Date.now()).toLocaleTimeString();

        item.innerHTML = `
          <div class="sentinel-header-row">
            <div>
              <span class="status-badge ${isSuccess ? 'clean' : 'fail'}">${escapeHtml(d.status.toUpperCase())}</span>
              <strong style="margin-left: 8px;">Webhook: ${escapeHtml(d.webhookName)}</strong>
              ${d.durationMs !== undefined ? `<span style="color: var(--text-muted); font-size: 11px; margin-left: 6px;">(${d.durationMs}ms)</span>` : ''}
            </div>
            <span style="color: var(--text-muted); font-size: 11px;">${timeStr}</span>
          </div>
          ${d.error ? `<div style="color: #f87171; font-size: 12px; margin-top: 4px;">Error: ${escapeHtml(d.error)}</div>` : ''}
          ${d.result ? `<pre class="sentinel-output-box" style="margin-top: 4px; max-height: 80px;">${escapeHtml(typeof d.result === 'object' ? JSON.stringify(d.result, null, 2) : d.result)}</pre>` : ''}
        `;
        feed.appendChild(item);
      }
    }
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

  // Markdown & Thinking Renderer (OpenBot parity)
  function renderMarkdown(rawText) {
    if (!rawText) return '';

    let content = rawText;

    // 1. Extract <thinking> tags (both closed and unclosed streaming)
    content = content.replace(/<thinking>([\s\S]*?)(?:<\/thinking>|$)/gi, (match, thoughtText) => {
      const trimmed = thoughtText.trim();
      if (!trimmed) return '';
      return `\n<div class="thought-accordion">
  <div class="thought-header">
    <span class="thought-toggle">▶</span>
    <span class="thought-icon">💭</span>
    <span class="thought-label">Thinking Process</span>
  </div>
  <div class="thought-body hidden">${escapeHtml(trimmed)}</div>
</div>\n`;
    });

    // 2. Fenced code blocks ```lang\ncode\n```
    const codeBlocks = [];
    content = content.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const idx = codeBlocks.length;
      const cleanLang = (lang || '').trim() || 'text';
      const cleanCode = code.replace(/\n$/, '');
      const safeCode = escapeHtml(cleanCode);
      codeBlocks.push(`
<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang">${cleanLang}</span>
    <button class="btn-copy-code" type="button" data-code="${escapeHtml(cleanCode)}">Copy</button>
  </div>
  <pre><code class="language-${cleanLang}">${safeCode}</code></pre>
</div>`);
      return `\n%%CODE_BLOCK_${idx}%%\n`;
    });

    // 3. Inline code `code`
    content = content.replace(/`([^`\n]+)`/g, (match, inlineCode) => {
      return `<code>${escapeHtml(inlineCode)}</code>`;
    });

    // 4. Headings (###, ##, #)
    content = content.replace(/^### (.*$)/gim, '<h4>$1</h4>');
    content = content.replace(/^## (.*$)/gim, '<h3>$1</h3>');
    content = content.replace(/^# (.*$)/gim, '<h2>$1</h2>');

    // 5. Blockquotes (> quote)
    content = content.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

    // 6. Bold & Italics
    content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    content = content.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 7. Unordered lists (- item or * item)
    content = content.replace(/^\s*[-*]\s+(.*)$/gim, '<li>$1</li>');
    content = content.replace(/(<li>.*<\/li>)/gms, '<ul>$1</ul>');
    content = content.replace(/<\/ul>\s*<ul>/g, '');

    // 8. Markdown links [text](url)
    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // 9. Line breaks: replace double newlines with paragraphs, single with <br>
    content = content.replace(/\n{2,}/g, '</p><p>');
    content = content.replace(/\n/g, '<br>');
    content = `<p>${content}</p>`;

    // Clean empty paragraphs and wrappers around block elements
    content = content.replace(/<p>\s*<\/p>/g, '');
    content = content.replace(/<p>\s*(<div class="thought-accordion">[\s\S]*?<\/div>)\s*<\/p>/g, '$1');
    content = content.replace(/<p>\s*(<h2>.*?<\/h2>|<h3>.*?<\/h3>|<h4>.*?<\/h4>|<blockquote>.*?<\/blockquote>|<ul>.*?<\/ul>)\s*<\/p>/g, '$1');

    // 10. Re-insert code blocks
    codeBlocks.forEach((blockHtml, i) => {
      content = content.replace(new RegExp(`<p>\\s*%%CODE_BLOCK_${i}%%\\s*<\\/p>|%%CODE_BLOCK_${i}%%`, 'g'), blockHtml);
    });

    return content;
  }

  // Tool Line Rhythm Component (OpenBot parity)
  function inferToolIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('file') || n.includes('dir') || n.includes('artifact') || n.includes('source') || n.includes('patch')) return '📄';
    if (n.includes('cmd') || n.includes('command') || n.includes('exec') || n.includes('bash') || n.includes('shell') || n.includes('rizin')) return '💻';
    if (n.includes('search') || n.includes('grep') || n.includes('find') || n.includes('bytes') || n.includes('strings') || n.includes('xrefs')) return '🔍';
    if (n.includes('web') || n.includes('browser') || n.includes('fetch') || n.includes('curl') || n.includes('network') || n.includes('packet')) return '🌐';
    if (n.includes('agent') || n.includes('task') || n.includes('routine') || n.includes('room') || n.includes('sentinel') || n.includes('memory') || n.includes('vault')) return '🤖';
    if (n.includes('ocr') || n.includes('window') || n.includes('screen') || n.includes('display')) return '👁️';
    return '⚡';
  }

  function formatToolName(name) {
    if (!name) return 'Tool Execution';
    return name
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function extractToolDetail(args) {
    if (!args || typeof args !== 'object') return '';
    if (args.CommandLine) return args.CommandLine;
    if (args.command) return args.command;
    if (args.cmd) return args.cmd;
    if (args.Path) return args.Path;
    if (args.path) return args.path;
    if (args.filePath) return args.filePath;
    if (args.query) return args.query;
    if (args.pattern) return args.pattern;
    if (args.url) return args.url;
    if (args.topic) return args.topic;
    if (args.title) return args.title;
    if (args.tool) return args.tool;

    const firstKey = Object.keys(args)[0];
    if (firstKey) {
      const val = typeof args[firstKey] === 'string' ? args[firstKey] : JSON.stringify(args[firstKey]);
      return `${firstKey}: ${val}`;
    }
    return '';
  }

  function createToolLineElement(toolCall, status = 'running', result = null) {
    const name = toolCall.function?.name || toolCall.name || 'tool';
    let args = {};
    try {
      if (typeof toolCall.function?.arguments === 'string') {
        args = JSON.parse(toolCall.function.arguments);
      } else if (toolCall.args) {
        args = toolCall.args;
      }
    } catch {
      args = { raw: toolCall.function?.arguments || toolCall.args };
    }

    const icon = inferToolIcon(name);
    const label = formatToolName(name);
    const detail = extractToolDetail(args);

    const isRunning = status === 'running';
    const isError = status === 'error' || status === 'failed';
    const badgeText = isRunning ? 'Running' : isError ? 'Failed' : 'Done';
    const badgeClass = isRunning ? 'badge-running' : isError ? 'badge-error' : 'badge-done';

    const div = document.createElement('div');
    div.className = `tool-line ${isRunning ? 'tool-line-running' : ''}`;
    div.dataset.toolName = name;

    div.innerHTML = `
      <div class="tool-line-header">
        <span class="tool-line-toggle">▶</span>
        <span class="tool-line-icon">${icon}</span>
        <span class="tool-line-label">${escapeHtml(label)}</span>
        <span class="tool-line-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
        <span class="tool-line-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="tool-line-details hidden">
        <div class="tool-details-header">Parameters:</div>
        <pre class="tool-details-pre">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
        ${result !== null && result !== undefined ? `
          <div class="tool-details-header" style="margin-top: 8px;">Output Result:</div>
          <pre class="tool-details-pre tool-result-pre">${escapeHtml(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}</pre>
        ` : ''}
      </div>
    `;

    return div;
  }

  function updateToolLineStatus(toolEl, status, result) {
    if (!toolEl) return;
    toolEl.classList.remove('tool-line-running');
    const badge = toolEl.querySelector('.tool-line-badge');
    if (badge) {
      const isError = status === 'error' || status === 'failed';
      badge.textContent = isError ? 'Failed' : 'Done';
      badge.className = `tool-line-badge ${isError ? 'badge-error' : 'badge-done'}`;
    }
    if (result !== undefined && result !== null) {
      const details = toolEl.querySelector('.tool-line-details');
      if (details) {
        let resultPre = details.querySelector('.tool-result-pre');
        if (!resultPre) {
          const outHeader = document.createElement('div');
          outHeader.className = 'tool-details-header';
          outHeader.style.marginTop = '8px';
          outHeader.textContent = 'Output Result:';
          resultPre = document.createElement('pre');
          resultPre.className = 'tool-details-pre tool-result-pre';
          details.appendChild(outHeader);
          details.appendChild(resultPre);
        }
        resultPre.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      }
    }
  }

  // Delegated interactions for Code Copy, Thinking Accordion, and Tool Details
  chatContainer.addEventListener('click', (e) => {
    // 1. Copy code button
    const copyBtn = e.target.closest('.btn-copy-code');
    if (copyBtn) {
      e.stopPropagation();
      const codeBlock = copyBtn.closest('.code-block-wrapper');
      const codeText = copyBtn.dataset.code || (codeBlock ? codeBlock.querySelector('code')?.textContent : '');
      if (codeText) {
        navigator.clipboard.writeText(codeText).then(() => {
          copyBtn.textContent = '✓ Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 1500);
        }).catch(() => {
          copyBtn.textContent = 'Failed';
        });
      }
      return;
    }

    // 2. Thought accordion toggle
    const thoughtHeader = e.target.closest('.thought-header');
    if (thoughtHeader) {
      e.stopPropagation();
      const accordion = thoughtHeader.closest('.thought-accordion');
      const body = accordion ? accordion.querySelector('.thought-body') : null;
      const toggle = thoughtHeader.querySelector('.thought-toggle');
      if (body) {
        const isHidden = body.classList.toggle('hidden');
        if (toggle) toggle.textContent = isHidden ? '▶' : '▼';
      }
      return;
    }

    // 3. Tool line details toggle
    const toolHeader = e.target.closest('.tool-line-header');
    if (toolHeader) {
      e.stopPropagation();
      const toolLine = toolHeader.closest('.tool-line');
      const details = toolLine ? toolLine.querySelector('.tool-line-details') : null;
      const toggle = toolHeader.querySelector('.tool-line-toggle');
      if (details) {
        const isHidden = details.classList.toggle('hidden');
        if (toggle) toggle.textContent = isHidden ? '▶' : '▼';
      }
      return;
    }
  });

  async function selectSession(sessionId) {
    currentSessionId = sessionId;
    switchView('chat');
    activeSessionTitle.textContent = `Session: ${sessionId}`;
    messageFeed.innerHTML = '';
    welcomeBanner.classList.add('hidden');

    const history = await client.loadSession(sessionId);
    for (const msg of history) {
      appendMessage(msg.role, msg.content, msg.toolCalls);
    }
    refreshSessions();
  }

  function startNewSession() {
    currentSessionId = null;
    activeSessionTitle.textContent = 'New Session';
    messageFeed.innerHTML = '';
    welcomeBanner.classList.remove('hidden');
    switchView('chat');
    refreshSessions();
    if (promptInput) {
      promptInput.value = '';
      promptInput.focus();
    }
  }

  btnNewSession.onclick = startNewSession;
  const brandHomeBtn = document.getElementById('brandHomeBtn');
  if (brandHomeBtn) {
    brandHomeBtn.onclick = startNewSession;
  }

  // Account Popup Menu Wiring (OpenBot Parity)
  const accountMenuTrigger = document.getElementById('accountMenuTrigger');
  const accountPopup = document.getElementById('accountPopup');
  if (accountMenuTrigger && accountPopup) {
    accountMenuTrigger.onclick = (e) => {
      e.stopPropagation();
      accountPopup.classList.toggle('hidden');
    };
    document.addEventListener('click', (e) => {
      if (!accountPopup.contains(e.target) && e.target !== accountMenuTrigger) {
        accountPopup.classList.add('hidden');
      }
    });
  }

  const btnMenuSentinel = document.getElementById('btnMenuSentinel');
  if (btnMenuSentinel) {
    btnMenuSentinel.onclick = () => {
      if (accountPopup) accountPopup.classList.add('hidden');
      switchView('sentinel');
    };
  }

  const btnMenuSettings = document.getElementById('btnMenuSettings');
  if (btnMenuSettings) {
    btnMenuSettings.onclick = () => {
      if (accountPopup) accountPopup.classList.add('hidden');
      btnSettings.click();
    };
  }

  const btnMenuToggleTheme = document.getElementById('btnMenuToggleTheme');
  if (btnMenuToggleTheme) {
    btnMenuToggleTheme.onclick = () => {
      if (accountPopup) accountPopup.classList.add('hidden');
      btnToggleTheme.click();
    };
  }

  const btnMenuClearSessions = document.getElementById('btnMenuClearSessions');
  if (btnMenuClearSessions) {
    btnMenuClearSessions.onclick = () => {
      if (accountPopup) accountPopup.classList.add('hidden');
      startNewSession();
    };
  }

  function appendMessage(role, content, toolCalls = []) {
    welcomeBanner.classList.add('hidden');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message message-${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const body = document.createElement('div');
    body.className = 'message-body';

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    const toolsEl = document.createElement('div');
    toolsEl.className = 'message-tools-container';

    if (content) {
      if (role === 'user') {
        contentEl.textContent = content;
      } else {
        contentEl.innerHTML = renderMarkdown(content);
      }
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const toolEl = createToolLineElement(tc, 'done');
        toolsEl.appendChild(toolEl);
      }
    }

    body.appendChild(contentEl);
    body.appendChild(toolsEl);

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(body);
    messageFeed.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    return { msgDiv, body, contentEl, toolsEl };
  }

  async function submitQuery() {
    const q = promptInput.value.trim();
    if (!q) return;

    promptInput.value = '';
    promptInput.style.height = 'auto';
    promptInput.disabled = true;
    btnSend.disabled = true;
    botStatusAvatar.textContent = '⏳';
    botStatusText.textContent = 'Thinking...';

    appendMessage('user', q);

    currentAssistantMessage = appendMessage('assistant', '');
    currentAssistantText = '';
    activeToolLines = [];

    try {
      await client.sendQuery(q, currentSessionId, activeAgentId);
    } catch (err) {
      if (currentAssistantMessage) {
        currentAssistantMessage.contentEl.innerHTML += `<div style="color: var(--danger); margin-top: 8px;">Error: ${escapeHtml(err.message)}</div>`;
      }
    } finally {
      promptInput.disabled = false;
      btnSend.disabled = false;
      promptInput.focus();
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
      refreshTokenBadge();
    }
  }

  btnSend.onclick = submitQuery;

  // Auto-resize composer textarea
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(220, promptInput.scrollHeight) + 'px';
  });

  // Keyboard shortcut: Cmd/Ctrl+Enter or Enter sends
  promptInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey || !e.shiftKey) {
        e.preventDefault();
        submitQuery();
      }
    }
  };

  // Composer Attach Button & Safe Mode Toggle
  const btnStageFile = document.getElementById('btnStageFile');
  const fileAttachmentInput = document.getElementById('fileAttachmentInput');
  if (btnStageFile && fileAttachmentInput) {
    btnStageFile.onclick = () => fileAttachmentInput.click();
    fileAttachmentInput.onchange = async () => {
      const file = fileAttachmentInput.files && fileAttachmentInput.files[0];
      if (!file) return;
      try {
        const filePath = file.path || file.name;
        await client.stageAttachment(filePath);
        await refreshAttachments();
        alert(`File "${file.name}" staged successfully.`);
      } catch (err) {
        alert(`Error staging attachment: ${err.message}`);
      } finally {
        fileAttachmentInput.value = '';
      }
    };
  }

  const btnToggleSafeMode = document.getElementById('btnToggleSafeMode');
  if (btnToggleSafeMode) {
    btnToggleSafeMode.onclick = async () => {
      try {
        const s = await client.getSettings();
        const nextAutoApprove = !s.autoApprove;
        await client.updateSettings({ autoApprove: nextAutoApprove });
        await refreshSettings();
      } catch (err) {
        console.error('Error toggling safe mode:', err);
      }
    };
  }

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

    // Token delta stream
    if (event.type === 'token' || event.type === 'text_delta') {
      const delta = event.data?.token || event.token || event.text || '';
      if (delta && currentAssistantMessage) {
        currentAssistantText += delta;
        currentAssistantMessage.contentEl.innerHTML = renderMarkdown(currentAssistantText);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    // Thought delta stream
    if (event.type === 'thought') {
      const thought = event.data?.thought || event.thought || '';
      if (thought && currentAssistantMessage) {
        currentAssistantText = `<thinking>${thought}</thinking>\n` + currentAssistantText;
        currentAssistantMessage.contentEl.innerHTML = renderMarkdown(currentAssistantText);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    // Tool call started
    if (event.type === 'tool_call') {
      if (currentAssistantMessage) {
        const toolCall = event.data || event.toolCall || event;
        const toolEl = createToolLineElement(toolCall, 'running');
        currentAssistantMessage.toolsEl.appendChild(toolEl);
        activeToolLines.push(toolEl);
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }

    // Tool call completed
    if (event.type === 'tool_result') {
      const toolName = event.data?.name || event.name;
      const result = event.data?.result !== undefined ? event.data.result : event.result;
      const targetEl = activeToolLines.find(el => el.classList.contains('tool-line-running') && (!toolName || el.dataset.toolName === toolName))
        || activeToolLines.find(el => el.classList.contains('tool-line-running'))
        || (currentAssistantMessage && currentAssistantMessage.toolsEl.querySelector('.tool-line-running'));
      if (targetEl) {
        updateToolLineStatus(targetEl, 'done', result);
      }
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Turn completed
    if (event.type === 'turn_complete') {
      if (currentAssistantMessage) {
        const runningLines = currentAssistantMessage.toolsEl.querySelectorAll('.tool-line-running');
        runningLines.forEach((el) => updateToolLineStatus(el, 'done'));

        const response = event.data?.response || event.response;
        if (response && !currentAssistantText.trim()) {
          currentAssistantText = response;
          currentAssistantMessage.contentEl.innerHTML = renderMarkdown(currentAssistantText);
        }
      }
      refreshTokenBadge();
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // Approval required
    if (event.type === 'approval_required') {
      activeApprovalId = event.approvalId || event.data?.approvalId;
      const req = event.request || event.data?.request || {};
      approvalToolName.textContent = req.tool || event.data?.toolName || 'Tool';
      approvalArgsBox.textContent = JSON.stringify(req.params || req.args || event.data?.args || {}, null, 2);
      approvalModal.classList.remove('hidden');
    }

    // Sentinel diagnostic log
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

  // --- Boundary Policy Modal ---
  const btnOpenCreateRule = document.getElementById('btnOpenCreateRule');
  const createRuleModal = document.getElementById('createRuleModal');
  const btnCloseCreateRule = document.getElementById('btnCloseCreateRule');
  const btnSaveRule = document.getElementById('btnSaveRule');
  const ruleName = document.getElementById('ruleName');
  const ruleAction = document.getElementById('ruleAction');
  const ruleTool = document.getElementById('ruleTool');
  const ruleCommandRegex = document.getElementById('ruleCommandRegex');
  const rulePathPrefix = document.getElementById('rulePathPrefix');
  const ruleDesc = document.getElementById('ruleDesc');

  if (btnOpenCreateRule && createRuleModal) {
    btnOpenCreateRule.onclick = () => {
      ruleName.value = '';
      ruleAction.value = 'DENY';
      ruleTool.value = '';
      ruleCommandRegex.value = '';
      rulePathPrefix.value = '';
      ruleDesc.value = '';
      createRuleModal.classList.remove('hidden');
    };
    btnCloseCreateRule.onclick = () => createRuleModal.classList.add('hidden');

    btnSaveRule.onclick = async () => {
      const name = ruleName.value.trim();
      if (!name) {
        alert('Please specify a rule name.');
        return;
      }
      const tools = ruleTool.value.trim() ? ruleTool.value.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
      const pathsPrefix = rulePathPrefix.value.trim() ? rulePathPrefix.value.split(',').map((p) => p.trim()).filter(Boolean) : undefined;
      const commandRegex = ruleCommandRegex.value.trim() || undefined;

      await client.createPolicy({
        id: `rule_${Date.now()}`,
        name,
        action: ruleAction.value,
        tools,
        commandRegex,
        pathsPrefix,
        description: ruleDesc.value.trim() || undefined,
        enabled: true,
      });

      createRuleModal.classList.add('hidden');
      refreshBoundaries();
    };
  }

  // --- Webhook Modal ---
  const btnOpenCreateWebhook = document.getElementById('btnOpenCreateWebhook');
  const createWebhookModal = document.getElementById('createWebhookModal');
  const btnCloseCreateWebhook = document.getElementById('btnCloseCreateWebhook');
  const btnSaveWebhook = document.getElementById('btnSaveWebhook');
  const webhookName = document.getElementById('webhookName');
  const webhookTargetType = document.getElementById('webhookTargetType');
  const webhookTargetId = document.getElementById('webhookTargetId');
  const webhookSecret = document.getElementById('webhookSecret');
  const webhookFilterEvent = document.getElementById('webhookFilterEvent');

  if (btnOpenCreateWebhook && createWebhookModal) {
    btnOpenCreateWebhook.onclick = () => {
      webhookName.value = '';
      webhookTargetType.value = 'routine';
      webhookTargetId.value = '';
      webhookSecret.value = '';
      webhookFilterEvent.value = '';
      createWebhookModal.classList.remove('hidden');
    };
    btnCloseCreateWebhook.onclick = () => createWebhookModal.classList.add('hidden');

    btnSaveWebhook.onclick = async () => {
      const name = webhookName.value.trim();
      const targetId = webhookTargetId.value.trim();
      if (!name || !targetId) {
        alert('Please specify webhook slug name and target ID.');
        return;
      }
      await client.createWebhook({
        name,
        targetType: webhookTargetType.value,
        targetId,
        secret: webhookSecret.value.trim() || undefined,
        filterEvent: webhookFilterEvent.value.trim() || undefined,
        enabled: true,
      });

      createWebhookModal.classList.add('hidden');
      refreshWebhooks();
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
  initTheme();
  await refreshSettings();
  await refreshBots();
  await refreshTasks();
  await refreshSessions();
  await refreshTokenBadge();
});
