/**
 * Parallel Board: a grid of independent chat panes.
 *
 * Each pane owns a session id, a live event stream and its own composer. Events
 * are routed by event.sessionId, so two turns can stream at the same time
 * without one pane stealing the other's tokens. No framework, no dependencies.
 */

export function initParallelBoard({ client, getView, getAgents, registerSessionAgent, maxPanes = 6 }) {
  const grid = document.getElementById('parallelGrid');
  const status = document.getElementById('parallelStatus');
  if (!grid || !status) return { handleEvent() {}, paneCount: () => 0, refreshAgents() {} };

  const panes = new Map();
  let agents = [];
  const sends = [];
  let next = 1;

  const updateStatus = () => {
    const running = [...panes.values()].filter((p) => p.running).length;
    status.textContent = `${running} running · ${panes.size} pane${panes.size === 1 ? '' : 's'}`;
  };

  const setBadge = (pane, state) => {
    pane.badge.textContent = state;
    pane.node.dataset.state = state;
  };

  function append(pane, role, text) {
    const line = document.createElement('div');
    line.className = `pb-msg pb-${role}`;
    line.textContent = text;
    pane.stream.appendChild(line);
    pane.stream.scrollTop = pane.stream.scrollHeight;
    return line;
  }

  async function loadHistory(pane, sessionId) {
    try {
      const data = await client.loadSession(sessionId);
      const turns = data?.turns || data?.messages || [];
      for (const turn of turns) {
        const text = typeof turn === 'string' ? turn : (turn.content ?? turn.text ?? '');
        if (text) append(pane, turn.role === 'assistant' ? 'assistant' : 'user', String(text));
      }
    } catch {
      // A pane with no history is still usable.
    }
  }

  function fillAgentOptions(pane) {
    const select = pane.agentSelect;
    select.replaceChildren(new Option('No bot', ''));
    for (const agent of agents) select.appendChild(new Option(agent.name || agent.id, agent.id));
    if (pane.agentId && !agents.some((a) => a.id === pane.agentId)) pane.agentId = null;
    select.value = pane.agentId || '';
  }

  function nextAgentId() {
    const list = [...panes.values()];
    const used = new Set(list.map((p) => p.agentId));
    const picked = agents.find((a) => !used.has(a.id)) || agents[list.length % agents.length] || null;
    return picked?.id ?? null;
  }

  async function refreshAgents() {
    try {
      const list = await getAgents();
      agents = Array.isArray(list) ? list : [];
    } catch {
      agents = [];
    }
    for (const pane of panes.values()) {
      fillAgentOptions(pane);
      if (!pane.agentId && !pane.agentChosen) {
        pane.agentId = nextAgentId();
        fillAgentOptions(pane);
        registerSessionAgent(pane.sessionId, pane.agentId);
      }
    }
  }

  function createPane(sessionId, agentId = null) {
    if (panes.size >= maxPanes) return null;
    const id = `pane-${next++}`;
    const node = document.createElement('section');
    node.className = 'pb-pane';
    node.dataset.pane = id;
    node.innerHTML = `
      <header class="pb-head">
        <span class="pb-dot" aria-hidden="true"></span>
        <span class="pb-title"></span>
        <select class="pane-agent" aria-label="Bot for this pane"></select>
        <span class="pb-badge">idle</span>
        <button class="pb-close" title="Close pane" aria-label="Close pane">&times;</button>
      </header>
      <div class="pb-stream" role="log" aria-live="polite"></div>
      <div class="pb-composer">
        <input class="pb-input" type="text" autocomplete="off" placeholder="Prompt this pane…" />
        <button class="pb-send">Send</button>
        <button class="pb-stop" disabled>Stop</button>
      </div>`;
    grid.appendChild(node);

    const pane = {
      id,
      sessionId: sessionId || `parallel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: agentId || nextAgentId(),
      agentChosen: false,
      running: false,
      assistant: null,
      node,
      stream: node.querySelector('.pb-stream'),
      badge: node.querySelector('.pb-badge'),
      input: node.querySelector('.pb-input'),
      stopBtn: node.querySelector('.pb-stop'),
      agentSelect: node.querySelector('.pane-agent'),
    };
    node.querySelector('.pb-title').textContent = `Pane ${next - 1} · ${pane.sessionId.slice(-8)}`;
    panes.set(id, pane);
    fillAgentOptions(pane);
    registerSessionAgent(pane.sessionId, pane.agentId);
    pane.agentSelect.addEventListener('change', () => {
      pane.agentId = pane.agentSelect.value || null;
      pane.agentChosen = true;
      registerSessionAgent(pane.sessionId, pane.agentId);
    });

    node.querySelector('.pb-close').onclick = () => closePane(id);
    node.querySelector('.pb-send').onclick = () => send(pane);
    pane.stopBtn.onclick = () => stop(pane);
    pane.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') send(pane);
    });
    if (sessionId) void loadHistory(pane, sessionId);
    updateStatus();
    return pane;
  }

  function closePane(id) {
    const pane = panes.get(id);
    if (!pane) return;
    if (pane.running) stop(pane);
    pane.node.remove();
    panes.delete(id);
    updateStatus();
  }

  async function send(pane, broadcastText) {
    const query = (broadcastText ?? pane.input.value).trim();
    if (!query) return;
    pane.input.value = '';
    append(pane, 'user', query);
    pane.running = true;
    setBadge(pane, 'running');
    pane.stopBtn.disabled = false;
    pane.assistant = append(pane, 'assistant', '');
    updateStatus();

    registerSessionAgent(pane.sessionId, pane.agentId);
    sends.push({ sessionId: pane.sessionId, agentId: pane.agentId });
    try {
      const result = await client.sendQuery(query, pane.sessionId, pane.agentId);
      if (result?.sessionId) pane.sessionId = result.sessionId;
      if (result?.queued) setBadge(pane, 'queued');
    } catch (err) {
      pane.running = false;
      setBadge(pane, 'error');
      pane.stopBtn.disabled = true;
      append(pane, 'error', err instanceof Error ? err.message : String(err));
      updateStatus();
    }
  }

  function stop(pane) {
    if (!pane.sessionId) return;
    void client.cancelTurn(pane.sessionId).catch(() => {});
  }

  function handleEvent(event) {
    if (getView() !== 'parallel') return;

    // Subagent events belong to the pane that owns the parent session. The
    // child session id travels in `subagent.sessionId`, not the DesktopEvent id.
    if (event.type === 'subagent') {
      const info = event.subagent || event.data?.subagent || {};
      const ownerId = info.parentSessionId || event.sessionId;
      const owner = [...panes.values()].find((p) => p.sessionId === ownerId);
      if (!owner) return;
      const inner = event.data?.event || event.data || {};
      let text = '';
      if (inner.type === 'text_delta') text = String(inner.text ?? '');
      else if (inner.type === 'turn_completed') text = String(inner.finalContent ?? '');
      else if (inner.type === 'error') text = String(inner.error?.message ?? 'error');
      else if (inner.type) text = String(inner.type);
      if (text) append(owner, 'subagent', `${info.agentName || info.agentId || 'subagent'} · ${text}`);
      updateStatus();
      return;
    }

    const sessionId = event.sessionId;
    const pane = [...panes.values()].find((p) => p.sessionId === sessionId);
    if (!pane) return;

    switch (event.type) {
      case 'session_started':
        pane.running = true;
        pane.stopBtn.disabled = false;
        setBadge(pane, 'running');
        break;
      case 'token':
      case 'text_delta': {
        const delta = event.data?.token ?? event.token ?? event.text ?? '';
        if (delta && pane.assistant) pane.assistant.textContent += String(delta);
        break;
      }
      case 'tool_call':
        append(pane, 'tool', `tool · ${event.data?.name ?? 'call'}`);
        break;
      case 'tool_result':
        append(pane, 'tool', `result · ${event.data?.name ?? 'tool'}`);
        break;
      case 'thought':
        append(pane, 'tool', `thought · ${String(event.data?.thought ?? '').slice(0, 140)}`);
        break;
      case 'turn_complete': {
        const text = event.data?.response;
        if (text && pane.assistant && !pane.assistant.textContent) pane.assistant.textContent = String(text);
        pane.running = false;
        pane.stopBtn.disabled = true;
        setBadge(pane, 'done');
        break;
      }
      case 'turn_cancelled':
      case 'error':
        pane.running = false;
        pane.stopBtn.disabled = true;
        setBadge(pane, event.type === 'error' ? 'error' : 'cancelled');
        append(pane, 'error', String(event.data?.message ?? 'Turn ended'));
        break;
      default:
        break;
    }
    updateStatus();
  }

  document.getElementById('btnParallelAdd')?.addEventListener('click', () => createPane());
  document.getElementById('btnParallelClear')?.addEventListener('click', () => {
    for (const id of [...panes.keys()]) closePane(id);
  });
  document.getElementById('btnParallelBroadcast')?.addEventListener('click', () => {
    const input = document.getElementById('parallelBroadcastInput');
    const text = input?.value?.trim();
    if (!text) return;
    input.value = '';
    for (const pane of panes.values()) void send(pane, text);
  });

  if (panes.size === 0) {
    createPane();
    createPane();
  }
  void refreshAgents();

  // Test/debug view of pane ownership without reaching into the DOM.
  window.__parallelState = {
    getPanes: () => [...panes.values()].map((p) => ({ id: p.id, sessionId: p.sessionId, agentId: p.agentId })),
    getSends: () => sends.slice(),
  };

  return { handleEvent, paneCount: () => panes.size, refreshAgents };
}
