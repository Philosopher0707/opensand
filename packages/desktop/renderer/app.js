/**
 * OpenSand Desktop Renderer Application Controller
 * Universal Multi-Agent & Orchestrator UI
 */
import { renderMarkdown, renderMarkdownCached, escapeHtml } from './modules/chat/markdown.js';
import { createApprovalQueue } from './modules/chat/approval-queue.js';
import { createArtifactCanvas } from './modules/chat/canvas.js';

// Dual-mode backend client: native Electron IPC or local HTTP/SSE
class OpenSandClient {
  constructor() {
    this.isElectron = typeof window.opensand !== 'undefined';
    this.listeners = new Set();
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token') || (typeof window.__OPENSAND_AUTH_TOKEN__ !== 'undefined' ? window.__OPENSAND_AUTH_TOKEN__ : '');
    if (token) {
      sessionStorage.setItem('opensand_token', token);
      if (urlParams.has('token') && window.history && typeof window.history.replaceState === 'function') {
        urlParams.delete('token');
        const cleanSearch = urlParams.toString();
        const cleanUrl = window.location.pathname + (cleanSearch ? '?' + cleanSearch : '') + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);
      }
    }
    this.token = token || sessionStorage.getItem('opensand_token') || '';

    if (this.token && typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      const currentToken = this.token;
      window.fetch = function (input, init = {}) {
        init = { ...init };
        if (init.headers instanceof Headers) {
          if (!init.headers.has('Authorization')) {
            init.headers.set('Authorization', `Bearer ${currentToken}`);
          }
        } else if (Array.isArray(init.headers)) {
          if (!init.headers.some(([k]) => k.toLowerCase() === 'authorization')) {
            init.headers.push(['Authorization', `Bearer ${currentToken}`]);
          }
        } else {
          init.headers = { ...init.headers };
          if (!init.headers['Authorization'] && !init.headers['authorization']) {
            init.headers['Authorization'] = `Bearer ${currentToken}`;
          }
        }
        return origFetch(input, init);
      };
    }

