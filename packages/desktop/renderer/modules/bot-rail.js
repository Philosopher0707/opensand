/**
 * Bot sidebar section: one tree row per bot with a disclosure toggle and its
 * nested sessions. The module owns filter/expanded UI state; the controller
 * owns search-panel open state. Session buffers stay in the controller to
 * avoid a cycle.
 */
import { escapeHtml } from './chat/markdown.js';
import { safeAvatarMarkup } from './bot-identity.js';

const VISIBLE_LIMIT = 6;
const EXPANDED_KEY = 'opensand-bot-tree-expanded';
const statuses = new Map();
const uiIcon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const tint = (bot) => /^#[0-9a-fA-F]{3,8}$/.test(bot?.logoColor || '') ? bot.logoColor : 'var(--accent)';

function loadExpanded() {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function avatarMarkup(bot) {
  const avatar = safeAvatarMarkup(bot) || escapeHtml((bot.name || '?').trim().charAt(0).toUpperCase());
  return `<span class="bot-avatar" style="--bot-tint:${tint(bot)}">${avatar}</span>`;
}

function cardFor(agentId) {
  return document.querySelector(`#botList .bot-rail-card[data-agent-id="${CSS.escape(String(agentId))}"]`);
}

export function setBotCardStatus(agentId, status) {
  if (!agentId) return;
  statuses.set(agentId, status);
  const card = cardFor(agentId);
  if (card) card.dataset.status = status;
}

export function setBotCardBadge(agentId, text) {
  if (!agentId) return;
  const card = cardFor(agentId);
  if (!card) return;
  let badge = card.querySelector('.delegated-badge');
  if (!text) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'delegated-badge';
    card.appendChild(badge);
  }
  badge.textContent = text;
}

