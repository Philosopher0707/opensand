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
}

// UI Controller
document.addEventListener('DOMContentLoaded', async () => {
  const client = new OpenSandClient();

  // Elements
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

  // Create Bot modal elements
  const btnOpenCreateBot = document.getElementById('btnOpenCreateBot');
  const createBotModal = document.getElementById('createBotModal');
  const btnCloseCreateBot = document.getElementById('btnCloseCreateBot');
  const btnSaveBot = document.getElementById('btnSaveBot');
  const botName = document.getElementById('botName');
  const botRole = document.getElementById('botRole');
  const botSystemPrompt = document.getElementById('botSystemPrompt');
  const botModel = document.getElementById('botModel');

  // Create Task modal elements
  const btnOpenCreateTask = document.getElementById('btnOpenCreateTask');
  const createTaskModal = document.getElementById('createTaskModal');
  const btnCloseCreateTask = document.getElementById('btnCloseCreateTask');
  const btnSaveTask = document.getElementById('btnSaveTask');
  const taskTitle = document.getElementById('taskTitle');
  const taskPriority = document.getElementById('taskPriority');

  // Learned Rules modal elements
  const btnViewLearnedRules = document.getElementById('btnViewLearnedRules');
  const learnedRulesModal = document.getElementById('learnedRulesModal');
  const btnCloseLearnedRules = document.getElementById('btnCloseLearnedRules');
  const btnCloseLearnedRulesAction = document.getElementById('btnCloseLearnedRulesAction');
  const btnRefreshLearnedRules = document.getElementById('btnRefreshLearnedRules');
  const learnedRulesContent = document.getElementById('learnedRulesContent');

  // Settings modal elements
  const btnSettings = document.getElementById('btnSettings');
  const settingsModal = document.getElementById('settingsModal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const settingProvider = document.getElementById('settingProvider');
  const settingEndpoint = document.getElementById('settingEndpoint');
  const settingModel = document.getElementById('settingModel');
  const settingApiKey = document.getElementById('settingApiKey');
  const settingAutoApprove = document.getElementById('settingAutoApprove');

  // Quick Tools
  const btnQuickOcr = document.getElementById('btnQuickOcr');
  const btnQuickWindow = document.getElementById('btnQuickWindow');

  // State
  let currentSessionId = null;
  let activeAgentId = null;
  let activeAgentName = 'Default Assistant';
  let activeAssistantBubble = null;
  let currentApprovalId = null;

  // Auto-resize textarea
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + 'px';
  });

  // Load Initial Settings, Bots, Tasks, and Sessions
  async function refreshSettings() {
    try {
      const s = await client.getSettings();
      badgeModel.textContent = s.model || 'default';
      badgeAutoApprove.textContent = s.autoApprove ? '⚡ Auto-Approve' : '🛡 Safe Mode';
      badgeAutoApprove.className = s.autoApprove ? 'badge' : 'badge badge-success';
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  async function refreshBots() {
    try {
      const agents = await client.getAgents();
      botList.innerHTML = '';

      // Default Assistant Item
      const defaultItem = document.createElement('div');
      defaultItem.className = 'bot-item' + (activeAgentId === null ? ' active' : '');
      defaultItem.innerHTML = `
        <span class="bot-item-icon">⚡</span>
        <div class="bot-item-info">
          <span class="bot-item-name">Default Assistant</span>
          <span class="bot-item-role">Universal Coding Agent</span>
        </div>
      `;
      defaultItem.onclick = () => {
        activeAgentId = null;
        activeAgentName = 'Default Assistant';
        badgeActiveBot.textContent = '⚡ Default Assistant';
        refreshBots();
      };
      botList.appendChild(defaultItem);

      // Registered Bots
      for (const a of agents) {
        const item = document.createElement('div');
        item.className = 'bot-item' + (activeAgentId === a.id ? ' active' : '');
        const icon = a.name.toLowerCase().includes('cto') ? '👨‍💼' :
                     a.name.toLowerCase().includes('security') ? '🛡️' :
                     a.name.toLowerCase().includes('review') ? '🔍' : '🤖';
        item.innerHTML = `
          <span class="bot-item-icon">${icon}</span>
          <div class="bot-item-info">
            <span class="bot-item-name">${escapeHtml(a.name)}</span>
            <span class="bot-item-role">${escapeHtml(a.role)}</span>
          </div>
        `;
        item.onclick = () => {
          activeAgentId = a.id;
          activeAgentName = a.name;
          badgeActiveBot.textContent = `${icon} ${a.name}`;
          refreshBots();
        };
        botList.appendChild(item);
      }
    } catch (e) {
      console.error('Failed to load bots:', e);
    }
  }

  async function refreshTasks() {
    try {
      const tasks = await client.getTasks();
      taskList.innerHTML = '';
      if (tasks.length === 0) {
        taskList.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 4px;">No active tasks</div>';
        return;
      }

      for (const t of tasks) {
        const item = document.createElement('div');
        item.className = 'task-item' + (t.status === 'done' ? ' done' : '');
        item.innerHTML = `
          <input type="checkbox" class="task-checkbox" ${t.status === 'done' ? 'checked' : ''}>
          <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.title)}</span>
          <span class="badge" style="font-size: 9px; padding: 1px 4px;">${escapeHtml(t.priority)}</span>
        `;

        const checkbox = item.querySelector('.task-checkbox');
        checkbox.onchange = async () => {
          await client.updateTask(t.id, { status: checkbox.checked ? 'done' : 'todo' });
          await refreshTasks();
        };

        taskList.appendChild(item);
      }
    } catch (e) {
      console.error('Failed to load tasks:', e);
    }
  }

  async function refreshSessions() {
    try {
      const sessions = await client.getSessions();
      sessionList.innerHTML = '';
      for (const sess of sessions) {
        const item = document.createElement('div');
        item.className = 'session-item' + (sess.id === currentSessionId ? ' active' : '');
        item.textContent = sess.title || sess.id;
        item.title = sess.title;
        item.onclick = () => selectSession(sess.id);
        sessionList.appendChild(item);
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }

  async function selectSession(sessionId) {
    currentSessionId = sessionId;
    activeSessionTitle.textContent = sessionId;
    welcomeBanner.style.display = 'none';
    messageFeed.innerHTML = '';

    const data = await client.loadSession(sessionId);
    for (const evt of data.events) {
      if (evt.role === 'user') {
        appendUserMessage(evt.content);
      } else if (evt.role === 'assistant') {
        appendAssistantMessage(evt.content);
      } else if (evt.role === 'tool') {
        appendToolResultCard(evt.name, evt.content);
      }
    }
    scrollToBottom();
    refreshSessions();
  }

  function startNewSession() {
    currentSessionId = null;
    activeSessionTitle.textContent = 'New Session';
    messageFeed.innerHTML = '';
    welcomeBanner.style.display = 'block';
    refreshSessions();
  }

  function appendUserMessage(text) {
    welcomeBanner.style.display = 'none';
    const msg = document.createElement('div');
    msg.className = 'message message-user';
    msg.innerHTML = `
      <div class="message-bubble message-bubble-user">${escapeHtml(text)}</div>
    `;
    messageFeed.appendChild(msg);
    scrollToBottom();
  }

  function appendAssistantMessage(text = '') {
    welcomeBanner.style.display = 'none';
    const msg = document.createElement('div');
    msg.className = 'message message-assistant';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble message-bubble-assistant';
    bubble.textContent = text;
    msg.appendChild(bubble);
    messageFeed.appendChild(msg);
    activeAssistantBubble = bubble;
    scrollToBottom();
    return bubble;
  }

  function appendToolCard(name, args) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
      <div class="tool-card-header">
        <span class="tool-card-icon">⚡</span>
        <span class="tool-card-title">${escapeHtml(name)}</span>
        <span class="tool-badge">Running</span>
      </div>
      <pre class="tool-card-body">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
    `;
    messageFeed.appendChild(card);
    scrollToBottom();
    return card;
  }

  function appendToolResultCard(name, result) {
    const card = document.createElement('div');
    card.className = 'tool-card tool-card-result';
    card.innerHTML = `
      <div class="tool-card-header">
        <span class="tool-card-icon">✔</span>
        <span class="tool-card-title">${escapeHtml(name)} Result</span>
        <span class="tool-badge badge-success">Success</span>
      </div>
      <pre class="tool-card-body">${escapeHtml(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}</pre>
    `;
    messageFeed.appendChild(card);
    scrollToBottom();
  }

  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Handle Incoming Events (Tokens, Tools, Approvals)
  client.onEvent((event) => {
    if (event.type === 'token') {
      if (!activeAssistantBubble) {
        appendAssistantMessage('');
      }
      activeAssistantBubble.textContent += event.data.token;
      scrollToBottom();
    } else if (event.type === 'tool_call') {
      appendToolCard(event.data.name, event.data.args);
    } else if (event.type === 'tool_result') {
      appendToolResultCard(event.data.name, event.data.result);
      // Refresh tasks and bots in case agent created them via tools
      refreshBots();
      refreshTasks();
    } else if (event.type === 'turn_complete') {
      activeAssistantBubble = null;
      botStatusText.textContent = 'Ready';
      botStatusAvatar.textContent = '⚡';
      refreshSessions();
    } else if (event.type === 'error') {
      botStatusText.textContent = 'Error';
      const errBox = document.createElement('div');
      errBox.className = 'error-banner';
      errBox.textContent = `Error: ${event.data.message}`;
      messageFeed.appendChild(errBox);
      scrollToBottom();
    } else if (event.type === 'approval_required') {
      currentApprovalId = event.data.approvalId;
      approvalToolName.textContent = event.data.toolName;
      approvalArgsBox.textContent = JSON.stringify(event.data.args, null, 2);
      approvalModal.classList.remove('hidden');
    }
  });

  // Query Submission
  async function submitQuery() {
    const text = promptInput.value.trim();
    if (!text) return;

    promptInput.value = '';
    promptInput.style.height = 'auto';

    appendUserMessage(text);
    activeAssistantBubble = null;

    botStatusText.textContent = `${activeAgentName} Working...`;
    botStatusAvatar.textContent = '⏳';

    try {
      const res = await client.sendQuery(text, currentSessionId, activeAgentId);
      currentSessionId = res.sessionId;
      activeSessionTitle.textContent = currentSessionId;
    } catch (err) {
      botStatusText.textContent = 'Failed';
      console.error('sendQuery failed:', err);
    }
  }

  btnSend.onclick = submitQuery;
  promptInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuery();
    }
  };

  btnNewSession.onclick = startNewSession;

  // Approvals
  btnApproveOnce.onclick = async () => {
    if (currentApprovalId) {
      await client.approveTool(currentApprovalId, { action: 'approve_once' });
      approvalModal.classList.add('hidden');
      currentApprovalId = null;
    }
  };

  btnAlwaysAllow.onclick = async () => {
    if (currentApprovalId) {
      await client.approveTool(currentApprovalId, { action: 'always_allow' });
      approvalModal.classList.add('hidden');
      currentApprovalId = null;
    }
  };

  btnRejectTool.onclick = async () => {
    if (currentApprovalId) {
      await client.approveTool(currentApprovalId, { action: 'reject' });
      approvalModal.classList.add('hidden');
      currentApprovalId = null;
    }
  };

  // Prompt chips
  document.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.onclick = () => {
      promptInput.value = chip.dataset.query;
      submitQuery();
    };
  });

  // Create Bot Modal
  btnOpenCreateBot.onclick = () => {
    botName.value = '';
    botRole.value = '';
    botSystemPrompt.value = '';
    botModel.value = '';
    createBotModal.classList.remove('hidden');
  };

  btnCloseCreateBot.onclick = () => {
    createBotModal.classList.add('hidden');
  };

  btnSaveBot.onclick = async () => {
    const name = botName.value.trim();
    const role = botRole.value.trim();
    const system_prompt = botSystemPrompt.value.trim();
    const model = botModel.value.trim() || undefined;

    if (!name || !role || !system_prompt) {
      alert('Please fill out Name, Role, and System Prompt.');
      return;
    }

    await client.createAgent({ name, role, systemPrompt: system_prompt, model });
    createBotModal.classList.add('hidden');
    await refreshBots();
  };

  // Create Task Modal
  btnOpenCreateTask.onclick = () => {
    taskTitle.value = '';
    taskPriority.value = 'medium';
    createTaskModal.classList.remove('hidden');
  };

  btnCloseCreateTask.onclick = () => {
    createTaskModal.classList.add('hidden');
  };

  btnSaveTask.onclick = async () => {
    const title = taskTitle.value.trim();
    const priority = taskPriority.value;
    if (!title) return;

    await client.createTask({ title, priority, agentId: activeAgentId || undefined });
    createTaskModal.classList.add('hidden');
    await refreshTasks();
  };

  // Learned Rules Modal
  btnViewLearnedRules.onclick = async () => {
    learnedRulesContent.textContent = 'Loading learned user guidelines...';
    learnedRulesModal.classList.remove('hidden');
    const res = await client.getLearnedRules();
    learnedRulesContent.textContent = res.markdown || 'No continuous guidelines recorded yet.';
  };

  btnCloseLearnedRules.onclick = () => {
    learnedRulesModal.classList.add('hidden');
  };

  btnCloseLearnedRulesAction.onclick = () => {
    learnedRulesModal.classList.add('hidden');
  };

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

  // Settings Modal
  btnSettings.onclick = async () => {
    const s = await client.getSettings();
    settingProvider.value = s.provider || 'openai';
    settingEndpoint.value = s.endpoint || '';
    settingModel.value = s.model || '';
    settingApiKey.value = s.apiKey || '';
    settingAutoApprove.checked = !!s.autoApprove;
    settingsModal.classList.remove('hidden');
  };

  btnCloseSettings.onclick = () => {
    settingsModal.classList.add('hidden');
  };

  btnSaveSettings.onclick = async () => {
    const updated = {
      provider: settingProvider.value,
      endpoint: settingEndpoint.value,
      model: settingModel.value,
      apiKey: settingApiKey.value,
      autoApprove: settingAutoApprove.checked,
    };
    await client.updateSettings(updated);
    settingsModal.classList.add('hidden');
    await refreshSettings();
  };

  // Boot Initial Load
  await refreshSettings();
  await refreshBots();
  await refreshTasks();
  await refreshSessions();
});
