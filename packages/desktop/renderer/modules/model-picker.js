/**
 * Reusable per-bot model picker (vanilla JS, no dependencies).
 *
 * Contract mirrors the useful part of OpenMausBot's ModelPicker: a grouped
 * provider rail, a searchable live model list, source/unconfirmed hints, an
 * auth affordance and an explicit "follow global" choice. OpenSand's catalog
 * endpoints are the authority; this module never guesses models.
 */

const SOURCE_LABELS = {
  endpoint: 'from provider endpoint',
  cli: 'from provider CLI',
  static: 'static catalog',
};

function groupFor(provider) {
  if (provider.access === 'subscription') return 'Cloud';
  if (provider.access === 'api') return 'API keys';
  return 'Local & CLI';
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export function createModelPicker({ onPick, onOpenAuth }) {
  let root = null;
  let state = { provider: '', model: '', endpoint: '', botId: null };
  let catalog = [];
  let models = [];
  let defaultModel = '';
  let seq = 0;

  function close() {
    if (root) root.remove();
    root = null;
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  async function loadProviders() {
    try {
      const response = await fetch('/api/providers');
      const data = await response.json();
      catalog = Array.isArray(data.providers) ? data.providers : [];
    } catch {
      catalog = [];
    }
  }

  async function loadModels() {
    const request = ++seq;
    const query = new URLSearchParams();
    if (state.provider) query.set('provider', state.provider);
    // A bot-specific endpoint wins; otherwise let the server use global settings.
    if (state.endpoint) query.set('endpoint', state.endpoint);
    try {
      const response = await fetch(`/api/models?${query.toString()}`);
      const data = await response.json();
      if (request !== seq) return;
      models = Array.isArray(data.models) ? data.models : [];
      defaultModel = data.default || (models[0] && models[0].id) || '';
      state.source = data.source || 'static';
      state.unconfirmed = Boolean(data.unconfirmed);
      renderList();
    } catch {
      if (request !== seq) return;
      models = [];
      renderList();
    }
  }

  function renderRail() {
    const rail = root.querySelector('.mp-rail');
    rail.innerHTML = '';
    const groups = ['Cloud', 'API keys', 'Local & CLI'];
    for (const group of groups) {
      const items = catalog.filter((provider) => groupFor(provider) === group);
      if (!items.length) continue;
      rail.appendChild(el('div', 'mp-rail-label', group));
      for (const provider of items) {
        const button = el('button', 'mp-rail-item');
        button.type = 'button';
        button.title = provider.displayName;
        button.dataset.provider = provider.kind;
        if (provider.kind === state.provider) button.classList.add('active');
        const glyph = el('span', 'mp-glyph', (provider.displayName || '?').slice(0, 1));
        button.appendChild(glyph);
        if (provider.auth) button.appendChild(el('span', 'mp-key-dot', '•'));
        button.onclick = () => {
          state.provider = provider.kind;
          state.endpoint = provider.defaultUrl || '';
          state.model = '';
          renderRail();
          renderDetails();
          void loadModels();
        };
        rail.appendChild(button);
      }
    }
  }

  function renderDetails() {
    const details = root.querySelector('.mp-details');
    details.innerHTML = '';
    const current = catalog.find((provider) => provider.kind === state.provider);

    const header = el('div', 'mp-detail-header');
    header.appendChild(el('strong', 'mp-detail-title', current ? current.displayName : 'Follow global provider'));
    header.appendChild(el('span', 'mp-detail-hint', state.provider || 'Uses the app-wide provider settings'));
    details.appendChild(header);

    if (current) {
      const endpointRow = el('label', 'mp-field');
      endpointRow.appendChild(el('span', 'mp-field-label', 'Endpoint'));
      const endpoint = el('input', 'mp-input');
      endpoint.type = 'text';
      endpoint.value = state.endpoint || current.defaultUrl || current.defaultCli || '';
      endpoint.placeholder = current.defaultUrl || current.defaultCli || 'auto';
      endpoint.oninput = () => { state.endpoint = endpoint.value.trim(); };
      endpoint.onchange = () => void loadModels();
      endpointRow.appendChild(endpoint);
      details.appendChild(endpointRow);

      if (current.auth) {
        const auth = el('button', 'mp-auth-hint', 'Sign-in required — open provider auth');
        auth.type = 'button';
        auth.onclick = () => { close(); onOpenAuth?.(state.provider); };
        details.appendChild(auth);
      }
    }

    const follow = el('button', 'mp-follow');
    follow.type = 'button';
    follow.textContent = state.provider ? '↩ Follow global provider instead' : '✓ Following global provider';
    follow.disabled = !state.provider;
    follow.onclick = () => {
      state.provider = '';
      state.endpoint = '';
      state.model = '';
      renderRail();
      renderDetails();
      void loadModels();
    };
    details.appendChild(follow);
  }

  function renderList() {
    const list = root.querySelector('.mp-list');
    list.innerHTML = '';
    const source = el('div', 'mp-source');
    const label = SOURCE_LABELS[state.source] || 'static catalog';
    source.textContent = state.unconfirmed ? `${label} · unconfirmed` : label;
    if (state.unconfirmed) source.classList.add('unconfirmed');
    list.appendChild(source);

    const search = el('input', 'mp-search');
    search.type = 'search';
    search.placeholder = 'Search models…';
    search.oninput = () => {
      const query = search.value.toLowerCase();
      for (const row of list.querySelectorAll('.mp-model')) {
        row.hidden = !row.textContent.toLowerCase().includes(query);
      }
    };
    list.appendChild(search);

    for (const model of models) {
      const row = el('button', 'mp-model');
      row.type = 'button';
      row.dataset.modelId = model.id;
      row.appendChild(el('span', 'mp-model-name', model.name || model.id));
      row.appendChild(el('span', 'mp-model-meta', model.id === defaultModel ? 'default' : ''));
      if (model.id === state.model) row.classList.add('active');
      row.onclick = () => {
        state.model = model.id;
        for (const other of list.querySelectorAll('.mp-model')) other.classList.remove('active');
        row.classList.add('active');
      };
      list.appendChild(row);
    }
    if (!models.length) list.appendChild(el('p', 'mp-empty', 'No models discovered for this provider.'));

    const save = el('button', 'mp-save', 'Use this model');
    save.type = 'button';
    save.onclick = () => {
      const chosen = state.model || defaultModel;
      if (!chosen) return;
      const payload = {
        botId: state.botId,
        provider: state.provider,
        model: chosen,
        endpoint: state.endpoint,
      };
      close();
      onPick?.(payload);
    };
    list.appendChild(save);
  }

  async function open({ anchor, botId, provider, model, endpoint }) {
    close();
    state = {
      botId,
      provider: provider || '',
      model: model || '',
      endpoint: endpoint || '',
      source: 'static',
      unconfirmed: false,
    };
    await loadProviders();

    root = el('div', 'mp-backdrop');
    const popover = el('div', 'mp-popover');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Choose provider and model');
    const rail = el('div', 'mp-rail');
    const details = el('div', 'mp-details');
    const list = el('div', 'mp-list');
    popover.append(rail, details, list);
    root.appendChild(popover);
    document.body.appendChild(root);
    document.addEventListener('keydown', onKeydown);

    root.onclick = (event) => { if (event.target === root) close(); };
    if (anchor && anchor.getBoundingClientRect) {
      const rect = anchor.getBoundingClientRect();
      popover.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 480)}px`;
      popover.style.left = `${Math.min(rect.left, window.innerWidth - 720)}px`;
    }

    renderRail();
    renderDetails();
    renderList();
    void loadModels();
    const search = root.querySelector('.mp-search');
    search?.focus();
  }

  return { open, close, isOpen: () => Boolean(root) };
}
