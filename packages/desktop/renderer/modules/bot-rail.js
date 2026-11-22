/**
 * Bot sidebar section: one card per bot plus the Default Assistant row.
 * The module owns filter/expanded UI state; the controller owns search-panel
 * open state. Session buffers stay in the controller to avoid a cycle.
 */
import { escapeHtml } from './chat/markdown.js';
import { safeAvatarMarkup } from './bot-identity.js';

const VISIBLE_LIMIT = 6;
const statuses = new Map();
const uiIcon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
const tint = (bot) => /^#[0-9a-fA-F]{3,8}$/.test(bot?.logoColor || '') ? bot.logoColor : 'var(--accent)';

function avatarMarkup(bot) {
  const avatar = safeAvatarMarkup(bot) || escapeHtml((bot.name || '?').trim().charAt(0).toUpperCase());
  return `<span class="bot-avatar" style="--bot-tint:${tint(bot)}">${avatar}</span>`;
}

function cardFor(agentId) {
  const selector = agentId
    ? `#botList .bot-rail-card[data-agent-id="${CSS.escape(String(agentId))}"]`
    : '#botList .bot-rail-card:not([data-agent-id])';
  return document.querySelector(selector);
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
  const { buffers, getAgents, getActiveAgentId, onIdentity, onModel, onSelect, onDelete } = options;
  const list = document.getElementById('botList');
  let lastAgents = [];
  let filter = '';
  let expanded = false;

  function matches(bot) {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return [bot?.name, bot?.role, bot?.provider, bot?.model]
      .some((v) => String(v || '').toLowerCase().includes(q));
  }

  function cardAttrs(bot, activeId) {
    const id = bot ? escapeHtml(bot.id || '') : '';
    const active = bot ? activeId === bot.id : activeId === null;
    const status = (bot && statuses.get(bot.id)) || (active ? 'active' : 'idle');
    const provider = bot?.provider || 'global';
    const model = bot?.model || 'default';
    const label = bot
      ? `${bot.name || ''} — ${provider} · ${model}`
      : 'Default Assistant — global · default';
    return `class="bot-rail-card bot-item ${active ? 'active' : ''}"
      ${id ? `data-agent-id="${id}"` : ''} data-status="${status}"
      role="button" tabindex="0" aria-current="${active}" aria-label="${escapeHtml(label)}"
      title="${escapeHtml(bot?.role || bot?.name || 'Default Assistant')}"`;
  }

  function statusDot() {
    return '<span class="bot-status-dot" aria-hidden="true"></span>';
  }

  function cardHtml(bot, activeId) {
    if (!bot) {
      return `<div ${cardAttrs(null, activeId)}>
        <span class="bot-avatar-wrap"><span class="bot-avatar default-avatar">${uiIcon('bot')}</span>${statusDot()}</span>
        <span class="bot-item-info"><span class="bot-item-name">Default Assistant</span>
          <span class="bot-item-sub">global · default</span></span>
      </div>`;
    }
    const provider = bot.provider || 'global';
    const id = escapeHtml(bot.id || '');
    return `<div ${cardAttrs(bot, activeId)}>
      <span class="bot-avatar-wrap">${avatarMarkup(bot)}
        <span class="bot-provider-badge" title="${escapeHtml(provider)}">${escapeHtml(provider.charAt(0).toUpperCase())}</span>
        ${statusDot()}</span>
      <span class="bot-item-info">
        <span class="bot-item-name">${escapeHtml(bot.name || '')}</span>
        <span class="bot-item-sub">${escapeHtml(provider)} · ${escapeHtml(bot.model || 'default')}${bot.role ? ` · ${escapeHtml(bot.role)}` : ''}</span>
      </span>
      <button class="btn-bot-identity" title="Edit identity" data-bot-id="${id}" aria-label="Edit bot identity">🎨</button>
      <button class="btn-bot-model" title="Choose provider & model" data-bot-id="${id}" aria-label="Choose provider and model">${uiIcon('spark')}</button>
      ${onDelete ? `<button class="btn-delete-bot" title="Delete bot" data-bot-id="${id}" aria-label="Delete bot">${uiIcon('trash')}</button>` : ''}
    </div>`;
  }

  function moveFocus(card, key) {
    const cards = Array.from(list.querySelectorAll('.bot-rail-card'));
    const i = cards.indexOf(card);
    const next = cards[i + (key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  }

  function bindCards(agents) {
    cardFor(null)?.addEventListener('click', () => onSelect?.(null));
    for (const bot of agents) {
      const card = cardFor(bot.id);
      if (!card) continue;
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
    list.querySelector('.bot-rail-card:not([data-agent-id])')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect?.(null);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(event.currentTarget, event.key);
      }
    });
  }

  function syncMoreButton(totalMatches) {
    const more = document.getElementById('btnBotShowMore');
    if (!more) return;
    const hidden = filter.trim() ? 0 : Math.max(0, totalMatches - VISIBLE_LIMIT);
    more.classList.toggle('hidden', hidden === 0);
    more.textContent = !hidden ? '' : (expanded ? 'Show less' : `Show ${hidden} more bots`);
  }

  function renderRows() {
    if (!list) return;
    const activeId = typeof getActiveAgentId === 'function' ? getActiveAgentId() : null;
    const matchesAll = lastAgents.filter(matches);
    const shown = filter.trim() ? matchesAll : (expanded ? matchesAll : matchesAll.slice(0, VISIBLE_LIMIT));
    const defaultRow = filter.trim() && matchesAll.length === 0 ? '' : cardHtml(null, activeId);
    list.innerHTML = defaultRow + (shown.length
      ? shown.map((bot) => cardHtml(bot, activeId)).join('')
      : `<div class="bot-rail-empty">${filter.trim() ? 'No bots match' : 'No bots yet'}</div>`);
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
      renderRows();
    },
    applyFilter(text) { filter = String(text || ''); renderRows(); },
    setExpanded(value) { expanded = Boolean(value); renderRows(); },
    isExpanded() { return expanded; },
  };
}
