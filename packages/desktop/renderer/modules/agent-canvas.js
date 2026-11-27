/**
 * Agent Canvas: floating windows, one per live agent session.
 *
 * A window owns a session id, a live event stream and its own composer. Events
 * are routed by event.sessionId, so several agents can stream at once without
 * one window stealing another's tokens. No framework, no dependencies.
 *
 * The DOM keeps the board's `.pb-*` hooks for existing harness coverage; the
 * `.ag-*` classes carry the new canvas layout and visual treatment.
 */

import {
  MAX_WINDOWS,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  cascadePosition,
  clampWindow,
  fitAll,
  normalizePersisted,
} from './canvas-layout.js';

const LAYOUT_KEY = 'opensand.agentCanvas.layout.v1';

export function initAgentCanvas({
  client,
  getView,
  getAgents,
  registerSessionAgent,
  getPendingApprovals,
  maxWindows = MAX_WINDOWS,
}) {
  const canvas = document.getElementById('parallelGrid');
  const layer = document.getElementById('canvasLayer');
  const status = document.getElementById('parallelStatus');
  const dock = document.getElementById('canvasDock');
  const emptyState = document.getElementById('canvasEmpty');
  const orphanNote = document.getElementById('canvasOrphans');
  if (!canvas || !layer || !status) {
    return { handleEvent() {}, paneCount: () => 0, refreshAgents() {} };
  }

  const windows = new Map();
  const sends = [];
  const orphans = [];
  let agents = [];
  let next = 1;
  let zTop = 10;
  let viewport = { panX: 0, panY: 0, zoom: 1 };
  let mode = 'overview';

  // The view is hidden at boot, so clientWidth is 0 until the user opens it.
  const bounds = () => ({
    w: canvas.clientWidth > 0 ? canvas.clientWidth : 1200,
    h: canvas.clientHeight > 0 ? canvas.clientHeight : 800,
  });
  const isVisible = () => getView() === 'parallel';

  function applyViewport() {
    layer.style.transform = `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`;
    const follow = document.getElementById('btnFollowMode');
    if (follow) {
      follow.setAttribute('aria-pressed', String(mode === 'follow'));
      follow.textContent = mode === 'follow' ? 'Follow' : 'Overview';
    }
  }

  function applyGeometry(pane) {
    pane.node.style.left = `${pane.x}px`;
    pane.node.style.top = `${pane.y}px`;
    pane.node.style.width = `${pane.w}px`;
    pane.node.style.height = `${pane.h}px`;
  }

  function saveLayout() {
    try {
      const payload = {
        windows: [...windows.values()].map((p) => ({
          sessionId: p.sessionId,
          agentId: p.agentId,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
          z: p.z,
          minimized: p.minimized,
        })),
        viewport,
        mode,
      };
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(payload));
    } catch {
      // A layout is a convenience, never a reason to break a turn.
    }
  }

  function readLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function updateStatus() {
    const running = [...windows.values()].filter((p) => p.running || p.state === 'approval').length;
    status.textContent = `${running} running · ${windows.size} pane${windows.size === 1 ? '' : 's'}`;
    if (emptyState) emptyState.classList.toggle('hidden', windows.size > 0);
  }

  function updateDock() {
    if (!dock) return;
    dock.replaceChildren();
    for (const pane of windows.values()) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'canvas-dock-item';
      item.dataset.pane = pane.id;
      item.dataset.state = pane.state;
      item.title = `${pane.botName || p.agentId || 'Agent'} · ${pane.sessionId.slice(-8)}`;
      item.setAttribute('aria-label', `Focus window for ${pane.botName || 'agent'}`);
      const dot = document.createElement('span');
      dot.className = 'pb-dot';
      const label = document.createElement('span');
      label.textContent = (pane.botName || pane.agentId || 'bot').replace(/^agent_/, '').slice(0, 14);
      item.append(dot, label);
      item.onclick = () => {
        if (pane.minimized) restore(pane);
        raise(pane);
      };
      dock.appendChild(item);
    }
  }

  function updateOrphans() {
    if (!orphanNote) return;
    orphanNote.textContent = orphans.length
      ? `${orphans.length} saved window${orphans.length === 1 ? '' : 's'} skipped: session no longer exists`
      : '';
    orphanNote.classList.toggle('hidden', orphans.length === 0);
  }

  function raise(pane) {
    zTop += 1;
    pane.z = zTop;
    pane.node.style.zIndex = String(zTop);
  }

  function setBadge(pane, state) {
    pane.state = state;
    pane.node.dataset.state = state;
    pane.badge.textContent = state;
    updateStatus();
    updateDock();
  }

  function append(pane, role, text) {
    const line = document.createElement('div');
    line.className = `pb-msg pb-${role}`;
    line.textContent = text;
    pane.stream.appendChild(line);
    pane.stream.scrollTop = pane.stream.scrollHeight;
    return line;
  }

  async function loadHistory(pane) {
    try {
      const data = await client.loadSession(pane.sessionId);
      const turns = data?.turns || data?.messages || [];
      for (const turn of turns) {
        const text = typeof turn === 'string' ? turn : (turn.content ?? turn.text ?? '');
        if (text) append(pane, turn.role === 'assistant' ? 'assistant' : 'user', String(text));
      }
    } catch {
      // A window with no history is still usable.
    }
  }

  function botName(agentId) {
    const found = agents.find((a) => a.id === agentId);
    return found?.name || (agentId ? String(agentId).replace(/^agent_/, '') : 'Agent');
  }

  function fillAgentOptions(pane) {
    const select = pane.agentSelect;
    select.replaceChildren(new Option('No bot', ''));
    for (const agent of agents) select.appendChild(new Option(agent.name || agent.id, agent.id));
    if (pane.agentId && !agents.some((a) => a.id === pane.agentId)) pane.agentId = null;
    select.value = pane.agentId || '';
    pane.botName = botName(pane.agentId);
    pane.title.textContent = `${pane.botName} · ${pane.sessionId.slice(-8)}`;
    pane.avatar.textContent = pane.botName.slice(0, 1).toUpperCase();
  }

  function nextAgentId() {
    const used = new Set([...windows.values()].map((p) => p.agentId));
    const picked = agents.find((a) => !used.has(a.id)) || agents[windows.size % Math.max(1, agents.length)] || null;
    return picked?.id ?? null;
  }

  async function refreshAgents() {
    try {
      const list = await getAgents();
      agents = Array.isArray(list) ? list : [];
    } catch {
      agents = [];
    }
    for (const pane of windows.values()) {
      fillAgentOptions(pane);
      if (!pane.agentId && !pane.agentChosen) {
        pane.agentId = nextAgentId();
        fillAgentOptions(pane);
        registerSessionAgent(pane.sessionId, pane.agentId);
      }
    }
    updateDock();
  }

  function createWindow(sessionId, agentId = null, saved = null) {
    if (windows.size >= maxWindows) return null;
    const id = `pane-${next++}`;
    const node = document.createElement('section');
    node.className = 'pb-pane ag-window';
    node.dataset.pane = id;
    node.dataset.state = 'idle';
    node.innerHTML = `
      <header class="pb-head ag-head" tabindex="0">
        <span class="pb-dot" aria-hidden="true"></span>
        <span class="ag-avatar" aria-hidden="true"></span>
        <span class="pb-title"></span>
        <select class="pane-agent" aria-label="Bot for this window"></select>
        <span class="pb-badge">idle</span>
        <button class="ag-min" title="Minimise window" aria-label="Minimise window"><svg class="icon" aria-hidden="true"><use href="#i-chevron-down"/></svg></button>
        <button class="ag-max" title="Maximise window" aria-label="Maximise window"><svg class="icon" aria-hidden="true"><use href="#i-square"/></svg></button>
        <button class="pb-close ag-close" title="Close window" aria-label="Close window">&times;</button>
      </header>
      <nav class="ag-tabs" role="tablist" aria-label="Window details">
        <button class="ag-tab active" data-tab="activity" role="tab" aria-selected="true">Activity</button>
        <button class="ag-tab" data-tab="files" role="tab" aria-selected="false">Files</button>
        <button class="ag-tab" data-tab="approvals" role="tab" aria-selected="false">Approvals</button>
      </nav>
      <div class="pb-stream ag-stream" data-panel="activity" role="log" aria-live="polite"></div>
      <div class="ag-list" data-panel="files" hidden></div>
      <div class="ag-list" data-panel="approvals" hidden></div>
      <div class="pb-composer ag-composer">
        <input class="pb-input" type="text" autocomplete="off" placeholder="Prompt this agent…" />
        <button class="pb-send">Send</button>
        <button class="pb-stop" disabled>Stop</button>
      </div>
      <div class="ag-grip" aria-hidden="true"></div>`;
    layer.appendChild(node);

    const count = windows.size;
    const area = bounds();
    const columns = Math.max(1, Math.floor((area.w - 48) / 404));
    const preferred = {
      x: 48 + (count % columns) * 404,
      y: 48 + Math.floor(count / columns) * 384,
    };
    const geometry = clampWindow(
      saved || { x: preferred.x, y: preferred.y, w: 380, h: 360 },
      bounds(),
    );
    const pane = {
      id,
      sessionId: sessionId || `parallel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: agentId || nextAgentId(),
      agentChosen: Boolean(agentId),
      botName: '',
      running: false,
      assistant: null,
      minimized: saved?.minimized === true,
      maximized: false,
      previousGeometry: null,
      z: saved ? Number(saved.z) || 1 : 1,
      x: geometry.x,
      y: geometry.y,
      w: geometry.w,
      h: geometry.h,
      state: 'idle',
      node,
      head: node.querySelector('.ag-head'),
      title: node.querySelector('.pb-title'),
      avatar: node.querySelector('.ag-avatar'),
      agentSelect: node.querySelector('.pane-agent'),
      badge: node.querySelector('.pb-badge'),
      stream: node.querySelector('.ag-stream'),
      files: node.querySelector('[data-panel="files"]'),
      approvals: node.querySelector('[data-panel="approvals"]'),
      input: node.querySelector('.pb-input'),
      stopBtn: node.querySelector('.pb-stop'),
      tab: 'activity',
      filesSeen: new Map(),
      approvalsSeen: new Map(),
    };
    windows.set(id, pane);
    applyGeometry(pane);
    node.style.zIndex = String(pane.z);
    if (pane.z > zTop) zTop = pane.z;
    node.classList.toggle('is-minimized', pane.minimized);
    fillAgentOptions(pane);
    registerSessionAgent(pane.sessionId, pane.agentId);
    installInteractions(pane);

    if (sessionId) void loadHistory(pane);
    updateStatus();
    updateDock();
    saveLayout();
    return pane;
  }

  function installInteractions(pane) {
    const { node, head } = pane;

    node.addEventListener('pointerdown', () => raise(pane));
    head.addEventListener('keydown', (event) => {
      if (!event.altKey || !event.key.startsWith('Arrow')) return;
      event.preventDefault();
      const step = 16;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      const geometry = clampWindow({ ...pane, x: pane.x + move[0], y: pane.y + move[1] }, bounds());
      pane.x = geometry.x;
      pane.y = geometry.y;
      applyGeometry(pane);
      saveLayout();
    });

    head.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, select')) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = pane.x;
      const originY = pane.y;
      head.setPointerCapture(event.pointerId);
      const move = (e) => {
        const geometry = clampWindow(
          { ...pane, x: originX + (e.clientX - startX) / viewport.zoom, y: originY + (e.clientY - startY) / viewport.zoom },
          bounds(),
        );
        pane.x = geometry.x;
        pane.y = geometry.y;
        applyGeometry(pane);
      };
      const end = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', end);
        saveLayout();
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', end);
    });

    node.querySelector('.ag-grip').addEventListener('pointerdown', (event) => {
      const grip = event.currentTarget;
      const startX = event.clientX;
      const startY = event.clientY;
      const originW = pane.w;
      const originH = pane.h;
      grip.setPointerCapture(event.pointerId);
      const move = (e) => {
        const geometry = clampWindow(
          { ...pane, w: originW + (e.clientX - startX) / viewport.zoom, h: originH + (e.clientY - startY) / viewport.zoom },
          bounds(),
        );
        pane.w = geometry.w;
        pane.h = geometry.h;
        applyGeometry(pane);
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        saveLayout();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
    });

    pane.agentSelect.addEventListener('change', () => {
      pane.agentId = pane.agentSelect.value || null;
      pane.agentChosen = true;
      pane.botName = botName(pane.agentId);
      pane.title.textContent = `${pane.botName} · ${pane.sessionId.slice(-8)}`;
      registerSessionAgent(pane.sessionId, pane.agentId);
      updateDock();
      saveLayout();
    });

    node.querySelector('.ag-min').onclick = () => minimise(pane);
    node.querySelector('.ag-max').onclick = () => {
      if (pane.maximized) {
        pane.x = pane.previousGeometry.x;
        pane.y = pane.previousGeometry.y;
        pane.w = pane.previousGeometry.w;
        pane.h = pane.previousGeometry.h;
        pane.maximized = false;
      } else {
        pane.previousGeometry = { x: pane.x, y: pane.y, w: pane.w, h: pane.h };
        pane.x = 0;
        pane.y = 0;
        pane.w = Math.max(MIN_WINDOW_WIDTH, bounds().w / viewport.zoom);
        pane.h = Math.max(MIN_WINDOW_HEIGHT, bounds().h / viewport.zoom);
        pane.maximized = true;
      }
      applyGeometry(pane);
      saveLayout();
    };
    node.querySelector('.ag-close').onclick = () => {
      if (pane.running && !window.confirm('This agent is still working. Close its window?')) return;
      closeWindow(pane.id);
    };

    node.querySelectorAll('.ag-tab').forEach((tab) => {
      tab.onclick = () => {
        pane.tab = tab.dataset.tab;
        node.querySelectorAll('.ag-tab').forEach((other) => {
          const active = other === tab;
          other.classList.toggle('active', active);
          other.setAttribute('aria-selected', String(active));
        });
        node.querySelectorAll('[data-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.panel !== pane.tab;
        });
        renderLists(pane);
      };
    });

    node.querySelector('.pb-send').onclick = () => void send(pane);
    pane.stopBtn.onclick = () => {
      if (pane.sessionId) void client.cancelTurn(pane.sessionId).catch(() => {});
    };
    pane.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void send(pane);
    });
  }

  function renderLists(pane) {
    pane.files.replaceChildren();
    for (const [name, value] of pane.filesSeen) {
      const row = document.createElement('div');
      row.className = 'ag-list-row';
      row.textContent = `${name} · ${String(value).slice(0, 80)}`;
      pane.files.appendChild(row);
    }
    pane.approvals.replaceChildren();
    const pending = typeof getPendingApprovals === 'function' ? getPendingApprovals() : null;
    const own = pending && typeof pending.forEach === 'function'
      ? [...pending.entries()].filter(([, value]) => value?.sessionId === pane.sessionId)
      : [...pane.approvalsSeen.values()].map((value) => ({ toolName: value.toolName, args: value.args }));
    if (!own.length) {
      const note = document.createElement('div');
      note.className = 'ag-list-empty';
      note.textContent = 'No pending approvals for this window.';
      pane.approvals.appendChild(note);
    }
    for (const [approvalId, value] of own) {
      const row = document.createElement('div');
      row.className = 'ag-list-row';
      row.textContent = `${value.toolName || 'Tool'} · ${approvalId.slice(0, 12)}`;
      pane.approvals.appendChild(row);
    }
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'ag-review';
    review.textContent = 'Review in approval queue';
    review.onclick = () => {
      const queue = document.getElementById('approvalQueue');
      queue?.scrollIntoView({ block: 'nearest' });
      queue?.querySelector('button')?.focus();
    };
    pane.approvals.appendChild(review);
  }

  function minimise(pane) {
    pane.minimized = true;
    pane.node.classList.add('is-minimized');
    updateDock();
    saveLayout();
  }

  function restore(pane) {
    pane.minimized = false;
    pane.node.classList.remove('is-minimized');
    updateDock();
    saveLayout();
  }

  function closeWindow(id, { silent = false } = {}) {
    const pane = windows.get(id);
    if (!pane) return;
    if (pane.running) void client.cancelTurn(pane.sessionId).catch(() => {});
    pane.node.remove();
    windows.delete(id);
    if (!silent) saveLayout();
    updateStatus();
    updateDock();
  }

  async function send(pane, broadcastText) {
    const query = (broadcastText ?? pane.input.value).trim();
    if (!query) return;
    pane.input.value = '';
    append(pane, 'user', query);
    pane.running = true;
    setBadge(pane, 'running');
    pane.stopBtn.disabled = false;
    if (!pane.assistant || pane.assistant.parentElement !== pane.stream) {
      pane.assistant = append(pane, 'assistant', '');
    }
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
    }
  }

  function findWindow(sessionId) {
    return [...windows.values()].find((p) => p.sessionId === sessionId);
  }

  function noteFile(pane, event) {
    const data = event.data || {};
    const name = data.name || 'tool';
    const target = data.args?.path || data.args?.file || data.args?.filePath || data.args?.url || '';
    if (target) pane.filesSeen.set(name, String(target));
    if (pane.tab === 'files') renderLists(pane);
  }

  function handleEvent(event) {
    // Update the model even while the view is hidden. Returning to the canvas
    // then shows the true state, while auto-raising below stays opt-in.
    if (event.type === 'subagent') {
      const info = event.subagent || event.data?.subagent || {};
      const ownerId = info.parentSessionId || event.sessionId;
      const owner = findWindow(ownerId);
      if (!owner) return;
      const inner = event.data?.event || event.data || {};
      let text = '';
      if (inner.type === 'text_delta') text = String(inner.text ?? '');
      else if (inner.type === 'turn_completed') text = String(inner.finalContent ?? '');
      else if (inner.type === 'error') text = String(inner.error?.message ?? 'error');
      else if (inner.type) text = String(inner.type);
      if (text) append(owner, 'subagent', `${info.agentName || info.agentId || 'subagent'} · ${text}`);
      return;
    }

    const pane = findWindow(event.sessionId);
    if (!pane) return;

    switch (event.type) {
      case 'session_started':
        pane.running = true;
        pane.stopBtn.disabled = false;
        setBadge(pane, 'running');
        if (mode === 'follow' && isVisible()) raise(pane);
        break;
      case 'token':
      case 'text_delta': {
        const delta = event.data?.token ?? event.token ?? event.text ?? '';
        if (delta && pane.assistant) pane.assistant.textContent += String(delta);
        break;
      }
      case 'thought':
        append(pane, 'tool', `thought · ${String(event.data?.thought ?? '').slice(0, 140)}`);
        break;
      case 'tool_call':
        noteFile(pane, event);
        append(pane, 'tool', `tool · ${event.data?.name ?? 'call'}`);
        break;
      case 'tool_result':
        append(pane, 'tool', `result · ${event.data?.name ?? 'tool'}`);
        break;
      case 'approval_required': {
        const request = event.data || {};
        pane.approvalsSeen.set(request.approvalId || String(Date.now()), request);
        setBadge(pane, 'approval');
        if (pane.tab === 'approvals') renderLists(pane);
        if (isVisible()) raise(pane);
        break;
      }
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
  }

  // Canvas navigation -------------------------------------------------------
  canvas.addEventListener('pointerdown', (event) => {
    if (event.target !== canvas && event.target !== layer) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = viewport.panX;
    const originY = viewport.panY;
    canvas.setPointerCapture(event.pointerId);
    const move = (e) => {
      viewport.panX = originX + e.clientX - startX;
      viewport.panY = originY + e.clientY - startY;
      applyViewport();
    };
    const end = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      saveLayout();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
  });

  canvas.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const nextZoom = Math.min(2, Math.max(0.5, viewport.zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
    viewport.zoom = nextZoom;
    applyViewport();
    saveLayout();
  }, { passive: false });

  document.getElementById('btnParallelAdd')?.addEventListener('click', () => {
    const pane = createWindow();
    if (pane) raise(pane);
  });
  document.getElementById('btnParallelClear')?.addEventListener('click', () => {
    if ([...windows.values()].some((p) => p.running) && !window.confirm('Agents are still working. Clear every window?')) return;
    for (const id of [...windows.keys()]) closeWindow(id, { silent: true });
    saveLayout();
  });
  document.getElementById('btnParallelBroadcast')?.addEventListener('click', () => {
    const input = document.getElementById('parallelBroadcastInput');
    const text = input?.value?.trim();
    if (!text) return;
    input.value = '';
    for (const pane of windows.values()) void send(pane, text);
  });
  document.getElementById('btnFitAll')?.addEventListener('click', () => {
    viewport = fitAll([...windows.values()], bounds());
    applyViewport();
    saveLayout();
  });
  document.getElementById('btnZoomReset')?.addEventListener('click', () => {
    viewport = { panX: 0, panY: 0, zoom: 1 };
    applyViewport();
    saveLayout();
  });
  document.getElementById('btnFollowMode')?.addEventListener('click', () => {
    mode = mode === 'follow' ? 'overview' : 'follow';
    applyViewport();
    saveLayout();
  });

  async function boot() {
    applyViewport();
    const saved = readLayout();
    if (saved && Array.isArray(saved.windows) && saved.windows.length) {
      let sessions = [];
      try {
        const list = await client.getSessions();
        sessions = Array.isArray(list) ? list.map((s) => s?.id).filter(Boolean) : [];
      } catch {
        sessions = [];
      }
      const layout = normalizePersisted(saved, sessions, bounds());
      for (const id of [...windows.keys()]) closeWindow(id, { silent: true });
      for (const item of layout.windows) {
        const pane = createWindow(item.sessionId, item.agentId, item);
        if (pane) void loadHistory(pane);
      }
      for (const orphan of layout.orphans) if (!orphans.includes(orphan)) orphans.push(orphan);
      viewport = layout.viewport;
      mode = layout.mode;
      applyViewport();
      updateOrphans();
    }
    if (windows.size === 0) {
      createWindow();
      createWindow();
    }
    await refreshAgents();
  }

  window.__canvasState = {
    getWindows: () => [...windows.values()].map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      agentId: p.agentId,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      state: p.state,
      minimized: p.minimized,
    })),
    getSends: () => sends.slice(),
    getViewport: () => ({ ...viewport }),
    getMode: () => mode,
    getOrphans: () => orphans.slice(),
  };
  // Existing harness/tests use the board's names; keep them valid.
  window.__parallelState = {
    getPanes: () => [...windows.values()].map((p) => ({ id: p.id, sessionId: p.sessionId, agentId: p.agentId })),
    getSends: () => sends.slice(),
  };

  void boot();

  return { handleEvent, paneCount: () => windows.size, refreshAgents, cascade: (preferred) => cascadePosition([...windows.values()], preferred, bounds()) };
}