export function createBotRail(options = {}) {
  const {
    buffers, getAgents, getSessions, getActiveAgentId, getChiefAgentId,
    onIdentity, onModel, onSelect, onDelete, onInspect,
    onOpenSession, onDeleteSession, onNewSession,
  } = options;
  const list = document.getElementById('botList');
  const expandedIds = loadExpanded();
  let lastAgents = [];
  let sessions = [];
  let filter = '';
  let expanded = false;

  function saveExpanded() {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedIds]));
  }

  function sessionsFor(bot) {
    return sessions.filter((s) => s.agentId === bot.id || s.id === 'bot_' + bot.id);
  }

  function groupedSessionIds() {
    const ids = new Set();
    for (const bot of lastAgents) {
      if (!bot?.id) continue;
      ids.add('bot_' + bot.id);
      for (const s of sessionsFor(bot)) ids.add(s.id);
    }
    return ids;
  }

  function matches(bot) {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return [bot?.name, bot?.role, bot?.provider, bot?.model]
      .some((v) => String(v || '').toLowerCase().includes(q));
  }

  function cardAttrs(bot, activeId) {
    const id = escapeHtml(bot.id || '');
    const active = activeId === bot.id;
    const cached = bot.id === activeId ? statuses.get(bot.id) : null;
    const status = cached === 'busy' || cached === 'error' ? cached : (active ? 'active' : 'idle');
    const provider = bot.provider || 'global';
    const model = bot.model || 'default';
    const label = `${bot.name || ''} — ${provider} · ${model}`;
    return `class="bot-rail-card bot-item ${active ? 'active' : ''}"
      data-agent-id="${id}" data-status="${status}"
      role="button" tabindex="0" aria-current="${active}" aria-label="${escapeHtml(label)}"
      title="${escapeHtml(bot.role || bot.name || '')}"`;
  }

  function statusDot() {
    return '<span class="bot-status-dot" aria-hidden="true"></span>';
  }

  function cardHtml(bot, activeId) {
    const provider = bot.provider || 'global';
    const id = escapeHtml(bot.id || '');
    const isOpen = expandedIds.has(bot.id);
    const disclosure = `<button class="bot-tree-toggle" type="button" aria-expanded="${isOpen}" aria-controls="bot-sessions-${id}" aria-label="${isOpen ? 'Collapse' : 'Expand'} ${escapeHtml(bot.name||'')} sessions"><svg class="icon bot-tree-chevron" aria-hidden="true" focusable="false"><use href="#i-chevron-down"></use></svg></button>`;
    const card = `<div ${cardAttrs(bot, activeId)}>
      <span class="bot-avatar-wrap">${avatarMarkup(bot)}
        <span class="bot-provider-badge" title="${escapeHtml(provider)}">${escapeHtml(provider.charAt(0).toUpperCase())}</span>
        ${statusDot()}</span>
      <span class="bot-item-info">
        <span class="bot-item-name">${escapeHtml(bot.name || '')}</span>
        <span class="bot-item-sub">${escapeHtml(provider)} · ${escapeHtml(bot.model || 'default')}${bot.role ? ` · ${escapeHtml(bot.role)}` : ''}</span>
        ${getChiefAgentId?.() === bot.id ? '<span class="bot-chief-badge">★ chief</span>' : ''}
      </span>
      <button class="btn-bot-inspect" title="Bot actions and sessions" aria-label="Bot actions and sessions">⋯</button>
      <button class="btn-bot-identity" title="Edit identity" data-bot-id="${id}" aria-label="Edit bot identity">🎨</button>
      <button class="btn-bot-model" title="Choose provider & model" data-bot-id="${id}" aria-label="Choose provider and model">${uiIcon('spark')}</button>
      ${onDelete ? `<button class="btn-delete-bot" title="Delete bot" data-bot-id="${id}" aria-label="Delete bot">${uiIcon('trash')}</button>` : ''}
    </div>`;
    const own = sessionsFor(bot);
    const homeId = `bot_${bot.id}`;
    if (!own.some((s) => s.id === homeId)) own.unshift({ id: homeId, title: `Bot home — ${bot.name || 'bot'}`, messageCount: 0, updatedAt: null });
    const rows = own.map((s) => `<div class="bot-session-row" role="button" tabindex="0" data-session-id="${escapeHtml(s.id)}"><span class="bot-session-title">${escapeHtml(s.title || s.id)}</span><span class="bot-session-meta">${s.messageCount || 0} msgs · ${s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : ''}</span><button class="btn-delete-session" type="button" data-session-id="${escapeHtml(s.id)}" aria-label="Delete session">×</button></div>`).join('');
    const group = `<div class="bot-session-group" id="bot-sessions-${id}" ${isOpen ? '' : 'hidden'}>${rows}<button class="bot-session-new" type="button">＋ New session with this bot</button></div>`;
    return `<div class="bot-tree-item">${disclosure}${card}${group}</div>`;
  }

  function moveFocus(card, key) {
    const cards = Array.from(list.querySelectorAll('.bot-rail-card'));
    const i = cards.indexOf(card);
    const next = cards[i + (key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  }

  function bindCards(agents) {
    for (const bot of agents) {
      const card = cardFor(bot.id);
      if (!card) continue;
      const item = card.parentElement;
      item.querySelector('.bot-tree-toggle')?.addEventListener('click', () => {
        if (expandedIds.has(bot.id)) expandedIds.delete(bot.id);
        else expandedIds.add(bot.id);
        saveExpanded();
        renderRows();
      });
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        onSelect?.(bot);
      });
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(bot);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(card, event.key);
        }
      });
      for (const row of item.querySelectorAll('.bot-session-row')) {
        const sessionId = row.dataset.sessionId;
        const open = () => onOpenSession?.(sessionId, bot);
        row.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          open();
        });
        row.addEventListener('keydown', (event) => {
          if (event.target !== row) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
      }
      for (const btn of item.querySelectorAll('.bot-session-group .btn-delete-session')) {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          onDeleteSession?.(btn.dataset.sessionId);
        });
      }
      item.querySelector('.bot-session-new')?.addEventListener('click', (event) => {
        event.stopPropagation();
        onNewSession?.(bot);
      });
      card.querySelector('.btn-bot-inspect')?.addEventListener('click', (event) => {
        event.stopPropagation();
        onInspect?.(bot, event.currentTarget);
      });
      card.querySelector('.btn-bot-identity')?.addEventListener('click', (event) => {
        event.stopPropagation();
        onIdentity?.(bot, event.currentTarget);
      });
      card.querySelector('.btn-bot-model')?.addEventListener('click', (event) => {
        event.stopPropagation();
        onModel?.(bot, event.currentTarget);
      });
      card.querySelector('.btn-delete-bot')?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (window.confirm(`Are you sure you want to delete bot "${bot.name}"?`)) void onDelete?.(bot);
      });
    }
  }

  function syncMoreButton(totalMatches) {
    const more = document.getElementById('btnBotShowMore');
    if (!more) return;
    const hidden = filter.trim() ? 0 : Math.max(0, totalMatches - VISIBLE_LIMIT);
    more.classList.toggle('hidden', hidden === 0);
    let label = !hidden ? '' : (expanded ? 'Show less' : `Show ${hidden} more bots`);
    if (buffers && hidden && !expanded) {
      const unread = lastAgents.slice(VISIBLE_LIMIT)
        .filter((bot) => bot.id && buffers.hasUnread('bot_' + bot.id)).length;
      if (unread) label += ` · ${unread} new`;
    }
    more.textContent = label;
  }

  function renderRows() {
    if (!list) return;
    const activeId = typeof getActiveAgentId === 'function' ? getActiveAgentId() : null;
    const matchesAll = lastAgents.filter(matches);
    const shown = filter.trim() ? matchesAll : (expanded ? matchesAll : matchesAll.slice(0, VISIBLE_LIMIT));
    list.innerHTML = shown.length
      ? shown.map((bot) => cardHtml(bot, activeId)).join('')
      : `<div class="bot-rail-empty">${filter.trim() ? 'No bots match' : 'No bots yet'}</div>`;
    if (buffers) {
      for (const bot of lastAgents) {
        if (bot.id && buffers.hasUnread('bot_' + bot.id)) setBotCardBadge(bot.id, 'delegated');
      }
    }
    syncMoreButton(matchesAll.length);
    bindCards(shown);
  }

  return {
    async render() {
      const agents = await getAgents?.();
      lastAgents = Array.isArray(agents) ? agents : [];
      const loaded = await getSessions?.();
      sessions = Array.isArray(loaded) ? loaded : [];
      for (const id of expandedIds) if (!lastAgents.some((a) => a.id === id)) expandedIds.delete(id);
      saveExpanded();
      renderRows();
    },
    applyFilter(text) { filter = String(text || ''); renderRows(); },
    setExpanded(value) { expanded = Boolean(value); renderRows(); },
    isExpanded() { return expanded; },
    getGroupedSessionIds: groupedSessionIds,
  };
}