    if (this.isElectron) {
      window.opensand.onEvent((event) => this.dispatch(event));
    } else {
      this.initSse();
    }
  }

  initSse() {
    const sseUrl = this.token ? `/api/events?token=${encodeURIComponent(this.token)}` : '/api/events';
    const sse = new EventSource(sseUrl);
    sse.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        this.dispatch(event);
      } catch {
        // Ignore parse error
      }
    };
    sse.onerror = () => {
      // If server connection drops while turnBusy was true, verify server health
      if (typeof turnBusy !== 'undefined' && turnBusy) {
        fetch('/api/settings').then((res) => {
          if (res.ok && typeof forceResetTurnState === 'function') {
            forceResetTurnState('Connection re-established with server.');
          }
        }).catch(() => {});
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

  async cancelTurn() {
    if (this.isElectron && window.opensand?.cancelTurn) {
      return window.opensand.cancelTurn();
    }
    const res = await fetch('/api/cancel', { method: 'POST' });
    return res.json();
  }

  async approveTool(approvalId, decision) {
    // Normalize string decisions from legacy callers to the {action} contract
    const payload = typeof decision === 'string' ? { action: decision } : decision;
    if (this.isElectron) {
      return window.opensand.approveTool(approvalId, payload);
    }
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, decision: payload }),
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
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Failed to load session (HTTP ${res.status})`);
    }
    return data;
  }

  async deleteSession(sessionId) {
    if (this.isElectron && window.opensand?.deleteSession) {
      return window.opensand.deleteSession(sessionId);
    }
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    return res.json();
  }

  async clearAllSessions() {
    if (this.isElectron && window.opensand?.clearAllSessions) {
      return window.opensand.clearAllSessions();
    }
    const res = await fetch('/api/sessions', { method: 'DELETE' });
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

  async getTokenTelemetry(agentId, sessionId) {
    if (this.isElectron && window.opensand?.getTokenTelemetry) {
      return window.opensand.getTokenTelemetry(agentId, sessionId);
    }
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (sessionId) params.set('sessionId', sessionId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`/api/tokens${qs}`);
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

  async deleteAgent(id) {
    if (this.isElectron && window.opensand?.deleteAgent) {
      return window.opensand.deleteAgent(id);
    }
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  // --- 3rd-Party OAuth Connectors (Slack, Linear, GitHub App) ---
  async getConnectors() {
    const res = await fetch('/api/connectors');
    return res.json();
  }

  async getConnector(id) {
    const res = await fetch(`/api/connectors/${id}`);
    return res.json();
  }

  async connectApp(id, data = {}) {
    const res = await fetch(`/api/connectors/${id}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  }

  async disconnectApp(id) {
    const res = await fetch(`/api/connectors/${id}/disconnect`, {
      method: 'POST',
    });
    return res.json();
  }

  async testConnector(id) {
    const res = await fetch(`/api/connectors/${id}/test`, {
      method: 'POST',
    });
    return res.json();
  }

  // --- Community Agent Store & Template Gallery ---
  async getGalleryTemplates(params = {}) {
    const q = new URLSearchParams();
    if (params.category && params.category !== 'all') q.set('category', params.category);
    if (params.query) q.set('query', params.query);
    const qs = q.toString() ? `?${q.toString()}` : '';
    const res = await fetch(`/api/gallery/templates${qs}`);
    return res.json();
  }

  async getGalleryTemplate(id) {
    const res = await fetch(`/api/gallery/templates/${encodeURIComponent(id)}`);
    return res.json();
  }

  async installGalleryTemplate(id) {
    const res = await fetch(`/api/gallery/templates/${encodeURIComponent(id)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return res.json();
  }

  async publishGalleryTemplate(data) {
    const res = await fetch('/api/gallery/templates/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
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
    gallery: document.getElementById('viewGallery'),
    sentinel: document.getElementById('viewSentinel'),
    graphs: document.getElementById('viewGraphs'),
    boundaries: document.getElementById('viewBoundaries'),
    webhooks: document.getElementById('viewWebhooks'),
    connectors: document.getElementById('viewConnectors'),
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
    gallery: '🏪 Community Agent Store & Template Gallery',
    boundaries: '🚧 Fail-Closed Policy Boundaries',
    vault: '🔐 Local Encrypted Secrets Vault',
    memories: '🧠 7-Layer Discrete Fact Memory',
    webhooks: '⚡ Inbound Proactive Webhooks',
    attachments: '📎 Staged Context Attachments',
    connectors: '🔌 3rd-Party App OAuth Connectors',
  };

  function switchView(viewName) {
    currentView = viewName;

    // Update footer navigation buttons active states (OpenBot parity)
    footerNavBtns.forEach((btn) => {
      const navTarget = btn.dataset.view;
      if (navTarget === 'templates') {
        btn.classList.toggle('active', ['templates', 'gallery'].includes(viewName));
      } else if (navTarget === 'skills') {
        btn.classList.toggle('active', ['skills', 'memories', 'routines', 'vault'].includes(viewName));
      } else if (navTarget === 'boundaries') {
        btn.classList.toggle('active', ['boundaries', 'webhooks', 'connectors', 'attachments', 'graphs', 'rooms'].includes(viewName));
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
    if (viewName === 'gallery') refreshGallery();
    if (viewName === 'sentinel') refreshSentinel();
    if (viewName === 'graphs') refreshGraphs();
    if (viewName === 'boundaries') refreshBoundaries();
    if (viewName === 'webhooks') refreshWebhooks();
    if (viewName === 'connectors') refreshConnectors();
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

  // Floating Composer & Detail Inspector Elements (OpenBot / Grok Bot Parity)
  const inputWrapper = document.getElementById('inputWrapper');
  const attachmentStrip = document.getElementById('attachmentStrip');
  const triggerPopover = document.getElementById('triggerPopover');
  const btnDictate = document.getElementById('btnDictate');
  const btnToggleDetail = document.getElementById('btnToggleDetail');
  const detailPanel = document.getElementById('detailPanel');
  const btnCloseDetail = document.getElementById('btnCloseDetail');
  const detailBotAvatar = document.getElementById('detailBotAvatar');
  const detailBotName = document.getElementById('detailBotName');
  const detailBotRole = document.getElementById('detailBotRole');
  const detailBotModelCode = document.getElementById('detailBotModelCode');
  const detailBotPromptPreview = document.getElementById('detailBotPromptPreview');
  const detailTokensUsed = document.getElementById('detailTokensUsed');
  const detailMeterFill = document.getElementById('detailMeterFill');
  const detailTokensMax = document.getElementById('detailTokensMax');
  const detailTokensPct = document.getElementById('detailTokensPct');
  const detailMemoriesList = document.getElementById('detailMemoriesList');
  const detailSkillsTags = document.getElementById('detailSkillsTags');
  const btnDetailRewind = document.getElementById('btnDetailRewind');
  const btnDetailCompact = document.getElementById('btnDetailCompact');
  const btnDetailExportBot = document.getElementById('btnDetailExportBot');
  const btnDetailClear = document.getElementById('btnDetailClear');

  // Artifact Canvas Elements (Side-by-Side Split View Parity)
  const btnToggleCanvas = document.getElementById('btnToggleCanvas');
  const artifactCanvasEl = document.getElementById('artifactCanvas');
  const artifactCanvas = createArtifactCanvas({
    canvasEl: artifactCanvasEl,
    iconEl: document.getElementById('canvasIcon'),
    titleEl: document.getElementById('canvasTitle'),
    tabStripEl: document.getElementById('canvasTabStrip'),
    badgeEl: document.getElementById('canvasTypeBadge'),
    tabCodeBtn: document.getElementById('canvasTabCode'),
    tabPreviewBtn: document.getElementById('canvasTabPreview'),
    tabDiffBtn: document.getElementById('canvasTabDiff'),
    codePaneEl: document.getElementById('canvasCodePane'),
    previewPaneEl: document.getElementById('canvasPreviewPane'),
    diffPaneEl: document.getElementById('canvasDiffPane'),
    codeContentEl: document.getElementById('canvasCodeContent'),
    lineNumbersEl: document.getElementById('canvasLineNumbers'),
    previewIframeEl: document.getElementById('canvasPreviewIframe'),
    markdownPreviewEl: document.getElementById('canvasMarkdownPreview'),
    diffContentEl: document.getElementById('canvasDiffContent'),
    copyBtn: document.getElementById('btnCopyCanvas'),
    downloadBtn: document.getElementById('btnDownloadCanvas'),
    expandBtn: document.getElementById('btnExpandCanvas'),
    closeBtn: document.getElementById('btnCloseCanvas'),
    toggleBtn: btnToggleCanvas,
    renderMarkdownFn: renderMarkdown,
    escapeHtmlFn: escapeHtml,
  });

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
  let hasStoredApiKey = false;
  const settingAutoApprove = document.getElementById('settingAutoApprove');

  // State
  let currentSessionId = null;
  let activeAgentId = null;
  let turnBusy = false;
  let queuedQueries = [];
  let activeApprovalId = null;
  const pendingApprovals = new Map(); // approvalId -> { toolName, args, reason }
  let currentAssistantMessage = null;
  let currentAssistantText = '';
  let currentAssistantThought = '';
  let activeToolLines = [];
  let activeTurnExtraChars = 0;
  let latestTelemetryData = {
    estimatedTokens: 0,
    maxContextTokens: 0,
    model: '',
    turnsCount: 0,
    messagesCount: 0,
    toolScopeMode: 'auto',
  };

  // Persist active session + bot across reloads (theme/sidebar already do this)
  const SESSION_KEY = 'opensand-session-id';
  const AGENT_KEY = 'opensand-agent-id';

  function persistSession() {
    if (currentSessionId) localStorage.setItem(SESSION_KEY, currentSessionId);
    else localStorage.removeItem(SESSION_KEY);
    refreshSessions();
    refreshDetailPanel();
  }

  function persistAgent() {
    if (activeAgentId) localStorage.setItem(AGENT_KEY, activeAgentId);
    else localStorage.removeItem(AGENT_KEY);
    refreshBots();
    refreshTokenBadge();
    refreshDetailPanel();
  }

  // Restore saved session + bot (validated against live lists in boot)
  currentSessionId = localStorage.getItem(SESSION_KEY) || null;
  activeAgentId = localStorage.getItem(AGENT_KEY) || null;

  // --- Turn lifecycle helpers ---
  const btnStop = document.getElementById('btnStop');
  const queueIndicator = document.getElementById('queueIndicator');

  function setTurnBusy(busy) {
    turnBusy = busy;
    if (btnSend) {
      const label = btnSend.querySelector('span');
      if (label) label.textContent = busy ? 'Queue' : 'Send';
      else btnSend.textContent = busy ? 'Queue' : 'Send';
      btnSend.title = busy ? 'Queue this message (sends when the current reply finishes)' : 'Send';
    }
    if (btnStop) btnStop.classList.toggle('hidden', !busy);
    if (promptInput) promptInput.focus();
  }

  function updateQueueIndicator() {
    if (!queueIndicator) return;
    if (queuedQueries.length > 0) {
      queueIndicator.textContent = queuedQueries.length === 1 ? '1 queued message' : `${queuedQueries.length} queued messages`;
      queueIndicator.classList.remove('hidden');
    } else {
      queueIndicator.classList.add('hidden');
    }
  }

  function forceResetTurnState(reason = '') {
    setTurnBusy(false);
    if (currentAssistantMessage) {
      const shimmer = currentAssistantMessage.contentEl.querySelector('.typing-shimmer');
      if (shimmer) shimmer.remove();
      if (reason && !currentAssistantText.trim() && !currentAssistantThought.trim()) {
        currentAssistantMessage.contentEl.innerHTML = `<div style="color: var(--text-muted); margin-top: 8px;">⏹ ${escapeHtml(reason)}</div>`;
      }
      const runningLines = currentAssistantMessage.toolsEl.querySelectorAll('.tool-line-running');
      runningLines.forEach((el) => updateToolLineStatus(el, 'failed'));
    }
    queuedQueries = [];
    updateQueueIndicator();
    if (botStatusAvatar) botStatusAvatar.textContent = '⚡';
    if (botStatusText) botStatusText.textContent = 'Ready';
    activeTurnExtraChars = 0;
    refreshTokenBadge();
    smartScrollToBottom();
  }

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

  // Sidebar Collapse Controller
  const sidebarEl = document.querySelector('.sidebar');
  const btnToggleSidebar = document.getElementById('btnToggleSidebar');
  const btnCollapseSidebar = document.getElementById('btnCollapseSidebar');

  function initSidebarCollapse() {
    const saved = localStorage.getItem('opensand-sidebar-collapsed');
    const isCollapsed = saved === 'true';
    if (sidebarEl) {
      sidebarEl.classList.toggle('collapsed', isCollapsed);
    }
    if (btnToggleSidebar) {
      btnToggleSidebar.classList.toggle('active', isCollapsed);
      btnToggleSidebar.title = isCollapsed ? 'Expand Sidebar (Cmd+B)' : 'Collapse Sidebar (Cmd+B)';
    }
  }

  function toggleSidebar(forceState) {
    if (!sidebarEl) return;
    const shouldCollapse = forceState !== undefined ? forceState : !sidebarEl.classList.contains('collapsed');
    sidebarEl.classList.toggle('collapsed', shouldCollapse);
    if (btnToggleSidebar) {
      btnToggleSidebar.classList.toggle('active', shouldCollapse);
      btnToggleSidebar.title = shouldCollapse ? 'Expand Sidebar (Cmd+B)' : 'Collapse Sidebar (Cmd+B)';
    }
    localStorage.setItem('opensand-sidebar-collapsed', shouldCollapse ? 'true' : 'false');
  }

  if (btnToggleSidebar) {
    btnToggleSidebar.onclick = () => toggleSidebar();
  }
  if (btnCollapseSidebar) {
    btnCollapseSidebar.onclick = () => toggleSidebar(true);
  }

  // Global Keyboard Shortcut: Cmd+B (sidebar), Cmd+I (details), Cmd+Shift+A (canvas)
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleDetailPanel();
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      artifactCanvas.toggleCanvas();
    }
  });

  // Slide-out Detail Inspector (OpenBot / Grok Bot Parity)
  function toggleDetailPanel(forceState) {
    if (!detailPanel) return;
    const shouldHide = forceState !== undefined ? !forceState : !detailPanel.classList.contains('hidden');
    detailPanel.classList.toggle('hidden', shouldHide);
    if (btnToggleDetail) {
      btnToggleDetail.classList.toggle('active', !shouldHide);
    }
    if (!shouldHide) {
      refreshDetailPanel();
    }
  }

  function closeDetailPanel() {
    toggleDetailPanel(false);
  }

  if (btnToggleDetail) {
    btnToggleDetail.onclick = () => toggleDetailPanel();
  }
  if (btnCloseDetail) {
    btnCloseDetail.onclick = closeDetailPanel;
  }
  if (badgeActiveBot) {
    badgeActiveBot.style.cursor = 'pointer';
    badgeActiveBot.onclick = () => toggleDetailPanel();
  }

  async function refreshDetailPanel() {
    if (!detailPanel || detailPanel.classList.contains('hidden')) return;

    try {
      // 1. Active Persona
      const agents = await client.getAgents();
      const current = agents.find((a) => a.id === activeAgentId);
      if (current) {
        if (detailBotAvatar) detailBotAvatar.textContent = current.kind === 'ROOM' ? '👥' : '⚡';
        if (detailBotName) detailBotName.textContent = current.name;
        if (detailBotRole) detailBotRole.textContent = current.role || 'Autonomous Specialist';
        if (detailBotModelCode) detailBotModelCode.textContent = current.model || badgeModel?.textContent || 'stealth/crouton-alpha';
        if (detailBotPromptPreview) detailBotPromptPreview.textContent = current.systemPrompt || 'Standard clean-room coding instructions.';
      } else {
        if (detailBotAvatar) detailBotAvatar.textContent = '🤖';
        if (detailBotName) detailBotName.textContent = 'OpenSand Assistant';
        if (detailBotRole) detailBotRole.textContent = 'Universal Clean-Room Coding Agent';
        if (detailBotModelCode) detailBotModelCode.textContent = badgeModel?.textContent || 'stealth/crouton-alpha';
        if (detailBotPromptPreview) {
          detailBotPromptPreview.textContent = 'Default Assistant System Prompt:\nYou are OpenSand, a local-first, universal clean-room coding agent.\nAdhere strictly to AGENTS.md rules: ground before action, surgical edits, zero unverified assumptions, honest verification.';
        }
      }

      // 2. Token Telemetry Gauge
      const telemetry = await client.getTokenTelemetry(activeAgentId || undefined, currentSessionId || undefined);
      if (telemetry) {
        const used = telemetry.estimatedTokens || 0;
        const max = telemetry.maxContextTokens || 0;
        const pct = Math.min(100, Math.round((used / max) * 1000) / 10);
        if (detailTokensUsed) detailTokensUsed.textContent = `${used.toLocaleString()} tokens`;
        if (detailTokensMax) detailTokensMax.textContent = max ? max.toLocaleString() : '-';
        if (detailTokensPct) detailTokensPct.textContent = `${pct.toFixed(1)}%`;
        if (detailMeterFill) {
          detailMeterFill.style.width = `${Math.min(100, Math.max(0.75, pct))}%`;
          if (pct > 80) {
            detailMeterFill.style.background = 'var(--danger)';
          } else if (pct > 50) {
            detailMeterFill.style.background = 'var(--warning)';
          } else {
            detailMeterFill.style.background = 'var(--accent-gradient)';
          }
        }
      }

      // 3. Cognitive Memories & Habits
      if (detailMemoriesList) {
        try {
          const memories = await client.listMemories();
          if (memories && memories.length > 0) {
            detailMemoriesList.innerHTML = '';
            memories.slice(0, 5).forEach((m) => {
              const div = document.createElement('div');
              div.className = 'detail-memory-item';
              div.textContent = m.content || m.fact || m.rule || (typeof m === 'string' ? m : JSON.stringify(m));
              detailMemoriesList.appendChild(div);
            });
          } else {
            detailMemoriesList.innerHTML = '<div class="detail-empty-text">No learned memories in this session yet.</div>';
          }
        } catch {
          detailMemoriesList.innerHTML = '<div class="detail-empty-text">Memory storage idle.</div>';
        }
      }

      // 4. Granted Skills
      if (detailSkillsTags) {
        try {
          const skills = await client.listSkills();
          if (skills && skills.length > 0) {
            detailSkillsTags.innerHTML = '';
            skills.slice(0, 10).forEach((s) => {
              const chip = document.createElement('span');
              chip.className = 'detail-skill-chip';
              chip.textContent = s.name || s.id;
              chip.title = s.description || '';
              detailSkillsTags.appendChild(chip);
            });
          } else {
            detailSkillsTags.innerHTML = `
              <span class="detail-skill-chip">code-audit</span>
              <span class="detail-skill-chip">architecture</span>
              <span class="detail-skill-chip">debugging</span>
            `;
          }
        } catch {
          detailSkillsTags.innerHTML = `
            <span class="detail-skill-chip">clean-room</span>
            <span class="detail-skill-chip">verification</span>
          `;
        }
      }
    } catch (err) {
      console.warn('Error refreshing detail panel:', err);
    }
  }

  // Session Actions in Detail Panel
  if (btnDetailRewind) {
    btnDetailRewind.onclick = () => document.getElementById('btnOpenRollback')?.click();
  }
  if (btnDetailCompact) {
    btnDetailCompact.onclick = () => document.getElementById('btnOpenCompact')?.click();
  }
  if (btnDetailClear) {
    btnDetailClear.onclick = () => document.getElementById('btnMenuClearSessions')?.click();
  }
  if (btnDetailExportBot) {
    btnDetailExportBot.onclick = async () => {
      try {
        const idToExport = activeAgentId || 'default-assistant';
        let templateData;
        try {
          templateData = await client.exportAgentTemplate(idToExport);
        } catch {
          const agents = await client.getAgents();
          const current = agents.find((a) => a.id === activeAgentId);
          templateData = {
            templateVersion: '1.0',
            name: current?.name || 'OpenSand Assistant',
            role: current?.role || 'Clean-Room Coding Agent',
            systemPrompt: current?.systemPrompt || 'Standard clean-room coding system prompt.',
            model: current?.model || badgeModel?.textContent || 'stealth/crouton-alpha',
          };
        }
        const blob = new Blob([JSON.stringify(templateData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(templateData.name || 'bot').toLowerCase().replace(/\s+/g, '-')}-template.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Error exporting bot template:', err);
      }
    };
  }

  initSidebarCollapse();

  // --- REFRESH FUNCTIONS ---

  async function refreshSettings() {
    try {
      const s = await client.getSettings();
      const modelName = s.model || 'Default';

      if (badgeModel) {
        badgeModel.textContent = modelName;
        badgeModel.title = `Active Model: ${modelName} (${s.endpoint || ''})`;
      }
      if (badgeAutoApprove) {
        badgeAutoApprove.textContent = s.autoApprove ? '⚡ Auto-Approve' : '🛡 Safe Mode';
        badgeAutoApprove.className = s.autoApprove ? 'badge badge-warning' : 'badge badge-success';
      }

      const composerModelBadge = document.getElementById('composerModelBadge');
      if (composerModelBadge) {
        composerModelBadge.textContent = modelName;
        composerModelBadge.title = `Active Model: ${modelName} (${s.endpoint || ''})`;
      }
      const composerAutoApproveText = document.getElementById('composerAutoApproveText');
      if (composerAutoApproveText) {
        composerAutoApproveText.textContent = s.autoApprove ? 'Auto-Approve' : 'Safe Mode';
      }
    } catch (err) {
      console.error('Error refreshing settings:', err);
    }
  }

  function formatTokenCount(n) {
    if (typeof n !== 'number' || isNaN(n)) return '0';
    if (n >= 1_000_000) {
      const val = n / 1_000_000;
      return `${val >= 10 ? val.toFixed(1) : val.toFixed(2).replace(/\.?0+$/, '')}M`;
    }
    if (n >= 10_000) {
      const val = n / 1_000;
      return `${val.toFixed(1).replace(/\.0$/, '')}k`;
    }
    return n.toLocaleString();
  }

  function formatPercentage(current, max) {
    if (!max || current <= 0) return '0%';
    const rawPct = (current / max) * 100;
    if (rawPct < 0.1) return '<0.1%';
    if (rawPct < 10) return `${rawPct.toFixed(1)}%`;
    return `${Math.min(100, Math.round(rawPct))}%`;
  }

  function updateTokenDisplay(current, max, model) {
    if (!badgeTokens) return;
    const currentTokens = Math.max(0, current || 0);
    const maxTokens = Math.max(1, max || 0);
    const pctStr = formatPercentage(currentTokens, maxTokens);
    const rawPct = (currentTokens / maxTokens) * 100;
    const activeModelName = model || latestTelemetryData.model || badgeModel?.textContent || 'model';

    badgeTokens.textContent = `⚡ ${formatTokenCount(currentTokens)} / ${max ? formatTokenCount(maxTokens) : '-'} (${pctStr})`;
    badgeTokens.title = `Context Window: ${currentTokens.toLocaleString()} / ${max ? maxTokens.toLocaleString() : '-'} tokens (${pctStr}) for ${activeModelName}. Click to compact dialogue.`;
    badgeTokens.className = 'badge badge-tokens';
    if (rawPct > 80) {
      badgeTokens.classList.add('danger');
    } else if (rawPct > 50) {
      badgeTokens.classList.add('warn');
    }

    const meterBar = document.getElementById('contextMeterProgress');
    if (meterBar) {
      const barWidth = currentTokens === 0 ? 0 : Math.min(100, Math.max(0.75, rawPct));
      meterBar.style.width = `${barWidth}%`;
      meterBar.title = `${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens used (${pctStr}) [${activeModelName}]`;
      if (rawPct > 80) {
        meterBar.style.backgroundColor = 'var(--danger)';
      } else if (rawPct > 50) {
        meterBar.style.backgroundColor = 'var(--warning)';
      } else {
        meterBar.style.backgroundColor = 'var(--accent)';
      }
    }

    if (detailTokensUsed) {
      detailTokensUsed.textContent = `${currentTokens.toLocaleString()} tokens`;
      if (detailTokensMax) detailTokensMax.textContent = max ? maxTokens.toLocaleString() : '-';
      if (detailTokensPct) detailTokensPct.textContent = pctStr;
      if (detailMeterFill) {
        detailMeterFill.style.width = `${Math.min(100, Math.max(0.75, rawPct))}%`;
        if (rawPct > 80) {
          detailMeterFill.style.background = 'var(--danger)';
        } else if (rawPct > 50) {
          detailMeterFill.style.background = 'var(--warning)';
        } else {
          detailMeterFill.style.background = 'var(--accent-gradient)';
        }
      }
    }

    if (badgeModel && activeModelName && activeModelName !== 'Model') {
      const shortName = activeModelName.includes('/') ? activeModelName.split('/').pop() : activeModelName;
      badgeModel.textContent = shortName;
      badgeModel.title = `Active Model: ${activeModelName}`;
    }

    const composerModelBadge = document.getElementById('composerModelBadge');
    if (composerModelBadge) {
      composerModelBadge.title = `Active Model: ${activeModelName} • Context Window: ${maxTokens.toLocaleString()} tokens`;
    }
  }

  async function refreshTokenBadge() {
    if (!badgeTokens) return;
    try {
      const data = await client.getTokenTelemetry(activeAgentId || undefined, currentSessionId || undefined);
      if (!data) return;
      latestTelemetryData = data;
      updateTokenDisplay(data.estimatedTokens, data.maxContextTokens, data.model);
    } catch {
      // Ignore
    }
  }

  if (badgeTokens) {
    badgeTokens.addEventListener('click', async () => {
      try {
        const data = await client.getTokenTelemetry(activeAgentId || undefined, currentSessionId || undefined);
        if (!data) return;
        const modelInfo = data.model ? `\n• Active Model: ${data.model}` : '';
        const pctStr = formatPercentage(data.estimatedTokens || 0, data.maxContextTokens || 1);
        const confirmed = confirm(
          `Current Context Footprint:${modelInfo}\n• Estimated Tokens: ${(data.estimatedTokens || 0).toLocaleString()} / ${(data.maxContextTokens || 0).toLocaleString()} (${pctStr})\n• Turns: ${data.turnsCount || 0}\n• Messages: ${data.messagesCount || 0}\n• Tool Scoping: ${data.toolScopeMode || 'auto'}\n\nCompact conversation history now?`
        );
        if (confirmed) {
          await client.compactHistory(2);
          await refreshTokenBadge();
        }
      } catch {
        // Ignore
      }
    });
  }

  async function refreshBots() {
    const agents = await client.getAgents();
    botList.innerHTML = '';

    const defaultItem = document.createElement('div');
    defaultItem.className = `bot-item ${activeAgentId === null ? 'active' : ''}`;
    defaultItem.innerHTML = `
      <span class="bot-icon">🤖</span>
      <div class="bot-item-info">
        <span class="bot-item-name">Default Assistant</span>
      </div>
    `;
    defaultItem.onclick = () => {
      activeAgentId = null;
      badgeActiveBot.textContent = '🤖 Default Assistant';
      persistAgent();
    };
    botList.appendChild(defaultItem);

    for (const a of agents) {
      const item = document.createElement('div');
      item.className = `bot-item ${activeAgentId === a.id ? 'active' : ''}`;
      const icon = a.kind === 'ROOM' ? '👥' : '⚡';
      item.innerHTML = `
        <span class="bot-icon">${icon}</span>
        <div class="bot-item-info">
          <span class="bot-item-name">${escapeHtml(a.name)}</span>
          ${a.role ? `<span class="bot-item-role">${escapeHtml(a.role)}</span>` : ''}
        </div>
        <button class="btn-delete-bot" title="Delete bot" data-bot-id="${escapeHtml(a.id)}">🗑️</button>
      `;
      item.title = a.role || a.name;
      item.onclick = (e) => {
        if (e.target.closest('.btn-delete-bot')) return;
        activeAgentId = a.id;
        badgeActiveBot.textContent = `${icon} ${a.name}`;
        persistAgent();
      };

      const delBtn = item.querySelector('.btn-delete-bot');
      if (delBtn) {
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (confirm(`Are you sure you want to delete bot "${a.name}"?`)) {
            await client.deleteAgent(a.id);
            if (activeAgentId === a.id) {
              activeAgentId = null;
              badgeActiveBot.textContent = '🤖 Default Assistant';
            }
            refreshBots();
            refreshTokenBadge();
            localStorage.removeItem(AGENT_KEY);
            refreshTemplates();
          }
        };
      }
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
    const loaded = await client.getSessions();
    const sessions = Array.isArray(loaded) ? loaded : [];
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
            <button class="btn-delete-session" title="Delete conversation" data-session-id="${escapeHtml(s.id)}">🗑️</button>
          </div>
        </div>
      `;
      const btnDel = item.querySelector('.btn-delete-session');
      if (btnDel) {
        btnDel.onclick = async (e) => {
          e.stopPropagation();
          if (confirm(`Delete conversation "${title}"? This cannot be undone.`)) {
            try {
              await client.deleteSession(s.id);
              if (currentSessionId === s.id) {
                startNewSession();
                localStorage.removeItem(SESSION_KEY);
              } else {
                refreshSessions();
              }
            } catch (err) {
              alert(`Error deleting conversation: ${err.message}`);
            }
          }
        };
      }
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
            <button class="btn btn-ghost btn-xs btn-del-agent" style="color: var(--danger);">Delete Bot</button>
          </div>
        `;

        card.querySelector('.btn-export-agent').onclick = async () => {
          if (selectExport) selectExport.value = a.id;
          exportTemplateModal.classList.remove('hidden');
          const tpl = await client.exportAgentTemplate(a.id);
          exportTemplateJson.textContent = JSON.stringify(tpl, null, 2);
        };

        const delBtn = card.querySelector('.btn-del-agent');
        if (delBtn) {
          delBtn.onclick = async () => {
            if (confirm(`Are you sure you want to delete bot "${a.name}"?`)) {
              await client.deleteAgent(a.id);
              if (activeAgentId === a.id) {
                activeAgentId = null;
                badgeActiveBot.textContent = '🤖 Default Assistant';
              }
              refreshBots();
              refreshTokenBadge();
              localStorage.removeItem(AGENT_KEY);
              refreshTemplates();
            }
          };
        }

        grid.appendChild(card);
      }
    }
  }

  // --- COMMUNITY AGENT STORE & TEMPLATE GALLERY ---
  let currentGalleryCategory = 'all';
  let currentGallerySearch = '';
  let gallerySearchDebounceTimer = null;

  function getCategoryEmoji(cat) {
    switch (cat) {
      case 'engineering': return '🛠️';
      case 'security': return '🛡️';
      case 'product': return '📐';
      case 'research': return '🔬';
      case 'community': return '🌐';
      default: return '🤖';
    }
  }

  async function refreshGallery(category = currentGalleryCategory, query = currentGallerySearch) {
    const grid = document.getElementById('galleryCardGrid');
    if (!grid) return;

    grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">Loading community templates…</div>`;

    try {
      const templates = await client.getGalleryTemplates({
        category: category !== 'all' ? category : undefined,
        query: query ? query : undefined,
      });

      if (!Array.isArray(templates) || templates.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No agent templates found matching criteria. Try adjusting filters or search terms.</div>`;
        return;
      }

      grid.innerHTML = '';

      for (const tpl of templates) {
        const card = document.createElement('div');
        card.className = 'gallery-template-card';
        const icon = getCategoryEmoji(tpl.category);
        const tagsHtml = (tpl.tags || [])
          .slice(0, 4)
          .map((tg) => `<span class="gallery-tag-pill">#${escapeHtml(tg)}</span>`)
          .join('');

        card.innerHTML = `
          <div class="gallery-card-top">
            <div class="gallery-card-icon">${icon}</div>
            <div class="gallery-card-info">
              <div class="gallery-card-title">${escapeHtml(tpl.name)}</div>
              <div class="gallery-card-role">${escapeHtml(tpl.role || tpl.category)}</div>
            </div>
          </div>
          <div class="gallery-card-desc">${escapeHtml(tpl.description || '')}</div>
          <div class="gallery-card-tags">
            ${tagsHtml}
          </div>
          <div class="gallery-card-meta">
            <span class="gallery-stat">⭐ ${(tpl.rating || 5.0).toFixed(1)}</span>
            <span class="gallery-stat">📥 ${(tpl.downloads || 0).toLocaleString()}</span>
            <span class="gallery-stat">👤 ${escapeHtml(tpl.author || 'Official')}</span>
            <span class="badge ${tpl.isCurated ? 'badge-success' : ''}">${tpl.isCurated ? 'Official' : 'Community'}</span>
          </div>
          <div class="gallery-card-actions">
            <button class="btn btn-secondary btn-xs btn-preview-tpl" style="flex: 1;">Preview</button>
            ${
              tpl.installed
                ? `<button class="btn btn-ghost btn-xs" disabled style="flex: 1; color: var(--success); font-weight: 600;">Installed ✓</button>`
                : `<button class="btn btn-primary btn-xs btn-install-tpl" style="flex: 1;">Install to Fleet</button>`
            }
          </div>
        `;

        // Wire Preview
        const previewBtn = card.querySelector('.btn-preview-tpl');
        if (previewBtn) {
          previewBtn.onclick = () => openTemplatePreviewModal(tpl.id);
        }

        // Wire Install
        const installBtn = card.querySelector('.btn-install-tpl');
        if (installBtn) {
          installBtn.onclick = async () => {
            installBtn.disabled = true;
            installBtn.textContent = 'Installing…';
            try {
              const res = await client.installGalleryTemplate(tpl.id);
              if (res.agent) {
                await refreshBots();
                await refreshTemplates();
                await refreshGallery();
              }
            } catch (err) {
              alert(`Failed to install template: ${err.message}`);
              installBtn.disabled = false;
              installBtn.textContent = 'Install to Fleet';
            }
          };
        }

        grid.appendChild(card);
      }
    } catch (err) {
      grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--danger); font-size: 13px;">Error loading template store: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function openTemplatePreviewModal(templateId) {
    const modal = document.getElementById('templatePreviewModal');
    if (!modal) return;

    try {
      const full = await client.getGalleryTemplate(templateId);
      if (!full) return;

      const meta = full.metadata || {};
      const icon = getCategoryEmoji(meta.category);

      document.getElementById('previewModalIcon').textContent = icon;
      document.getElementById('previewModalTitle').textContent = full.name;
      document.getElementById('previewModalRole').textContent = full.role || meta.category;
      document.getElementById('previewModalDesc').textContent = meta.description || '';

      const metaContainer = document.getElementById('previewModalMeta');
      metaContainer.innerHTML = `
        <span class="badge badge-bot">${escapeHtml(meta.category || 'General')}</span>
        <span class="badge">Model: ${escapeHtml(full.model || 'default')}</span>
        <span class="badge">Author: ${escapeHtml(meta.author || 'Official')}</span>
        <span class="badge">v${escapeHtml(meta.version || '1.0.0')}</span>
        <span class="badge">⭐ ${(meta.rating || 5.0).toFixed(1)}</span>
        <span class="badge">📥 ${(meta.downloads || 0).toLocaleString()} DLs</span>
      `;

      const toolsContainer = document.getElementById('previewModalTools');
      toolsContainer.innerHTML = '';
      if (Array.isArray(full.allowedTools) && full.allowedTools.length > 0) {
        full.allowedTools.forEach((tl) => {
          const pill = document.createElement('span');
          pill.className = 'badge';
          pill.textContent = tl;
          toolsContainer.appendChild(pill);
        });
      } else {
        toolsContainer.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">All available workspace tools</span>';
      }

      const tasksList = document.getElementById('previewModalTasks');
      tasksList.innerHTML = '';
      if (Array.isArray(full.suggestedTasks) && full.suggestedTasks.length > 0) {
        full.suggestedTasks.forEach((st) => {
          const li = document.createElement('li');
          li.textContent = st;
          tasksList.appendChild(li);
        });
      } else {
        tasksList.innerHTML = '<li>General domain engineering tasks and workflows</li>';
      }

      document.getElementById('previewModalPrompt').textContent = full.systemPrompt || '';

      const installBtn = document.getElementById('btnInstallFromPreview');
      if (installBtn) {
        if (meta.installed) {
          installBtn.disabled = true;
          installBtn.textContent = 'Already Installed in Fleet';
        } else {
          installBtn.disabled = false;
          installBtn.textContent = 'Install to Local Fleet';
          installBtn.onclick = async () => {
            installBtn.disabled = true;
            installBtn.textContent = 'Installing…';
            try {
              await client.installGalleryTemplate(templateId);
              modal.classList.add('hidden');
              await refreshBots();
              await refreshTemplates();
              await refreshGallery();
            } catch (err) {
              alert(`Failed to install template: ${err.message}`);
              installBtn.disabled = false;
              installBtn.textContent = 'Install to Local Fleet';
            }
          };
        }
      }

      modal.classList.remove('hidden');
    } catch (err) {
      alert(`Could not load template preview: ${err.message}`);
    }
  }

  // Gallery search & category chip listeners
  const gallerySearchInput = document.getElementById('gallerySearchInput');
  if (gallerySearchInput) {
    gallerySearchInput.addEventListener('input', (e) => {
      clearTimeout(gallerySearchDebounceTimer);
      gallerySearchDebounceTimer = setTimeout(() => {
        currentGallerySearch = e.target.value.trim();
        refreshGallery(currentGalleryCategory, currentGallerySearch);
      }, 250);
    });
  }

  const galleryCategoryChips = document.getElementById('galleryCategoryChips');
  if (galleryCategoryChips) {
    galleryCategoryChips.querySelectorAll('.category-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        galleryCategoryChips.querySelectorAll('.category-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        currentGalleryCategory = chip.dataset.category || 'all';
        refreshGallery(currentGalleryCategory, currentGallerySearch);
      });
    });
  }

  const btnRefreshGallery = document.getElementById('btnRefreshGallery');
  if (btnRefreshGallery) {
    btnRefreshGallery.onclick = () => refreshGallery(currentGalleryCategory, currentGallerySearch);
  }

  // Template preview modal close
  const templatePreviewModal = document.getElementById('templatePreviewModal');
  const btnClosePreviewModal = document.getElementById('btnClosePreviewModal');
  const btnCancelPreviewModal = document.getElementById('btnCancelPreviewModal');
  if (btnClosePreviewModal && templatePreviewModal) {
    btnClosePreviewModal.onclick = () => templatePreviewModal.classList.add('hidden');
  }
  if (btnCancelPreviewModal && templatePreviewModal) {
    btnCancelPreviewModal.onclick = () => templatePreviewModal.classList.add('hidden');
  }

  // Publish template modal controls
  const publishTemplateModal = document.getElementById('publishTemplateModal');
  const btnOpenPublishTemplate = document.getElementById('btnOpenPublishTemplate');
  const btnClosePublishModal = document.getElementById('btnClosePublishModal');
  const btnCancelPublishModal = document.getElementById('btnCancelPublishModal');
  const btnSubmitPublish = document.getElementById('btnSubmitPublish');
  const publishAgentSelect = document.getElementById('publishAgentSelect');
  const publishCategory = document.getElementById('publishCategory');
  const publishTags = document.getElementById('publishTags');
  const publishAuthor = document.getElementById('publishAuthor');

  if (btnOpenPublishTemplate && publishTemplateModal) {
    btnOpenPublishTemplate.onclick = async () => {
      if (publishAgentSelect) {
        publishAgentSelect.innerHTML = '';
        const agents = await client.getAgents();
        const publishable = (agents || []).filter((a) => a.kind !== 'ROOM');
        if (publishable.length === 0) {
          alert('No local agent personas found. Create an agent persona before publishing to the gallery.');
          return;
        }
        publishable.forEach((a) => {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = `${a.name} (${a.role})`;
          publishAgentSelect.appendChild(opt);
        });
      }
      if (publishTags) publishTags.value = '';
      publishTemplateModal.classList.remove('hidden');
    };
  }

  if (btnClosePublishModal && publishTemplateModal) {
    btnClosePublishModal.onclick = () => publishTemplateModal.classList.add('hidden');
  }
  if (btnCancelPublishModal && publishTemplateModal) {
    btnCancelPublishModal.onclick = () => publishTemplateModal.classList.add('hidden');
  }

  if (btnSubmitPublish && publishTemplateModal) {
    btnSubmitPublish.onclick = async () => {
      const agentId = publishAgentSelect?.value;
      if (!agentId) {
        alert('Please select an agent persona to publish.');
        return;
      }
      const agents = await client.getAgents();
      const agent = (agents || []).find((a) => a.id === agentId);
      if (!agent) {
        alert('Selected agent persona not found.');
        return;
      }

      const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || agent.id;
      const category = publishCategory?.value || 'engineering';
      const tags = (publishTags?.value || '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const author = publishAuthor?.value.trim() || 'Community Contributor';

      btnSubmitPublish.disabled = true;
      btnSubmitPublish.textContent = 'Publishing…';

      try {
        await client.publishGalleryTemplate({
          id: slug,
          name: agent.name,
          role: agent.role,
          systemPrompt: agent.systemPrompt,
          allowedTools: agent.allowedTools,
          model: agent.model,
          category,
          tags,
          author,
          description: `${agent.role}: ${agent.systemPrompt.slice(0, 160)}...`,
        });

        publishTemplateModal.classList.add('hidden');
        await refreshGallery();
      } catch (err) {
        alert(`Failed to publish template: ${err.message}`);
      } finally {
        btnSubmitPublish.disabled = false;
        btnSubmitPublish.textContent = 'Publish to Gallery';
      }
    };
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

  // --- 3rd-Party OAuth Connectors (Slack, Linear, GitHub App) ---
  async function refreshConnectors() {
    const grid = document.getElementById('connectorsCardGrid');
    if (!grid) return;
    grid.innerHTML = '';

    let connectors = [];
    try {
      connectors = await client.getConnectors();
    } catch (err) {
      grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--danger); font-size: 13px;">Failed to load connectors: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (!Array.isArray(connectors) || connectors.length === 0) {
      grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 13px;">No connectors available.</div>`;
      return;
    }

    for (const conn of connectors) {
      const card = document.createElement('div');
      card.className = 'connector-dashboard-card';

      const isConnected = conn.status === 'connected';
      const isConnecting = conn.status === 'connecting';
      const statusBadgeClass = isConnected ? 'badge-connected' : isConnecting ? 'badge-pending' : 'badge-disconnected';
      const statusLabel = isConnected ? 'Connected' : isConnecting ? 'Connecting…' : 'Disconnected';

      const scopesPills = (conn.scopes || []).map(s => `<span class="connector-scope-pill">${escapeHtml(s)}</span>`).join('');

      card.innerHTML = `
        <div class="connect-card-header">
          <div class="connect-card-icon" style="background-color: ${conn.brandColor || '#3b82f6'};">${conn.icon || '🔌'}</div>
          <div class="connect-card-meta">
            <div class="connect-card-title">${escapeHtml(conn.name)}</div>
            <div class="connect-card-subtitle">${escapeHtml(conn.description)}</div>
          </div>
          <span class="connect-card-badge ${statusBadgeClass}">${statusLabel}</span>
        </div>

        <div style="font-size: 12px; color: var(--text-muted);">
          ${isConnected ? `<strong>Account:</strong> <span style="color: var(--accent); font-weight: 500;">${escapeHtml(conn.account || 'Authorized')}</span> • <span style="font-size: 11px;">Connected ${new Date(conn.connectedAt || Date.now()).toLocaleDateString()}</span>` : '<em>Not connected</em>'}
        </div>

        <div class="connector-scopes-list">
          ${scopesPills}
        </div>

        <div class="card-footer" style="margin-top: auto; display: flex; flex-wrap: wrap; gap: 8px;">
          ${!isConnected ? `
            <button class="btn btn-primary btn-sm btn-dash-oauth" data-id="${conn.id}" data-name="${escapeHtml(conn.name)}">
              Connect via OAuth
            </button>
            <button class="btn btn-secondary btn-sm btn-dash-config-token" data-id="${conn.id}" data-name="${escapeHtml(conn.name)}">
              Enter Token
            </button>
          ` : `
            <button class="btn btn-secondary btn-sm btn-dash-test" data-id="${conn.id}">
              Test Connection
            </button>
            <button class="btn btn-secondary btn-sm btn-dash-config-token" data-id="${conn.id}" data-name="${escapeHtml(conn.name)}">
              Update Credential
            </button>
            <button class="btn btn-ghost btn-sm btn-dash-disconnect" data-id="${conn.id}" style="color: var(--danger);">
              Disconnect
            </button>
          `}
        </div>
      `;

      // Wire OAuth button
      const oauthBtn = card.querySelector('.btn-dash-oauth');
      if (oauthBtn) {
        oauthBtn.onclick = async () => {
          oauthBtn.disabled = true;
          oauthBtn.textContent = 'Opening…';
          try {
            const flow = await client.connectApp(conn.id);
            if (flow.authUrl) {
              window.open(flow.authUrl, '_blank');
              // Poll for completion
              const pollInterval = setInterval(async () => {
                const updated = await client.getConnector(conn.id);
                if (updated && updated.status === 'connected') {
                  clearInterval(pollInterval);
                  refreshConnectors();
                }
              }, 1500);
              setTimeout(() => clearInterval(pollInterval), 60000);
            }
          } catch (err) {
            alert(`Failed to initiate OAuth for ${conn.name}: ${err.message}`);
          } finally {
            oauthBtn.disabled = false;
            oauthBtn.textContent = 'Connect via OAuth';
          }
        };
      }

      // Wire Config Token button
      const configTokenBtn = card.querySelector('.btn-dash-config-token');
      if (configTokenBtn) {
        configTokenBtn.onclick = () => {
          openConfigureConnectorModal(conn.id, conn.name, conn.account || '');
        };
      }

      // Wire Test button
      const testBtn = card.querySelector('.btn-dash-test');
      if (testBtn) {
        testBtn.onclick = async () => {
          testBtn.disabled = true;
          testBtn.textContent = 'Testing…';
          try {
            const res = await client.testConnector(conn.id);
            alert(res.message || (res.ok ? 'Connection verified!' : 'Connection check failed.'));
          } catch (err) {
            alert(`Test failed: ${err.message}`);
          } finally {
            testBtn.disabled = false;
            testBtn.textContent = 'Test Connection';
          }
        };
      }

      // Wire Disconnect button
      const disconnectBtn = card.querySelector('.btn-dash-disconnect');
      if (disconnectBtn) {
        disconnectBtn.onclick = async () => {
          if (confirm(`Disconnect ${conn.name}? Agents will no longer be able to access this service.`)) {
            await client.disconnectApp(conn.id);
            refreshConnectors();
          }
        };
      }

      grid.appendChild(card);
    }
  }

  function openConfigureConnectorModal(id, name, currentAccount = '') {
    const modal = document.getElementById('configureConnectorModal');
    if (!modal) return;
    document.getElementById('configureConnectorId').value = id;
    document.getElementById('configureConnectorModalTitle').textContent = `Configure ${name} Integration`;
    document.getElementById('configureConnectorAccount').value = currentAccount;
    document.getElementById('configureConnectorToken').value = '';
    
    let hint = `Your credentials are encrypted locally on disk and never logged.`;
    if (id === 'slack') hint = `Enter Slack Bot User OAuth Token (starts with xoxb-) or User Token (xoxp-).`;
    else if (id === 'linear') hint = `Enter Linear Personal API Key (starts with lin_api_).`;
    else if (id === 'github') hint = `Enter GitHub Personal Access Token (ghp_) or GitHub App Installation Token.`;
    document.getElementById('configureConnectorHint').textContent = hint;

    modal.classList.remove('hidden');
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
  // renderMarkdown + renderMarkdownCached: see modules/chat/markdown.js

  // Incremental render cache: renderMarkdown is O(n^2) on long streams because
  // it re-parses the whole text per token. Cache by text length + tail hash so
  // unchanged prefix blocks are not re-parsed.
  // renderMarkdownCached: see modules/chat/markdown.js

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

  const MAX_TOOL_DOM_PREVIEW = 12000;

  function formatToolOutputPayload(result) {
    if (result === null || result === undefined) return { display: '', raw: '', isTruncated: false };
    const raw = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    const isTruncated = raw.length > MAX_TOOL_DOM_PREVIEW;
    const display = isTruncated
      ? raw.slice(0, MAX_TOOL_DOM_PREVIEW) + `\n\n[... Truncated for display hygiene: ${(raw.length - MAX_TOOL_DOM_PREVIEW).toLocaleString()} characters omitted. Click "Copy Output" to inspect in full. ...]`
      : raw;
    return { display, raw, isTruncated };
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
    div._startTime = performance.now();

    const outInfo = formatToolOutputPayload(result);
    div._rawResult = outInfo.raw;

    const lines = outInfo.display ? outInfo.display.split('\n') : [];
    const needsFold = lines.length > 5;

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
          <div class="tool-details-header" style="margin-top: 8px;">
            <span>Output Result:</span>
            <button class="btn-copy-tool-output" type="button">Copy Output</button>
          </div>
          <pre class="tool-details-pre tool-result-pre ${needsFold ? 'folded' : ''}">${escapeHtml(outInfo.display)}</pre>
          ${needsFold ? `<button class="tool-fold-btn" type="button" data-lines="${lines.length}">▾ Show full output (${lines.length} lines)</button>` : ''}
        ` : ''}
      </div>
    `;

    return div;
  }

  function updateToolLineStatus(toolEl, status, result) {
    if (!toolEl) return;
    toolEl.classList.remove('tool-line-running');

    let durationStr = '';
    if (toolEl._startTime) {
      const elapsed = Math.round(performance.now() - toolEl._startTime);
      durationStr = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
    }

    const badge = toolEl.querySelector('.tool-line-badge');
    if (badge) {
      const isError = status === 'error' || status === 'failed';
      const label = isError ? 'Failed' : 'Done';
      badge.innerHTML = `${label}${durationStr ? ` <span class="tool-duration">• ${durationStr}</span>` : ''}`;
      badge.className = `tool-line-badge ${isError ? 'badge-error' : 'badge-done'}`;
    }
    if (result !== undefined && result !== null) {
      const outInfo = formatToolOutputPayload(result);
      toolEl._rawResult = outInfo.raw;
      const details = toolEl.querySelector('.tool-line-details');
      if (details) {
        let resultPre = details.querySelector('.tool-result-pre');
        let foldBtn = details.querySelector('.tool-fold-btn');
        const lines = outInfo.display ? outInfo.display.split('\n') : [];
        const needsFold = lines.length > 5;

        if (!resultPre) {
          const outHeader = document.createElement('div');
          outHeader.className = 'tool-details-header';
          outHeader.style.marginTop = '8px';
          outHeader.innerHTML = `<span>Output Result:</span><button class="btn-copy-tool-output" type="button">Copy Output</button>`;
          resultPre = document.createElement('pre');
          resultPre.className = `tool-details-pre tool-result-pre ${needsFold ? 'folded' : ''}`;
          resultPre.textContent = outInfo.display;
          details.appendChild(outHeader);
          details.appendChild(resultPre);

          if (needsFold) {
            foldBtn = document.createElement('button');
            foldBtn.className = 'tool-fold-btn';
            foldBtn.type = 'button';
            foldBtn.dataset.lines = lines.length;
            foldBtn.textContent = `▾ Show full output (${lines.length} lines)`;
            details.appendChild(foldBtn);
          }
        } else {
          resultPre.textContent = outInfo.display;
          if (needsFold) {
            resultPre.classList.add('folded');
            if (!foldBtn) {
              foldBtn = document.createElement('button');
              foldBtn.className = 'tool-fold-btn';
              foldBtn.type = 'button';
              foldBtn.dataset.lines = lines.length;
              foldBtn.textContent = `▾ Show full output (${lines.length} lines)`;
              details.appendChild(foldBtn);
            } else {
              foldBtn.dataset.lines = lines.length;
              foldBtn.textContent = `▾ Show full output (${lines.length} lines)`;
              foldBtn.classList.remove('hidden');
            }
          } else if (foldBtn) {
            resultPre.classList.remove('folded');
            foldBtn.classList.add('hidden');
          }
        }
      }
      const group = toolEl.parentElement?.closest('.tool-activity-group');
      if (group && group._groupController) {
        group._groupController.updateGroup();
      }
    }
  }

  function createToolGroupElement(initialToolEl = null) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'tool-activity-group';
    groupDiv._tools = [];

    const summary = document.createElement('div');
    summary.className = 'tool-group-summary';
    summary.innerHTML = `
      <div class="tool-group-summary-left">
        <span class="tool-group-chevron">▶</span>
        <span class="tool-group-icon">⚙️</span>
        <span class="tool-group-label">Running tool operation...</span>
      </div>
      <div class="tool-group-summary-right">
        <span class="tool-group-status tool-line-badge badge-running">Running</span>
      </div>
    `;

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'tool-group-items hidden';

    summary.addEventListener('click', () => {
      const isHidden = itemsContainer.classList.contains('hidden');
      itemsContainer.classList.toggle('hidden', !isHidden);
      groupDiv.classList.toggle('tool-group-expanded', isHidden);
    });

    groupDiv.appendChild(summary);
    groupDiv.appendChild(itemsContainer);

    function updateGroup() {
      const count = groupDiv._tools.length;
      const names = Array.from(new Set(groupDiv._tools.map(t => t.dataset.toolName || 'tool'))).join(', ');
      const hasRunning = groupDiv._tools.some(t => t.classList.contains('tool-line-running'));
      const hasFailed = groupDiv._tools.some(t => t.querySelector('.badge-error'));

      const labelEl = summary.querySelector('.tool-group-label');
      const statusEl = summary.querySelector('.tool-group-status');

      if (labelEl) {
        labelEl.textContent = count === 1 ? `1 tool operation (${names})` : `${count} tool operations (${names})`;
      }

      if (statusEl) {
        if (hasRunning) {
          statusEl.textContent = 'Running';
          statusEl.className = 'tool-group-status tool-line-badge badge-running';
        } else if (hasFailed) {
          statusEl.textContent = 'Issues';
          statusEl.className = 'tool-group-status tool-line-badge badge-error';
        } else {
          statusEl.textContent = 'All Done';
          statusEl.className = 'tool-group-status tool-line-badge badge-done';
        }
      }
    }

    function addTool(toolEl) {
      groupDiv._tools.push(toolEl);
      itemsContainer.appendChild(toolEl);
      updateGroup();
    }

    const controller = {
      element: groupDiv,
      addTool,
      updateGroup,
      tools: groupDiv._tools,
    };
    groupDiv._groupController = controller;

    if (initialToolEl) {
      addTool(initialToolEl);
    }

    return controller;
  }

  // Delegated interactions for Code Copy, Open in Canvas, Thinking Accordion, Tool Output Copy, Message Copy, and Tool Details
  chatContainer.addEventListener('click', (e) => {
    // 1. Open code in Canvas button (Grok Bot & OpenBot Parity)
    const openCanvasBtn = e.target.closest('.btn-open-canvas');
    if (openCanvasBtn) {
      e.stopPropagation();
      const codeBlock = openCanvasBtn.closest('.code-block-wrapper');
      const codeEl = codeBlock ? codeBlock.querySelector('code') : null;
      const codeText = codeEl ? codeEl.textContent : '';
      const lang = openCanvasBtn.dataset.lang || 'text';
      if (codeText && artifactCanvas) {
        artifactCanvas.openArtifact({
          // Snippets share a title, so give each its own tab instead of letting
          // them overwrite one another.
          key: `snippet:${lang}:${Date.now()}`,
          title: `${lang.toUpperCase()} Snippet`,
          language: lang,
          content: codeText,
          autoPreview: true,
        });
      }
      return;
    }

    // 2. Copy code button
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

    // 1.5 Copy tool output button
    const copyToolBtn = e.target.closest('.btn-copy-tool-output');
    if (copyToolBtn) {
      e.stopPropagation();
      const toolLine = copyToolBtn.closest('.tool-line');
      const rawText = toolLine?._rawResult || toolLine?.querySelector('.tool-result-pre')?.textContent || '';
      if (rawText) {
        navigator.clipboard.writeText(rawText).then(() => {
          copyToolBtn.textContent = '✓ Copied!';
          copyToolBtn.classList.add('copied');
          setTimeout(() => {
            copyToolBtn.textContent = 'Copy Output';
            copyToolBtn.classList.remove('copied');
          }, 1500);
        });
      }
      return;
    }

    // 1.8 Copy message button
    const copyMsgBtn = e.target.closest('.btn-copy-msg');
    if (copyMsgBtn) {
      e.stopPropagation();
      const msg = copyMsgBtn.closest('.message');
      const contentEl = msg?.querySelector('.message-content');
      const textToCopy = msg?._rawContent || contentEl?.innerText || '';
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          copyMsgBtn.textContent = '✓';
          setTimeout(() => {
            copyMsgBtn.textContent = '📋';
          }, 1500);
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

    // 3.5 Tool fold output toggle
    const foldBtn = e.target.closest('.tool-fold-btn');
    if (foldBtn) {
      e.stopPropagation();
      const toolDetails = foldBtn.closest('.tool-line-details');
      const resultPre = toolDetails ? toolDetails.querySelector('.tool-result-pre') : null;
      if (resultPre) {
        const isFolded = resultPre.classList.toggle('folded');
        const lines = foldBtn.dataset.lines || '';
        foldBtn.textContent = isFolded ? `▾ Show full output (${lines} lines)` : '▴ Collapse output';
      }
      return;
    }

    // 4. Connect Card OAuth Button (OpenBot & Grok Bot Parity)
    const connectOAuthBtn = e.target.closest('.btn-connect-oauth');
    if (connectOAuthBtn) {
      e.stopPropagation();
      const card = connectOAuthBtn.closest('.connect-app-card');
      const serverId = connectOAuthBtn.dataset.server;
      const title = connectOAuthBtn.dataset.title;
      connectOAuthBtn.disabled = true;
      connectOAuthBtn.textContent = `Waiting for ${title}…`;

      const statusMsg = card?.querySelector('.connect-card-status-message');
      if (statusMsg) {
        statusMsg.classList.remove('hidden');
        statusMsg.textContent = 'Finish in the tab that opened, then return here.';
      }

      try {
        client.connectApp(serverId).then((flow) => {
          if (flow && flow.authUrl) {
            window.open(flow.authUrl, '_blank');
            const pollInterval = setInterval(async () => {
              const updated = await client.getConnector(serverId);
              if (updated && updated.status === 'connected') {
                clearInterval(pollInterval);
                const badge = card?.querySelector('.connect-card-badge');
                if (badge) {
                  badge.className = 'connect-card-badge badge-connected';
                  badge.textContent = 'Connected';
                }
                const actions = card?.querySelector('.connect-card-actions');
                if (actions) {
                  actions.innerHTML = `
                    <span class="connect-card-status-message" style="color: #10b981; font-weight: 500;">✓ ${escapeHtml(title)} is connected (${escapeHtml(updated.account || 'Authorized')})</span>
                    <button class="btn btn-primary btn-sm btn-carry-on" type="button" data-app="${escapeHtml(title)}">Continue Task ▶</button>
                  `;
                }
              }
            }, 1500);
            setTimeout(() => clearInterval(pollInterval), 60000);
          }
        }).catch((err) => {
          if (statusMsg) {
            statusMsg.style.color = 'var(--danger)';
            statusMsg.textContent = `Error: ${err.message}`;
          }
          connectOAuthBtn.disabled = false;
          connectOAuthBtn.textContent = `Connect ${title}`;
        });
      } catch (err) {
        connectOAuthBtn.disabled = false;
        connectOAuthBtn.textContent = `Connect ${title}`;
      }
      return;
    }

    // 5. Connect Card Manual Token Toggle
    const connectManualToggle = e.target.closest('.btn-connect-manual-toggle');
    if (connectManualToggle) {
      e.stopPropagation();
      const card = connectManualToggle.closest('.connect-app-card');
      const form = card?.querySelector('.connect-manual-form');
      if (form) form.classList.toggle('hidden');
      return;
    }

    // 6. Connect Card Save Token Button
    const saveTokenBtn = e.target.closest('.btn-save-token');
    if (saveTokenBtn) {
      e.stopPropagation();
      const card = saveTokenBtn.closest('.connect-app-card');
      const serverId = saveTokenBtn.dataset.server;
      const input = card?.querySelector('.connect-token-input');
      const token = input ? input.value.trim() : '';
      if (!token) {
        input?.focus();
        return;
      }
      saveTokenBtn.disabled = true;
      saveTokenBtn.textContent = 'Saving…';
      client.connectApp(serverId, { token }).then((res) => {
        const title = card?.dataset.title || serverId;
        const badge = card?.querySelector('.connect-card-badge');
        if (badge) {
          badge.className = 'connect-card-badge badge-connected';
          badge.textContent = 'Connected';
        }
        const actions = card?.querySelector('.connect-card-actions');
        if (actions) {
          actions.innerHTML = `
            <span class="connect-card-status-message" style="color: #10b981; font-weight: 500;">✓ ${escapeHtml(title)} is connected (${escapeHtml(res.account || 'Authorized')})</span>
            <button class="btn btn-primary btn-sm btn-carry-on" type="button" data-app="${escapeHtml(title)}">Continue Task ▶</button>
          `;
        }
        const form = card?.querySelector('.connect-manual-form');
        if (form) form.classList.add('hidden');
      }).catch((err) => {
        alert(`Failed to save credential: ${err.message}`);
        saveTokenBtn.disabled = false;
        saveTokenBtn.textContent = 'Save';
      });
      return;
    }

    // 7. Connect Card Carry-On Button
    const carryOnBtn = e.target.closest('.btn-carry-on');
    if (carryOnBtn) {
      e.stopPropagation();
      const appName = carryOnBtn.dataset.app || 'The app';
      carryOnBtn.disabled = true;
      carryOnBtn.textContent = 'Continuing…';
      if (promptInput) {
        promptInput.value = `${appName} is now connected. Please continue the task.`;
        submitTurn();
      }
      return;
    }
  });

  // --- Smart Scrolling & Viewport Hygiene ---
  const btnScrollBottom = document.getElementById('btnScrollBottom');

  function isUserScrolledUp() {
    const threshold = 80;
    return (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) > threshold;
  }

  function smartScrollToBottom(force = false) {
    const isUp = isUserScrolledUp();
    if (btnScrollBottom) {
      if (isUp) {
        btnScrollBottom.classList.remove('hidden');
      } else {
        btnScrollBottom.classList.add('hidden');
      }
    }
    if (force || !isUp) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }

  if (btnScrollBottom) {
    btnScrollBottom.onclick = () => smartScrollToBottom(true);
  }

  chatContainer.addEventListener('scroll', () => {
    if (btnScrollBottom) {
      if (isUserScrolledUp()) {
        btnScrollBottom.classList.remove('hidden');
      } else {
        btnScrollBottom.classList.add('hidden');
      }
    }
  });

  // --- Thought Process Renderer ---
  function renderThoughtBlock(thoughtEl, thoughtText, isStreaming = false) {
    if (!thoughtEl) return;
    if (!thoughtText || !thoughtText.trim()) {
      thoughtEl.innerHTML = '';
      thoughtEl.classList.add('hidden');
      return;
    }
    thoughtEl.classList.remove('hidden');

    const trimmed = thoughtText.trim();
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    const headerTitle = isStreaming ? `Thinking (${words} words)...` : `Thought process (${words} words)`;

    const existingBody = thoughtEl.querySelector('.thought-body');
    const wasExpanded = existingBody && !existingBody.classList.contains('hidden');
    const shouldBeOpen = isStreaming || wasExpanded;

    thoughtEl.innerHTML = `
      <div class="thought-accordion ${isStreaming ? 'thought-streaming' : ''}">
        <div class="thought-header">
          <span class="thought-toggle">${shouldBeOpen ? '▼' : '▶'}</span>
          <span class="thought-icon">${isStreaming ? '⏳' : '💭'}</span>
          <span class="thought-label">${escapeHtml(headerTitle)}</span>
        </div>
        <div class="thought-body ${shouldBeOpen ? '' : 'hidden'}">${escapeHtml(trimmed)}</div>
      </div>
    `;
  }

  // --- Session History & Turn Reconstruction ---
  function parseTranscriptTextFallback(transcriptText) {
    if (!transcriptText || typeof transcriptText !== 'string') return [];
    const turns = [];
    const userQueryRegex = /<user_query>([\s\S]*?)<\/user_query>/gi;
    let match;
    const queries = [];
    while ((match = userQueryRegex.exec(transcriptText)) !== null) {
      queries.push({
        query: match[1].trim(),
        startIndex: match.index,
        endIndex: userQueryRegex.lastIndex,
      });
    }

    if (queries.length === 0) {
      return [{ role: 'assistant', content: transcriptText.trim() }];
    }

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      turns.push({ role: 'user', content: q.query });

      const assistantStart = q.endIndex;
      const assistantEnd = (i + 1 < queries.length) ? queries[i + 1].startIndex : transcriptText.length;
      let assistantSection = transcriptText.slice(assistantStart, assistantEnd).trim();
      assistantSection = assistantSection.replace(/^assistant:\s*/i, '').trim();

      if (assistantSection) {
        turns.push({ role: 'assistant', content: assistantSection });
      }
    }

    return turns;
  }

  function reconstructDialogueTurns(sessionData) {
    const rawEvents = Array.isArray(sessionData)
      ? sessionData
      : (Array.isArray(sessionData?.events) ? sessionData.events : []);
    const transcriptText = sessionData?.transcript || '';

    if (rawEvents.length === 0 && transcriptText) {
      return parseTranscriptTextFallback(transcriptText);
    }

    const turns = [];
    let currentAssistantTurn = null;

    for (const ev of rawEvents) {
      if (!ev || typeof ev !== 'object') continue;

      if (ev.role === 'user') {
        if (currentAssistantTurn) {
          turns.push(currentAssistantTurn);
          currentAssistantTurn = null;
        }
        turns.push({
          role: 'user',
          content: ev.content || '',
          timestamp: ev.timestamp || null,
        });
        continue;
      }

      if (ev.role === 'assistant') {
        if (!currentAssistantTurn) {
          currentAssistantTurn = {
            role: 'assistant',
            content: '',
            thought: '',
            toolCalls: [],
            blocks: [],
            timestamp: ev.timestamp || null,
          };
        }
        if (!currentAssistantTurn.blocks) currentAssistantTurn.blocks = [];

        let content = ev.content || '';
        if (content) {
          const thinkingMatch = content.match(/<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/i);
          if (thinkingMatch) {
            currentAssistantTurn.thought = (currentAssistantTurn.thought ? currentAssistantTurn.thought + '\n' : '') + thinkingMatch[1].trim();
            content = content.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, '').trim();
          }
          if (content) {
            currentAssistantTurn.content = (currentAssistantTurn.content ? currentAssistantTurn.content + '\n\n' : '') + content;
            currentAssistantTurn.blocks.push({ type: 'text', content });
          }
        }

        if (ev.tool_calls && Array.isArray(ev.tool_calls) && ev.tool_calls.length > 0) {
          const callItems = [];
          for (const tc of ev.tool_calls) {
            const item = {
              id: tc.id,
              name: tc.function?.name || tc.name,
              args: tc.function?.arguments || tc.args,
              status: 'running',
              result: null,
            };
            currentAssistantTurn.toolCalls.push(item);
            callItems.push(item);
          }
          currentAssistantTurn.blocks.push({ type: 'tools', toolCalls: callItems });
        }
        continue;
      }

      if (ev.role === 'tool') {
        if (!currentAssistantTurn) {
          currentAssistantTurn = {
            role: 'assistant',
            content: '',
            thought: '',
            toolCalls: [],
            timestamp: ev.timestamp || null,
          };
        }
        const matched = currentAssistantTurn.toolCalls.find(tc => tc.id === ev.tool_call_id)
          || currentAssistantTurn.toolCalls.find(tc => tc.status === 'running');
        if (matched) {
          matched.status = 'done';
          matched.result = ev.result;
        } else {
          currentAssistantTurn.toolCalls.push({
            id: ev.tool_call_id,
            name: 'tool',
            args: {},
            status: 'done',
            result: ev.result,
          });
        }
        continue;
      }

      if (ev.type === 'thought' || ev.role === 'thought') {
        if (!currentAssistantTurn) {
          currentAssistantTurn = {
            role: 'assistant',
            content: '',
            thought: '',
            toolCalls: [],
            timestamp: ev.timestamp || null,
          };
        }
        const t = ev.data?.thought || ev.thought || '';
        if (t) {
          currentAssistantTurn.thought = (currentAssistantTurn.thought ? currentAssistantTurn.thought + '\n' : '') + t;
        }
        continue;
      }
    }

    if (currentAssistantTurn) {
      turns.push(currentAssistantTurn);
    }

    return turns;
  }

  async function selectSession(sessionId) {
    forceResetTurnState();
    currentSessionId = sessionId;
    persistSession();
    switchView('chat');
    activeSessionTitle.textContent = `Session: ${sessionId}`;
    messageFeed.innerHTML = '';
    welcomeBanner.classList.add('hidden');

    try {
      const sessionData = await client.loadSession(sessionId);
      const restoredAgentId = sessionData?.agentId || null;
      if (restoredAgentId && restoredAgentId !== activeAgentId) {
        const liveAgents = await client.getAgents().catch(() => []);
        if (Array.isArray(liveAgents) && liveAgents.some((a) => a.id === restoredAgentId)) {
          activeAgentId = restoredAgentId;
          localStorage.setItem(AGENT_KEY, restoredAgentId);
          await refreshBots();
          refreshTokenBadge();
        }
      }
      const turns = reconstructDialogueTurns(sessionData);
      for (const turn of turns) {
        appendMessage(turn.role, turn.content, turn.toolCalls, turn.thought, turn.timestamp, turn.blocks);
      }
      smartScrollToBottom(true);
    } catch (err) {
      console.error('Error loading session:', err);
      messageFeed.innerHTML = `<div class="message message-assistant"><div class="message-body" style="color: var(--danger)">Error loading session: ${escapeHtml(err.message)}</div></div>`;
    }
    refreshSessions();
    refreshTokenBadge();
  }

  function startNewSession() {
    forceResetTurnState();
    currentSessionId = null;
    localStorage.removeItem(SESSION_KEY);
    activeSessionTitle.textContent = 'New Session';
    messageFeed.innerHTML = '';
    welcomeBanner.classList.remove('hidden');
    switchView('chat');
    refreshSessions();
    refreshTokenBadge();
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
    btnMenuClearSessions.onclick = async () => {
      if (accountPopup) accountPopup.classList.add('hidden');
      if (confirm('Are you sure you want to clear all conversation history? This will permanently delete all session records.')) {
        try {
          await client.clearAllSessions();
          startNewSession();
        } catch (err) {
          alert(`Error clearing history: ${err.message}`);
        }
      }
    };
  }

  function appendMessage(role, content = '', toolCalls = [], thought = '', timestamp = null, blocks = null) {
    welcomeBanner.classList.add('hidden');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message message-${role}`;
    msgDiv._rawContent = content || '';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const body = document.createElement('div');
    body.className = 'message-body';

    const thoughtEl = document.createElement('div');
    thoughtEl.className = 'message-thought-container';

    const toolsEl = document.createElement('div');
    toolsEl.className = 'message-tools-container';

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    const actionsEl = document.createElement('div');
    actionsEl.className = 'message-actions';

    const timeLabel = document.createElement('span');
    timeLabel.className = 'message-time';
    const dateObj = timestamp ? new Date(timestamp) : new Date();
    timeLabel.textContent = isNaN(dateObj.getTime()) ? '' : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const btnCopy = document.createElement('button');
    btnCopy.className = 'btn-msg-action btn-copy-msg';
    btnCopy.title = 'Copy message';
    btnCopy.textContent = '📋';

    actionsEl.appendChild(timeLabel);
    actionsEl.appendChild(btnCopy);

    if (thought) {
      renderThoughtBlock(thoughtEl, thought, false);
    }

    if (role === 'user') {
      if (content) contentEl.textContent = content;
      body.appendChild(contentEl);
    } else {
      body.appendChild(thoughtEl);

      // If structured interleaved blocks are provided, render them in sequence:
      if (blocks && Array.isArray(blocks) && blocks.length > 0) {
        for (const b of blocks) {
          if (b.type === 'text' && b.content) {
            const textEl = document.createElement('div');
            textEl.className = 'message-content turn-text-block';
            textEl.innerHTML = renderMarkdown(b.content);
            body.appendChild(textEl);
          } else if (b.type === 'tools' && Array.isArray(b.toolCalls) && b.toolCalls.length > 0) {
            if (b.toolCalls.length === 1) {
              const tc = b.toolCalls[0];
              const toolEl = createToolLineElement(tc, tc.status || 'done', tc.result);
              body.appendChild(toolEl);
            } else {
              const group = createToolGroupElement();
              for (const tc of b.toolCalls) {
                const toolEl = createToolLineElement(tc, tc.status || 'done', tc.result);
                group.addTool(toolEl);
              }
              body.appendChild(group.element);
            }
          }
        }
      } else {
        if (toolCalls && toolCalls.length > 0) {
          if (toolCalls.length === 1) {
            toolsEl.appendChild(createToolLineElement(toolCalls[0], toolCalls[0].status || 'done', toolCalls[0].result));
          } else {
            const group = createToolGroupElement();
            for (const tc of toolCalls) {
              group.addTool(createToolLineElement(tc, tc.status || 'done', tc.result));
            }
            toolsEl.appendChild(group.element);
          }
          body.appendChild(toolsEl);
        }
        if (content) {
          contentEl.innerHTML = renderMarkdown(content);
        }
        body.appendChild(contentEl);
      }
    }
    body.appendChild(actionsEl);

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(body);
    messageFeed.appendChild(msgDiv);

    // Virtualize: keep the DOM bounded. Older messages are removed from
    // the DOM but remain in session storage (re-rendered on selectSession
    // if the user scrolls back — a simple cap is the interim fix).
    const MAX_DOM_MESSAGES = 100;
    while (messageFeed.children.length > MAX_DOM_MESSAGES) {
      const first = messageFeed.firstElementChild;
      if (first) messageFeed.removeChild(first);
    }

    smartScrollToBottom();

    return {
      msgDiv,
      body,
      thoughtEl,
      toolsEl,
      contentEl,
      actionsEl,
      activeTextBlock: null,
      activeToolGroup: null,
      currentSegmentText: '',
    };
  }

  // --- Staged Attachments Strip (OpenBot Parity) ---
  const stagedAttachments = [];

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function renderAttachmentStrip() {
    if (!attachmentStrip) return;
    if (stagedAttachments.length === 0) {
      attachmentStrip.classList.add('hidden');
      attachmentStrip.innerHTML = '';
      return;
    }

    attachmentStrip.classList.remove('hidden');
    attachmentStrip.innerHTML = '';

    stagedAttachments.forEach((att, index) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';

      let visual = '<span class="attachment-chip-icon">📄</span>';
      if (att.previewUrl) {
        visual = `<img src="${att.previewUrl}" class="attachment-thumb" alt="${escapeHtml(att.name)}" />`;
      } else if (att.type?.includes('image')) {
        visual = '<span class="attachment-chip-icon">🖼️</span>';
      } else if (att.type?.includes('code') || att.name?.endsWith('.ts') || att.name?.endsWith('.js') || att.name?.endsWith('.py')) {
        visual = '<span class="attachment-chip-icon">💻</span>';
      }

      chip.innerHTML = `
        ${visual}
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
          <span class="attachment-chip-size">${formatBytes(att.size)}</span>
        </div>
        <button class="btn-remove-attachment" type="button" title="Remove attachment" data-index="${index}">&times;</button>
      `;

      chip.querySelector('.btn-remove-attachment').onclick = async (e) => {
        e.stopPropagation();
        const removed = stagedAttachments.splice(index, 1)[0];
        if (removed?.previewUrl) {
          try { URL.revokeObjectURL(removed.previewUrl); } catch {}
        }
        if (removed && removed.serverId) {
          try {
            await client.deleteAttachment(removed.serverId);
          } catch {
            // ignore
          }
        }
        renderAttachmentStrip();
      };

      attachmentStrip.appendChild(chip);
    });
  }

  async function addFileToStaged(file) {
    if (!file) return;
    const isImage = file.type && file.type.startsWith('image/');
    let previewUrl = null;
    if (isImage && typeof URL !== 'undefined' && URL.createObjectURL) {
      try {
        previewUrl = URL.createObjectURL(file);
      } catch {
        // ignore
      }
    }

    const stagedItem = {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      localPath: file.path || file.name,
      previewUrl,
      serverId: null,
    };

    try {
      const res = await client.stageAttachment(file.path || file.name);
      if (res && res.id) {
        stagedItem.serverId = res.id;
      }
    } catch (err) {
      console.warn('Backend file staging note (local-first fallback):', err.message);
    }

    stagedAttachments.push(stagedItem);
    renderAttachmentStrip();
  }

  // File Picker (No annoying alert dialogs!)
  const fileAttachmentInput = document.getElementById('fileAttachmentInput');
  const btnStageFile = document.getElementById('btnStageFile');
  if (btnStageFile && fileAttachmentInput) {
    btnStageFile.onclick = () => fileAttachmentInput.click();
    fileAttachmentInput.onchange = async () => {
      const files = Array.from(fileAttachmentInput.files || []);
      for (const f of files) {
        await addFileToStaged(f);
      }
      fileAttachmentInput.value = '';
    };
  }

  // Drag and Drop files onto composer and chat window
  ['dragenter', 'dragover'].forEach((eventName) => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
      if (inputWrapper) inputWrapper.classList.add('drag-over');
    }, false);
  });

  ['dragleave', 'dragend'].forEach((eventName) => {
    window.addEventListener(eventName, (e) => {
      e.preventDefault();
      if (inputWrapper && (!e.relatedTarget || e.relatedTarget === document.documentElement)) {
        inputWrapper.classList.remove('drag-over');
      }
    }, false);
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (inputWrapper) inputWrapper.classList.remove('drag-over');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      for (const f of files) {
        await addFileToStaged(f);
      }
    }
  }, false);

  // --- Voice Dictation (Web Speech API) ---
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let dictationRecognition = null;
  let isDictating = false;

  if (btnDictate) {
    if (!SpeechRecognition) {
      btnDictate.title = 'Speech recognition not supported in this browser environment';
      btnDictate.style.opacity = '0.5';
    } else {
      dictationRecognition = new SpeechRecognition();
      dictationRecognition.continuous = true;
      dictationRecognition.interimResults = true;
      dictationRecognition.lang = 'en-US';

      let basePrompt = '';

      dictationRecognition.onstart = () => {
        isDictating = true;
        btnDictate.classList.add('recording');
        const textSpan = btnDictate.querySelector('span');
        if (textSpan) textSpan.textContent = 'Listening...';
        basePrompt = promptInput.value;
      };

      dictationRecognition.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        const separator = basePrompt && !basePrompt.endsWith(' ') ? ' ' : '';
        promptInput.value = basePrompt + separator + final + interim;
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(220, promptInput.scrollHeight) + 'px';
      };

      dictationRecognition.onerror = (err) => {
        console.warn('Dictation error:', err);
        stopDictation();
      };

      dictationRecognition.onend = () => {
        stopDictation();
      };

      function stopDictation() {
        isDictating = false;
        btnDictate.classList.remove('recording');
        const textSpan = btnDictate.querySelector('span');
        if (textSpan) textSpan.textContent = 'Dictate';
      }

      btnDictate.onclick = () => {
        if (isDictating) {
          dictationRecognition.stop();
          stopDictation();
        } else {
          try {
            dictationRecognition.start();
          } catch (e) {
            console.error('Failed to start speech recognition:', e);
          }
        }
      };
    }
  }

  // --- Autocomplete Trigger Popover (/, @, #) ---
  let triggerActiveIndex = 0;
  let currentTriggerItems = [];
  let currentTriggerStartPos = -1;

  const DEFAULT_SLASH_COMMANDS = [
    { icon: '🏗️', title: '/audit', desc: 'Conduct architectural & code health audit', tag: 'Command' },
    { icon: '🧹', title: '/compact', desc: 'Auto-compact conversation history', tag: 'Command' },
    { icon: '⏪', title: '/rewind', desc: 'Rollback previous conversation turn', tag: 'Command' },
    { icon: '💡', title: '/btw', desc: 'Ask ephemeral side question without context clutter', tag: 'Command' },
    { icon: '🧠', title: '/habits', desc: 'View learned cognitive rules & habits', tag: 'Command' },
    { icon: '🗑️', title: '/clear', desc: 'Clear dialogue session history', tag: 'Command' },
    { icon: '🩺', title: '/doctor', desc: 'Run harness preflight diagnostic health check', tag: 'Command' },
  ];

  async function updateTriggerSuggestions() {
    if (!triggerPopover) return;
    const text = promptInput.value;
    const caret = promptInput.selectionStart;

    const leftText = text.slice(0, caret);
    const match = leftText.match(/(?:^|\s)([/@#])([a-zA-Z0-9_\-]*)$/);

    if (!match) {
      hideTriggerPopover();
      return;
    }

    const triggerChar = match[1];
    const query = match[2].toLowerCase();
    currentTriggerStartPos = caret - match[0].length + (match[0].startsWith(' ') ? 1 : 0);

    let items = [];

    if (triggerChar === '/') {
      const staticMatches = DEFAULT_SLASH_COMMANDS.filter((c) =>
        c.title.toLowerCase().includes(query) || c.desc.toLowerCase().includes(query)
      );
      items.push(...staticMatches);
      try {
        const skills = await client.listSkills();
        if (skills && Array.isArray(skills)) {
          for (const s of skills) {
            const name = s.name || s.id;
            if (name.toLowerCase().includes(query)) {
              items.push({
                icon: '🧩',
                title: `/${name}`,
                desc: s.description || 'Modular recipe skill',
                tag: 'Skill',
              });
            }
          }
        }
      } catch {
        // ignore
      }
    } else if (triggerChar === '@') {
      items.push({
        icon: '🤖',
        title: '@Default Assistant',
        desc: 'Universal clean-room coding assistant',
        tag: 'Bot',
        agentId: null,
      });
      try {
        const agents = await client.getAgents();
        if (agents && Array.isArray(agents)) {
          for (const a of agents) {
            if (a.name.toLowerCase().includes(query) || (a.role && a.role.toLowerCase().includes(query))) {
              items.push({
                icon: a.kind === 'ROOM' ? '👥' : '⚡',
                title: `@${a.name}`,
                desc: a.role || a.description || 'Specialist persona',
                tag: a.kind === 'ROOM' ? 'Room' : 'Agent',
                agentId: a.id,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    } else if (triggerChar === '#') {
      if (stagedAttachments.length > 0) {
        for (const a of stagedAttachments) {
          if (a.name.toLowerCase().includes(query)) {
            items.push({
              icon: '📎',
              title: `#${a.name}`,
              desc: `Staged attachment (${formatBytes(a.size)})`,
              tag: 'Attachment',
            });
          }
        }
      }
      try {
        const atts = await client.listAttachments();
        if (atts && Array.isArray(atts)) {
          for (const a of atts) {
            const fn = a.fileName || a.filename || a.id;
            if (fn.toLowerCase().includes(query)) {
              items.push({
                icon: '📄',
                title: `#${fn}`,
                desc: a.localPath || 'Context file',
                tag: 'File',
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (items.length === 0) {
      hideTriggerPopover();
      return;
    }

    currentTriggerItems = items;
    triggerActiveIndex = Math.min(triggerActiveIndex, items.length - 1);
    if (triggerActiveIndex < 0) triggerActiveIndex = 0;

    renderTriggerPopover(items, triggerChar);
  }

  function renderTriggerPopover(items, triggerChar) {
    if (!triggerPopover) return;
    triggerPopover.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'trigger-popover-header';
    header.textContent = triggerChar === '/' ? 'Skills & Slash Commands' : triggerChar === '@' ? 'Mention / Switch Bot Persona' : 'Reference Files & Attachments';
    triggerPopover.appendChild(header);

    items.slice(0, 8).forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = `trigger-item ${idx === triggerActiveIndex ? 'active' : ''}`;
      el.innerHTML = `
        <span class="trigger-item-icon">${item.icon}</span>
        <div class="trigger-item-meta">
          <span class="trigger-item-title">${escapeHtml(item.title)}</span>
          <span class="trigger-item-desc">${escapeHtml(item.desc)}</span>
        </div>
        <span class="trigger-item-tag">${escapeHtml(item.tag)}</span>
      `;

      el.onclick = () => selectTriggerItem(idx);
      el.onmouseenter = () => {
        triggerActiveIndex = idx;
        updateTriggerItemHighlight();
      };
      triggerPopover.appendChild(el);
    });

    triggerPopover.classList.remove('hidden');
  }

  function hideTriggerPopover() {
    if (triggerPopover) {
      triggerPopover.classList.add('hidden');
      triggerPopover.innerHTML = '';
    }
    currentTriggerItems = [];
    currentTriggerStartPos = -1;
    triggerActiveIndex = 0;
  }

  function selectTriggerItem(index) {
    const item = currentTriggerItems[index];
    if (!item) return;

    const text = promptInput.value;
    const caret = promptInput.selectionStart;
    const before = text.slice(0, currentTriggerStartPos);
    const after = text.slice(caret);

    if (item.tag === 'Command') {
      if (item.title === '/compact') {
        hideTriggerPopover();
        promptInput.value = '';
        document.getElementById('btnOpenCompact')?.click();
        return;
      }
      if (item.title === '/rewind') {
        hideTriggerPopover();
        promptInput.value = '';
        document.getElementById('btnOpenRollback')?.click();
        return;
      }
      if (item.title === '/btw') {
        hideTriggerPopover();
        promptInput.value = '';
        document.getElementById('btnOpenBtw')?.click();
        return;
      }
      if (item.title === '/habits') {
        hideTriggerPopover();
        promptInput.value = '';
        document.getElementById('btnViewLearnedRules')?.click();
        return;
      }
      if (item.title === '/clear') {
        hideTriggerPopover();
        promptInput.value = '';
        document.getElementById('btnMenuClearSessions')?.click();
        return;
      }
    }

    if (item.tag === 'Bot' || item.tag === 'Agent' || item.tag === 'Room') {
      if (item.agentId !== undefined) {
        activeAgentId = item.agentId;
        badgeActiveBot.textContent = `${item.icon} ${item.title.replace(/^@/, '')}`;
        persistAgent();
      }
    }

    promptInput.value = before + item.title + ' ' + after;
    const newPos = before.length + item.title.length + 1;
    promptInput.setSelectionRange(newPos, newPos);

    hideTriggerPopover();
    promptInput.focus();
  }

  function updateTriggerItemHighlight() {
    if (!triggerPopover) return;
    const items = triggerPopover.querySelectorAll('.trigger-item');
    items.forEach((item, idx) => {
      if (idx === triggerActiveIndex) {
        item.classList.add('active');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('active');
      }
    });
  }

  // Dismiss trigger popover when clicking outside
  document.addEventListener('click', (e) => {
    if (triggerPopover && !triggerPopover.classList.contains('hidden')) {
      if (!triggerPopover.contains(e.target) && e.target !== promptInput) {
        hideTriggerPopover();
      }
    }
  });

  async function submitQuery() {
    let q = promptInput.value.trim();
    if (!q && stagedAttachments.length === 0) return;

    if (stagedAttachments.length > 0) {
      const attSummary = stagedAttachments
        .map((a) => `[Attachment: ${a.name} (${formatBytes(a.size)}) - ${a.localPath || a.name}]`)
        .join('\n');
      q = q ? `${q}\n\n${attSummary}` : `Please inspect and process the attached context files:\n${attSummary}`;
      stagedAttachments.length = 0;
      renderAttachmentStrip();
    }

    // Never block typing: queue follow-ups, send when the current reply finishes.
    if (turnBusy) {
      queuedQueries.push(q);
      promptInput.value = '';
      promptInput.style.height = 'auto';
      updateQueueIndicator();
      promptInput.focus();
      return;
    }

    promptInput.value = '';
    promptInput.style.height = 'auto';
    setTurnBusy(true);
    botStatusAvatar.textContent = '⏳';
    botStatusText.textContent = 'Thinking...';

    appendMessage('user', q);

    currentAssistantMessage = appendMessage('assistant', '');
    currentAssistantMessage.contentEl.innerHTML = '<span class="typing-shimmer">Thinking…</span>';
    currentAssistantText = '';
    currentAssistantThought = '';
    activeToolLines = [];
    activeTurnExtraChars = q.length;

    // Immediately reflect the user's prompt in the token display
    const userPromptDelta = Math.ceil(activeTurnExtraChars / 3.8);
    updateTokenDisplay(
      (latestTelemetryData.estimatedTokens || 0) + userPromptDelta,
      latestTelemetryData.maxContextTokens,
      latestTelemetryData.model
    );

    try {
      const res = await client.sendQuery(q, currentSessionId, activeAgentId);
      if (res && res.sessionId) {
        if (currentSessionId !== res.sessionId) {
          currentSessionId = res.sessionId;
          activeSessionTitle.textContent = `Session: ${currentSessionId}`;
          persistSession();
        }
      }
    } catch (err) {
      if (currentAssistantMessage) {
        if (!currentAssistantText) currentAssistantMessage.contentEl.innerHTML = '';
        currentAssistantMessage.contentEl.innerHTML += `<div style="color: var(--danger); margin-top: 8px;">Error: ${escapeHtml(err.message)}</div>`;
      }
      setTurnBusy(false);
      queuedQueries = [];
      updateQueueIndicator();
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
      activeTurnExtraChars = 0;
      refreshTokenBadge();
    }
  }

  btnSend.onclick = submitQuery;

  if (btnStop) {
    btnStop.onclick = async () => {
      try {
        await client.cancelTurn();
      } catch (err) {
        console.error('Error cancelling turn:', err);
      }
      forceResetTurnState('Turn stopped by user.');
    };
  }

  // Esc stops generation or closes detail panel / trigger popover / artifact canvas
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (triggerPopover && !triggerPopover.classList.contains('hidden')) {
        hideTriggerPopover();
        return;
      }
      if (artifactCanvas && artifactCanvas.getState().isOpen) {
        if (artifactCanvas.getState().isFullscreen) {
          artifactCanvas.setFullscreen(false);
        } else {
          artifactCanvas.closeArtifact();
        }
        return;
      }
      if (detailPanel && !detailPanel.classList.contains('hidden')) {
        closeDetailPanel();
        return;
      }
      if (turnBusy) {
        e.preventDefault();
        client.cancelTurn().catch(() => {});
        forceResetTurnState('Turn stopped by user.');
      }
    }
  });

  // Auto-resize composer textarea & update suggestions
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(220, promptInput.scrollHeight) + 'px';
    updateTriggerSuggestions();
  });

  // Keyboard navigation for autocomplete & prompt submission
  promptInput.onkeydown = (e) => {
    if (triggerPopover && !triggerPopover.classList.contains('hidden') && currentTriggerItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        triggerActiveIndex = (triggerActiveIndex + 1) % currentTriggerItems.length;
        updateTriggerItemHighlight();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        triggerActiveIndex = (triggerActiveIndex - 1 + currentTriggerItems.length) % currentTriggerItems.length;
        updateTriggerItemHighlight();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectTriggerItem(triggerActiveIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideTriggerPopover();
        return;
      }
    }

    if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey || !e.shiftKey) {
        e.preventDefault();
        submitQuery();
      }
    }
  };

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
      if (turnBusy) {
        promptInput.focus();
        return;
      }
      submitQuery();
    };
  });

  const lastToolArgs = new Map();

  // Real-time Event Stream Handling
  client.onEvent((event) => {
    if (event.type === 'session_started') {
      const sessId = event.data?.sessionId || event.sessionId;
      if (sessId && currentSessionId !== sessId) {
        currentSessionId = sessId;
        activeSessionTitle.textContent = `Session: ${currentSessionId}`;
        persistSession();
      }
    }

    // Token delta stream
    if (event.type === 'token' || event.type === 'text_delta') {
      const delta = event.data?.token || event.token || event.text || '';
      if (delta && currentAssistantMessage) {
        const shimmer = currentAssistantMessage.msgDiv.querySelector('.typing-shimmer');
        if (shimmer) shimmer.remove();
        if (currentAssistantThought && currentAssistantMessage.thoughtEl.querySelector('.thought-streaming')) {
          renderThoughtBlock(currentAssistantMessage.thoughtEl, currentAssistantThought, false);
        }

        // If tools were previously running, close the active group so text appears BELOW the tools!
        if (currentAssistantMessage.activeToolGroup) {
          currentAssistantMessage.activeToolGroup = null;
        }

        // Ensure we have an active text block in the chronological flow
        if (!currentAssistantMessage.activeTextBlock) {
          const textBlock = document.createElement('div');
          textBlock.className = 'message-content turn-text-block';
          currentAssistantMessage.body.insertBefore(textBlock, currentAssistantMessage.actionsEl);
          currentAssistantMessage.activeTextBlock = textBlock;
          currentAssistantMessage.contentEl = textBlock;
          currentAssistantMessage.currentSegmentText = '';
        }

        currentAssistantText += delta;
        currentAssistantMessage.currentSegmentText = (currentAssistantMessage.currentSegmentText || '') + delta;
        currentAssistantMessage.msgDiv._rawContent = currentAssistantText;

        // Incremental: only re-render the trailing block for the new delta.
        const prevLen = currentAssistantMessage.activeTextBlock._mdLen || 0;
        const curSegLen = currentAssistantMessage.currentSegmentText.length;
        if (curSegLen - prevLen < 200 && currentAssistantMessage.activeTextBlock.innerHTML) {
          const tail = currentAssistantMessage.currentSegmentText.slice(prevLen);
          currentAssistantMessage.activeTextBlock.appendChild(document.createTextNode(tail));
        } else {
          currentAssistantMessage.activeTextBlock.innerHTML = renderMarkdownCached(currentAssistantMessage.currentSegmentText);
        }
        currentAssistantMessage.activeTextBlock._mdLen = curSegLen;
        smartScrollToBottom();

        botStatusAvatar.textContent = '✍️';
        botStatusText.textContent = 'Generating...';

        const totalLiveDelta = Math.ceil((activeTurnExtraChars + currentAssistantText.length) / 3.8);
        updateTokenDisplay(
          (latestTelemetryData.estimatedTokens || 0) + totalLiveDelta,
          latestTelemetryData.maxContextTokens,
          latestTelemetryData.model
        );
      }
    }

    // Thought delta stream
    if (event.type === 'thought') {
      const thought = event.data?.thought || event.thought || '';
      if (thought && currentAssistantMessage) {
        const shimmer = currentAssistantMessage.msgDiv.querySelector('.typing-shimmer');
        if (shimmer) shimmer.remove();
        currentAssistantThought += thought;
        renderThoughtBlock(currentAssistantMessage.thoughtEl, currentAssistantThought, true);
        smartScrollToBottom();
        botStatusAvatar.textContent = '💭';
        botStatusText.textContent = 'Thinking...';
      }
    }

    // Tool call started
    if (event.type === 'tool_call') {
      if (currentAssistantMessage) {
        const shimmer = currentAssistantMessage.msgDiv.querySelector('.typing-shimmer');
        if (shimmer) shimmer.remove();
        if (currentAssistantThought && currentAssistantMessage.thoughtEl.querySelector('.thought-streaming')) {
          renderThoughtBlock(currentAssistantMessage.thoughtEl, currentAssistantThought, false);
        }

        // Finalize preceding text block with full markdown parse
        if (currentAssistantMessage.activeTextBlock && currentAssistantMessage.currentSegmentText) {
          currentAssistantMessage.activeTextBlock.innerHTML = renderMarkdown(currentAssistantMessage.currentSegmentText);
          currentAssistantMessage.activeTextBlock = null;
          currentAssistantMessage.currentSegmentText = '';
        }

        const toolCall = event.data || event.toolCall || event;
        const toolEl = createToolLineElement(toolCall, 'running');
        activeToolLines.push(toolEl);

        // Group adjacent tool calls into a single collapsible activity container (OpenBot parity)
        if (!currentAssistantMessage.activeToolGroup) {
          currentAssistantMessage.activeToolGroup = createToolGroupElement(toolEl);
          currentAssistantMessage.body.insertBefore(currentAssistantMessage.activeToolGroup.element, currentAssistantMessage.actionsEl);
        } else {
          currentAssistantMessage.activeToolGroup.addTool(toolEl);
        }
        smartScrollToBottom();

        const toolName = toolCall.name || toolCall.function?.name || 'tool';
        let parsedArgs = {};
        try {
          parsedArgs = typeof toolCall.args === 'string' ? JSON.parse(toolCall.args) : (toolCall.args || {});
        } catch {
          parsedArgs = {};
        }
        lastToolArgs.set(toolName, parsedArgs);

        botStatusAvatar.textContent = '⚙️';
        botStatusText.textContent = `Running ${toolName}...`;

        const argsStr = typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args || {});
        activeTurnExtraChars += toolName.length + argsStr.length;
      }
    }

    // Tool call completed
    if (event.type === 'tool_result') {
      const toolName = event.data?.name || event.name;
      const result = event.data?.result !== undefined ? event.data.result : event.result;
      const targetEl = activeToolLines.find(el => el.classList.contains('tool-line-running') && (!toolName || el.dataset.toolName === toolName))
        || activeToolLines.find(el => el.classList.contains('tool-line-running'))
        || (currentAssistantMessage && currentAssistantMessage.msgDiv.querySelector('.tool-line-running'));
      if (targetEl) {
        updateToolLineStatus(targetEl, 'done', result);
      }
      smartScrollToBottom();

      botStatusAvatar.textContent = '⏳';
      botStatusText.textContent = 'Processing...';

      // Auto-open Artifact Canvas on file write / edit / git_diff (Grok Bot & OpenBot Parity)
      const callArgs = lastToolArgs.get(toolName) || {};
      if (toolName === 'write_file' && callArgs.path && callArgs.content && artifactCanvas) {
        const filePath = String(callArgs.path);
        const fileName = filePath.split('/').pop() || 'file';
        const ext = fileName.includes('.') ? fileName.split('.').pop() : 'text';
        artifactCanvas.openArtifact({
          title: fileName,
          filePath,
          language: ext,
          content: String(callArgs.content),
          autoPreview: true,
        });
      } else if (toolName === 'edit_file' && callArgs.path && artifactCanvas) {
        const filePath = String(callArgs.path);
        const fileName = filePath.split('/').pop() || 'file';
        const ext = fileName.includes('.') ? fileName.split('.').pop() : 'text';
        let diffPreview = '';
        if (callArgs.target && callArgs.replacement !== undefined) {
          diffPreview = `--- a/${fileName}\n+++ b/${fileName}\n@@ -1,1 +1,1 @@\n-${callArgs.target}\n+${callArgs.replacement}`;
        }
        artifactCanvas.openArtifact({
          title: `${fileName} (edit)`,
          filePath,
          language: ext,
          content: String(callArgs.replacement || ''),
          diff: diffPreview,
          defaultTab: diffPreview ? 'diff' : 'code',
        });
      } else if (toolName === 'git_diff' && result && artifactCanvas) {
        const diffText = typeof result === 'string' ? result : (result.output || (typeof result === 'object' ? JSON.stringify(result, null, 2) : ''));
        if (diffText && diffText.trim()) {
          artifactCanvas.openArtifact({
            title: 'Working Tree Diff',
            language: 'diff',
            content: diffText,
            diff: diffText,
            defaultTab: 'diff',
          });
        }
      }

      if (typeof result === 'string') {
        activeTurnExtraChars += result.length;
      } else if (result) {
        activeTurnExtraChars += JSON.stringify(result).length;
      }
      const totalLiveDelta = Math.ceil((activeTurnExtraChars + currentAssistantText.length) / 3.8);
      updateTokenDisplay(
        (latestTelemetryData.estimatedTokens || 0) + totalLiveDelta,
        latestTelemetryData.maxContextTokens,
        latestTelemetryData.model
      );
    }

    // Turn completed
    if (event.type === 'turn_complete') {
      if (currentAssistantMessage) {
        // Finalize active text block or content element
        if (currentAssistantMessage.activeTextBlock && currentAssistantMessage.currentSegmentText) {
          currentAssistantMessage.activeTextBlock.innerHTML = renderMarkdown(currentAssistantMessage.currentSegmentText);
          currentAssistantMessage.activeTextBlock._mdLen = 0;
        } else if (currentAssistantMessage.contentEl && currentAssistantText) {
          currentAssistantMessage.contentEl.innerHTML = renderMarkdown(currentAssistantText);
          currentAssistantMessage.msgDiv._mdLen = 0;
        }
        const shimmer = currentAssistantMessage.msgDiv.querySelector('.typing-shimmer');
        if (shimmer) shimmer.remove();
        if (currentAssistantThought) {
          renderThoughtBlock(currentAssistantMessage.thoughtEl, currentAssistantThought, false);
        }
        const runningLines = currentAssistantMessage.msgDiv.querySelectorAll('.tool-line-running');
        runningLines.forEach((el) => updateToolLineStatus(el, 'done'));

        const response = event.data?.response || event.response;
        if (response && !currentAssistantText.trim()) {
          currentAssistantText = response;
          currentAssistantMessage.msgDiv._rawContent = currentAssistantText;
          if (currentAssistantMessage.contentEl) {
            currentAssistantMessage.contentEl.innerHTML = renderMarkdown(currentAssistantText);
          }
        } else if (!currentAssistantText.trim() && !currentAssistantThought.trim() && !activeToolLines.length) {
          if (currentAssistantMessage.contentEl) {
            currentAssistantMessage.contentEl.innerHTML = '<span style="color: var(--text-muted);">(Turn completed)</span>';
          }
        }
      }
      setTurnBusy(false);
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
      activeTurnExtraChars = 0;
      refreshTokenBadge();
      smartScrollToBottom();
      if (queuedQueries.length > 0) {
        const next = queuedQueries.shift();
        updateQueueIndicator();
        promptInput.value = next;
        submitQuery();
      }
    }

    // Turn cancelled (user pressed Stop / Esc)
    if (event.type === 'turn_cancelled') {
      if (currentAssistantMessage) {
        if (!currentAssistantText.trim() && !currentAssistantThought.trim()) {
          currentAssistantMessage.contentEl.innerHTML = '';
        }
        currentAssistantMessage.contentEl.innerHTML += `<div style="color: var(--text-muted); margin-top: 8px;">⏹ Stopped.</div>`;
      }
      setTurnBusy(false);
      queuedQueries = [];
      updateQueueIndicator();
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
      activeTurnExtraChars = 0;
      refreshTokenBadge();
      smartScrollToBottom();
    }

    // Error event
    if (event.type === 'error') {
      const errMsg = event.data?.message || event.message || 'Unknown error occurred';
      if (currentAssistantMessage) {
        currentAssistantMessage.contentEl.innerHTML += `<div style="color: var(--danger); margin-top: 8px;">Error: ${escapeHtml(errMsg)}</div>`;
      }
      setTurnBusy(false);
      queuedQueries = [];
      updateQueueIndicator();
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
      activeTurnExtraChars = 0;
      refreshTokenBadge();
      smartScrollToBottom();
    }

    // Approval required — queued, never clobbered. Each approval gets its
    // own inline card; the legacy modal is only a fallback.
    if (event.type === 'approval_required') {
      const d = event.data || {};
      const req = event.request || d.request || d;
      const approvalId = event.approvalId || d.approvalId;
      const toolName = req.toolName || req.tool || 'Tool';
      const args = req.args || req.arguments || req.params || {};
      const reason = req.reason || d.reason || '';

      pendingApprovals.set(approvalId, { toolName, args, reason });
      renderApprovalQueue();

      // Keep modal in sync for any test/legacy consumers
      activeApprovalId = approvalId;
      if (approvalToolName) {
        approvalToolName.textContent = toolName;
        approvalArgsBox.textContent = JSON.stringify(args, null, 2);
      }
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

  const __approvalQueue = createApprovalQueue({ pendingApprovals, client });
  function renderApprovalQueue() {
    __approvalQueue.render();
    return;
    const queue = document.getElementById('approvalQueue'); // dead code below (module is canonical)
    if (!queue) {
      if (pendingApprovals.size > 0) {
        const first = pendingApprovals.entries().next().value;
        if (first) {
          const [id, req] = first;
          activeApprovalId = id;
          if (approvalToolName) approvalToolName.textContent = req.toolName;
          if (approvalArgsBox) approvalArgsBox.textContent = JSON.stringify(req.args, null, 2);
          const reasonEl = document.getElementById('approvalReason');
          if (reasonEl) {
            reasonEl.textContent = req.reason || '';
            reasonEl.style.display = req.reason ? '' : 'none';
            if (reasonEl.parentElement) reasonEl.parentElement.style.display = req.reason ? '' : 'none';
          }
          approvalModal.classList.remove('hidden');
        }
      } else {
        approvalModal.classList.add('hidden');
      }
      return;
    }

    queue.innerHTML = '';
    queue.classList.toggle('hidden', pendingApprovals.size === 0);

    for (const [id, req] of pendingApprovals) {
      const card = document.createElement('div');
      card.className = 'approval-card';
      card.dataset.approvalId = id;
      card.setAttribute('role', 'alertdialog');

      const title = document.createElement('div');
      title.className = 'approval-card-tool';
      title.textContent = `Tool: ${req.toolName}`;
      card.appendChild(title);

      if (req.reason) {
        const reasonEl = document.createElement('div');
        reasonEl.className = 'approval-card-reason';
        reasonEl.textContent = req.reason;
        card.appendChild(reasonEl);
      }

      const argsPre = document.createElement('pre');
      argsPre.className = 'approval-args-box';
      argsPre.textContent = JSON.stringify(req.args, null, 2);
      card.appendChild(argsPre);

      const actions = document.createElement('div');
      actions.className = 'approval-card-actions';

      const mkBtn = (label, action, cls) => {
        const b = document.createElement('button');
        b.className = `btn btn-sm ${cls}`;
        b.textContent = label;
        b.onclick = async () => {
          pendingApprovals.delete(id);
          renderApprovalQueue();
          await client.approveTool(id, { action });
        };
        actions.appendChild(b);
      };
      mkBtn('Approve Once', 'approve_once', 'btn-primary');
      mkBtn('Always Allow', 'always_allow', 'btn-secondary');
      mkBtn('Reject', 'reject', 'btn-ghost');

      card.appendChild(actions);
      queue.appendChild(card);
    }
  }

  // Approvals (legacy modal buttons delegate to the queue entry)
  btnApproveOnce.onclick = async () => {
    if (!activeApprovalId) return;
    pendingApprovals.delete(activeApprovalId);
    approvalModal.classList.add('hidden');
    renderApprovalQueue();
    await client.approveTool(activeApprovalId, { action: 'approve_once' });
    activeApprovalId = null;
  };

  btnAlwaysAllow.onclick = async () => {
    if (!activeApprovalId) return;
    pendingApprovals.delete(activeApprovalId);
    approvalModal.classList.add('hidden');
    renderApprovalQueue();
    await client.approveTool(activeApprovalId, { action: 'always_allow' });
    activeApprovalId = null;
  };

  btnRejectTool.onclick = async () => {
    if (!activeApprovalId) return;
    pendingApprovals.delete(activeApprovalId);
    approvalModal.classList.add('hidden');
    renderApprovalQueue();
    await client.approveTool(activeApprovalId, { action: 'reject' });
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
    refreshTemplates();
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
    if (turnBusy) return;
    promptInput.value = 'Call recognize_screen_text and extract text from the screen.';
    submitQuery();
  };
  btnQuickWindow.onclick = () => {
    if (turnBusy) return;
    promptInput.value = 'Call list_windows and show all open on-screen windows.';
    submitQuery();
  };

  // Settings Modal Elements & Model Suggestions
  const modelSuggestionsList = document.getElementById('modelSuggestionsList');
  const modelContextHint = document.getElementById('modelContextHint');
  let cachedModelList = [];

  async function populateModelSuggestions(provider, endpoint) {
    if (!modelSuggestionsList) return;
    try {
      const q = new URLSearchParams();
      if (provider) q.set('provider', provider);
      if (endpoint) q.set('endpoint', endpoint);
      const res = await fetch(`/api/models?${q.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.models)) {
        cachedModelList = data.models;
        modelSuggestionsList.innerHTML = '';
        for (const m of data.models) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = `${m.name || m.id} (~${(m.context_length || 0).toLocaleString()} tokens)`;
          modelSuggestionsList.appendChild(opt);
        }
        updateModelHint(settingModel?.value);
      }
    } catch {
      // Ignore
    }
  }

  function updateModelHint(modelId) {
    if (!modelContextHint) return;
    const match = cachedModelList.find((m) => m.id === modelId || m.id?.toLowerCase() === (modelId || '').toLowerCase());
    if (match && match.context_length) {
      modelContextHint.textContent = `⚡ Context: ${match.context_length.toLocaleString()} tokens`;
      modelContextHint.style.color = 'var(--accent)';
    } else {
      modelContextHint.textContent = '';
    }
  }

  if (settingModel) {
    settingModel.addEventListener('input', () => updateModelHint(settingModel.value));
  }

  if (settingProvider) {
    settingProvider.addEventListener('change', () => {
      const p = settingProvider.value;
      if (p === 'openrouter') {
        if (!settingEndpoint.value || settingEndpoint.value.includes('anthropic.com') || settingEndpoint.value.includes('localhost')) {
          settingEndpoint.value = 'https://openrouter.ai/api/v1';
        }
        if (!settingModel.value || settingModel.value.startsWith('claude-')) {
          settingModel.value = 'deepseek/deepseek-v4.1-flash-1017';
        }
      } else if (p === 'anthropic') {
        if (!settingEndpoint.value || settingEndpoint.value.includes('openrouter.ai') || settingEndpoint.value.includes('localhost')) {
          settingEndpoint.value = 'https://api.anthropic.com/v1/messages';
        }
        if (!settingModel.value || settingModel.value.includes('/')) {
          settingModel.value = 'claude-3-7-sonnet-20250219';
        }
      } else if (p === 'openai') {
        if (!settingEndpoint.value || settingEndpoint.value.includes('anthropic.com') || settingEndpoint.value.includes('openrouter.ai')) {
          settingEndpoint.value = 'http://localhost:11434/v1/chat/completions';
        }
        if (!settingModel.value || settingModel.value.startsWith('claude-') || settingModel.value.includes('/')) {
          settingModel.value = 'llama3.1';
        }
      }
      populateModelSuggestions(p, settingEndpoint.value);
    });
  }

  // Settings
  btnSettings.onclick = async () => {
    const s = await client.getSettings();
    let detectedProvider = s.provider || 'openai';
    if ((!s.provider || s.provider === 'openai') && s.endpoint?.includes('openrouter.ai')) {
      detectedProvider = 'openrouter';
    }
    settingProvider.value = detectedProvider;
    settingEndpoint.value = s.endpoint || '';
    settingModel.value = s.model || '';
    const hasStoredKey = !!s.apiKey && s.apiKey !== 'none';
    hasStoredApiKey = hasStoredKey;
    settingApiKey.value = '';
    settingApiKey.placeholder = hasStoredKey ? 'Saved (leave blank to keep)' : 'sk-...';
    settingAutoApprove.checked = !!s.autoApprove;
    settingsModal.classList.remove('hidden');
    populateModelSuggestions(settingProvider.value, settingEndpoint.value);
  };
  btnCloseSettings.onclick = () => settingsModal.classList.add('hidden');
  btnSaveSettings.onclick = async () => {
    const payload = {
      provider: settingProvider.value,
      endpoint: settingEndpoint.value,
      model: settingModel.value,
      autoApprove: settingAutoApprove.checked,
    };
    const newKey = settingApiKey.value.trim();
    if (newKey) payload.apiKey = newKey;
    await client.updateSettings(payload);
    settingsModal.classList.add('hidden');
    await refreshSettings();
    await refreshTokenBadge();
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
        } else {
          await refreshTokenBadge();
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
        } else {
          await refreshTokenBadge();
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

  // --- Configure Connector Modal Controls ---
  const configureConnectorModal = document.getElementById('configureConnectorModal');
  const btnCloseConfigureConnector = document.getElementById('btnCloseConfigureConnector');
  const btnCancelConfigureConnector = document.getElementById('btnCancelConfigureConnector');
  const btnSaveConnectorConfig = document.getElementById('btnSaveConnectorConfig');
  const btnRefreshConnectors = document.getElementById('btnRefreshConnectors');

  if (btnRefreshConnectors) {
    btnRefreshConnectors.onclick = () => refreshConnectors();
  }
  if (btnCloseConfigureConnector && configureConnectorModal) {
    btnCloseConfigureConnector.onclick = () => configureConnectorModal.classList.add('hidden');
  }
  if (btnCancelConfigureConnector && configureConnectorModal) {
    btnCancelConfigureConnector.onclick = () => configureConnectorModal.classList.add('hidden');
  }
  if (btnSaveConnectorConfig && configureConnectorModal) {
    btnSaveConnectorConfig.onclick = async () => {
      const id = document.getElementById('configureConnectorId').value;
      const account = document.getElementById('configureConnectorAccount').value.trim();
      const token = document.getElementById('configureConnectorToken').value.trim();

      if (!token) {
        alert('Please enter a token or API key.');
        return;
      }

      btnSaveConnectorConfig.disabled = true;
      btnSaveConnectorConfig.textContent = 'Saving…';
      try {
        await client.connectApp(id, { token, account });
        configureConnectorModal.classList.add('hidden');
        refreshConnectors();
      } catch (err) {
        alert(`Failed to save credential: ${err.message}`);
      } finally {
        btnSaveConnectorConfig.disabled = false;
        btnSaveConnectorConfig.textContent = 'Save & Connect';
      }
    };
  }

  // Escape HTML helper
  // escapeHtml: see modules/chat/markdown.js

  // Boot Initial Load
  initTheme();
  await refreshSettings();
  await refreshBots();
  // Validate persisted bot against live list
  if (activeAgentId) {
    const liveAgents = await client.getAgents();
    if (!liveAgents.some((a) => a.id === activeAgentId)) {
      activeAgentId = null;
      localStorage.removeItem(AGENT_KEY);
    } else {
      const picked = liveAgents.find((a) => a.id === activeAgentId);
      badgeActiveBot.textContent = `${picked.kind === 'ROOM' ? '👥' : '⚡'} ${picked.name}`;
    }
  }
  await refreshBots();
  await refreshTasks();
  await refreshSessions();
  // Validate persisted session against live list, then restore it
  if (currentSessionId) {
    const liveSessions = await client.getSessions();
    if (liveSessions.some((s) => s.id === currentSessionId)) {
      await selectSession(currentSessionId);
    } else {
      currentSessionId = null;
      localStorage.removeItem(SESSION_KEY);
    }
  }
  setTurnBusy(false);
  await refreshTokenBadge();
});
