/**
 * Compact bot rail: one card per persona plus the Default Assistant row.
 * Session buffers and selection state stay in the controller; this module
 * only owns the rail DOM so it cannot create a dependency cycle with app.js.
 */
import { escapeHtml } from './chat/markdown.js';
import { safeAvatarMarkup } from './bot-identity.js';

const uiIcon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

function tint(bot) {
  return /^#[0-9a-fA-F]{3,8}$/.test(bot?.logoColor || '') ? bot.logoColor : 'var(--accent)';
}

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

/** Set the live status dot on a bot card (idle / active / busy / error). */
export function setBotCardStatus(agentId, status) {
  if (!agentId) return;
  const card = cardFor(agentId);
  if (card) card.dataset.status = status;
}

/** Show or clear the compact "delegated" unread badge on a bot card. */
export function setBotCardBadge(agentId, text) {
  if (!agentId) return;
  const card = cardFor(agentId);
  if (!card) return;
  let badge = card.querySelector('.delegated-badge');
  if (!text) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'delegated-badge';
    card.appendChild(badge);
  }
  badge.textContent = text;
}

export function createBotRail(options = {}) {
  const { buffers, getAgents, getActiveAgentId, onIdentity, onModel, onSelect, onDelete } = options;

  return {
    async render() {
      const list = document.getElementById('botList');
      if (!list) return;
      const agents = await getAgents?.();
      const activeId = typeof getActiveAgentId === 'function' ? getActiveAgentId() : null;
      const rows = [];

      rows.push(`
        <div class="bot-rail-card bot-item ${activeId === null ? 'active' : ''}" data-status="${activeId === null ? 'active' : 'idle'}">
          <span class="bot-avatar-wrap"><span class="bot-avatar default-avatar">${uiIcon('bot')}</span></span>
          <div class="bot-item-info">
            <span class="bot-item-name">Default Assistant</span>
            <span class="bot-model-chip">global · default</span>
          </div>
          <span class="bot-status-dot" aria-hidden="true"></span>
        </div>
      `);

      for (const bot of (Array.isArray(agents) ? agents : [])) {
        const provider = bot.provider || 'global';
        const id = escapeHtml(bot.id || '');
        rows.push(`
          <div class="bot-rail-card bot-item ${activeId === bot.id ? 'active' : ''}"
               data-agent-id="${id}" data-status="${activeId === bot.id ? 'active' : 'idle'}"
               title="${escapeHtml(bot.role || bot.name || '')}">
            <span class="bot-avatar-wrap">
              ${avatarMarkup(bot)}
              <span class="bot-provider-badge" title="${escapeHtml(provider)}">${escapeHtml(provider.charAt(0).toUpperCase())}</span>
            </span>
            <div class="bot-item-info">
              <span class="bot-item-name">${escapeHtml(bot.name || '')}</span>
              ${bot.role ? `<span class="bot-item-role">${escapeHtml(bot.role)}</span>` : ''}
              <span class="bot-model-chip" title="Provider & model">${escapeHtml(provider)} · ${escapeHtml(bot.model || 'default')}</span>
            </div>
            <span class="bot-status-dot" aria-hidden="true"></span>
            <button class="btn-bot-identity" title="Edit identity" data-bot-id="${id}" aria-label="Edit bot identity">🎨</button>
            <button class="btn-bot-model" title="Choose provider & model" data-bot-id="${id}" aria-label="Choose provider and model">${uiIcon('spark')}</button>
            ${onDelete ? `<button class="btn-delete-bot" title="Delete bot" data-bot-id="${id}" aria-label="Delete bot">${uiIcon('trash')}</button>` : ''}
          </div>
        `);
      }

      list.innerHTML = rows.join('');

      // Rebuild drops badge spans; re-apply from the buffers' unread state.
      if (buffers) {
        for (const bot of (Array.isArray(agents) ? agents : [])) {
          if (bot.id && buffers.hasUnread('bot_' + bot.id)) setBotCardBadge(bot.id, 'delegated');
        }
      }

      cardFor(null)?.addEventListener('click', () => onSelect?.(null));
      for (const bot of (Array.isArray(agents) ? agents : [])) {
        const card = cardFor(bot.id);
        if (!card) continue;
        card.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          onSelect?.(bot);
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
          if (window.confirm(`Are you sure you want to delete bot "${bot.name}"?`)) {
            void onDelete?.(bot);
          }
        });
      }
    },
  };
}
