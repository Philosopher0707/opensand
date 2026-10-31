/**
 * OpenSand Desktop Renderer Application Controller
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

  async sendQuery(query, sessionId) {
    if (this.isElectron) {
      return window.opensand.sendQuery(query, sessionId);
    }
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, sessionId }),
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
  const activeSessionTitle = document.getElementById('activeSessionTitle');
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
  let activeAssistantBubble = null;
  let currentApprovalId = null;

  // Auto-resize textarea
  promptInput.addEventListener('input', () => {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + 'px';
  });

  // Load Initial Settings & Sessions
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
    refreshSessions();
  }

  function startNewSession() {
    currentSessionId = null;
    activeAssistantBubble = null;
    activeSessionTitle.textContent = 'New Session';
    messageFeed.innerHTML = '';
    welcomeBanner.style.display = 'block';
    refreshSessions();
  }

  btnNewSession.onclick = startNewSession;

  function appendUserMessage(text) {
    welcomeBanner.style.display = 'none';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bubble-user';
    bubble.textContent = text;
    messageFeed.appendChild(bubble);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function appendAssistantMessage(initialText = '') {
    welcomeBanner.style.display = 'none';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble bubble-assistant';
    bubble.textContent = initialText;
    messageFeed.appendChild(bubble);
    activeAssistantBubble = bubble;
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return bubble;
  }

  function appendToolCallCard(name, args) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.id = `tool-${name}-${Date.now()}`;
    card.innerHTML = `
      <div class="tool-card-header">
        <span>⚡ <strong>${name}</strong></span>
        <span class="tool-badge tool-badge-running">EXECUTING</span>
      </div>
      <div class="tool-body">${JSON.stringify(args, null, 2)}</div>
    `;
    messageFeed.appendChild(card);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return card;
  }

  function appendToolResultCard(name, result) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    const formattedResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    card.innerHTML = `
      <div class="tool-card-header">
        <span>✔ <strong>${name}</strong> Result</span>
        <span class="tool-badge tool-badge-done">COMPLETED</span>
      </div>
      <div class="tool-body">${formattedResult}</div>
    `;
    messageFeed.appendChild(card);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Handle Event Stream
  client.onEvent((event) => {
    if (event.type === 'token') {
      botStatusAvatar.textContent = '◌';
      botStatusText.textContent = 'Thinking...';
      if (!activeAssistantBubble) {
        appendAssistantMessage();
      }
      activeAssistantBubble.textContent += event.data.token;
      chatContainer.scrollTop = chatContainer.scrollHeight;
    } else if (event.type === 'tool_call') {
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = `Running ${event.data.name}...`;
      appendToolCallCard(event.data.name, event.data.args);
      activeAssistantBubble = null;
    } else if (event.type === 'tool_result') {
      appendToolResultCard(event.data.name, event.data.result);
    } else if (event.type === 'approval_required') {
      currentApprovalId = event.data.approvalId;
      approvalToolName.textContent = event.data.toolName;
      approvalArgsBox.textContent = JSON.stringify(event.data.args, null, 2);
      approvalModal.classList.remove('hidden');
    } else if (event.type === 'turn_complete') {
      botStatusAvatar.textContent = '⚡';
      botStatusText.textContent = 'Ready';
      activeAssistantBubble = null;
      refreshSessions();
    } else if (event.type === 'error') {
      botStatusAvatar.textContent = '⚠';
      botStatusText.textContent = 'Error';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble bubble-assistant';
      bubble.style.borderColor = 'var(--danger)';
      bubble.textContent = `Error: ${event.data.message}`;
      messageFeed.appendChild(bubble);
      activeAssistantBubble = null;
    }
  });

  // Approvals
  btnApproveOnce.onclick = async () => {
    if (!currentApprovalId) return;
    approvalModal.classList.add('hidden');
    await client.approveTool(currentApprovalId, { action: 'approve_once' });
    currentApprovalId = null;
  };

  btnAlwaysAllow.onclick = async () => {
    if (!currentApprovalId) return;
    approvalModal.classList.add('hidden');
    await client.approveTool(currentApprovalId, { action: 'always_allow' });
    currentApprovalId = null;
  };

  btnRejectTool.onclick = async () => {
    if (!currentApprovalId) return;
    approvalModal.classList.add('hidden');
    await client.approveTool(currentApprovalId, { action: 'reject' });
    currentApprovalId = null;
  };

  // Submit Query
  async function submitQuery() {
    const text = promptInput.value.trim();
    if (!text) return;

    promptInput.value = '';
    promptInput.style.height = 'auto';
    appendUserMessage(text);

    const res = await client.sendQuery(text, currentSessionId);
    if (res && res.sessionId) {
      currentSessionId = res.sessionId;
      activeSessionTitle.textContent = currentSessionId;
    }
  }

  btnSend.onclick = submitQuery;
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuery();
    }
  });

  // Prompt chips
  document.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.onclick = () => {
      promptInput.value = chip.dataset.query;
      submitQuery();
    };
  });

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

  // Boot
  await refreshSettings();
  await refreshSessions();
});
