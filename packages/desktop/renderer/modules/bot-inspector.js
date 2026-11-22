/** Bot inspector: one popover with a Manage card and a Sessions card. */
let root = null;
let onKeydown = null;
let returnFocus = null;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function close() {
  if (root) root.remove();
  root = null;
  if (onKeydown) document.removeEventListener('keydown', onKeydown);
  onKeydown = null;
  const restore = returnFocus;
  returnFocus = null;
  if (restore?.isConnected) restore.focus();
}

export function openBotInspector({
  bot, anchor, loadSessions, onRename, onIdentity, onModel, onDelete, onOpenSession, onNewSession,
} = {}) {
  close();
  returnFocus = anchor ?? null;
  root = el('div', 'inspector-backdrop');
  const popover = el('div', 'inspector-popover');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true');
  popover.setAttribute('aria-label', `${bot?.name || 'Bot'} actions`);
  root.appendChild(popover);

  popover.appendChild(el('div', 'inspector-title', `${bot?.name || 'Bot'} · actions`));
  const error = el('div', 'inspector-error');
  error.hidden = true;
  popover.appendChild(error);

  const manage = el('section', 'inspector-card');
  manage.appendChild(el('h4', 'inspector-card-title', 'Manage bot'));
  const input = el('input', 'inspector-name');
  input.type = 'text';
  input.maxLength = 64;
  input.value = bot?.name || '';
  input.setAttribute('aria-label', 'Bot name');
  manage.appendChild(input);
  const actions = el('div', 'inspector-actions');
  const rename = el('button', 'inspector-rename', 'Rename');
  rename.type = 'button';
  const cancel = el('button', 'inspector-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = close;
  const identity = el('button', 'inspector-identity', 'Change identity');
  identity.type = 'button';
  const model = el('button', 'inspector-model', 'Change model');
  model.type = 'button';
  const del = el('button', 'inspector-delete', 'Delete bot');
  del.type = 'button';
  actions.append(rename, cancel, identity, model, del);
  manage.appendChild(actions);
  popover.appendChild(manage);

  const sessions = el('section', 'inspector-card');
  sessions.appendChild(el('h4', 'inspector-card-title', 'Sessions'));
  const list = el('div', 'inspector-sessions');
  sessions.appendChild(list);
  const newBtn = el('button', 'inspector-new', 'New session with this bot');
  newBtn.type = 'button';
  sessions.appendChild(newBtn);
  popover.appendChild(sessions);

  async function run(fn) {
    try {
      error.hidden = true;
      await fn();
    } catch (err) {
      error.textContent = err?.message || 'Action failed';
      error.hidden = false;
    }
  }
  rename.onclick = () => run(async () => { await onRename?.(bot, input.value); close(); });
  // Dialog-opening callbacks must receive the ORIGINAL card button: closing the
  // inspector detaches its own buttons, giving getBoundingClientRect() zeros.
  // Only rename/delete keep the inspector open, so they are the callbacks whose
  // errors can be shown inline; dialog-opening callbacks are caught and logged.
  const replaceDialog = (callback) => {
    void Promise.resolve()
      .then(() => { close(); return callback(anchor); })
      .catch((err) => console.error('[bot-inspector]', err));
  };
  identity.onclick = () => replaceDialog((a) => onIdentity?.(bot, a));
  model.onclick = () => replaceDialog((a) => onModel?.(bot, a));
  del.onclick = () => {
    if (!window.confirm(`Are you sure you want to delete bot "${bot?.name}"?`)) return;
    void run(async () => { await onDelete?.(bot); close(); });
  };
  newBtn.onclick = () => replaceDialog(() => onNewSession?.(bot));

  async function renderSessions() {
    const items = await loadSessions?.();
    list.textContent = '';
    if (items === null || !Array.isArray(items)) {
      list.appendChild(el('div', 'inspector-empty', 'Sessions unavailable'));
      return;
    }
    const homeId = `bot_${bot?.id}`;
    const rows = items.slice();
    if (!rows.some((s) => s.id === homeId)) {
      rows.unshift({ id: homeId, title: `Bot home — ${bot?.name || 'bot'}`, messageCount: 0, updatedAt: null });
    }
    for (const s of rows) {
      const button = el('button', 'inspector-session');
      button.type = 'button';
      const when = s.updatedAt ? ` · ${new Date(s.updatedAt).toLocaleDateString()}` : '';
      button.textContent = `${s.title || s.id}${s.messageCount ? ` · ${s.messageCount} messages` : ''}${when}`;
      button.onclick = () => replaceDialog(() => onOpenSession?.(s.id, bot));
      list.appendChild(button);
    }
  }
  void renderSessions();

  root.onclick = (event) => { if (event.target === root) close(); };
  document.body.appendChild(root);
  input.focus();
  onKeydown = (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...popover.querySelectorAll('button, input')].filter((n) => !n.disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const outside = !popover.contains(document.activeElement);
    if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKeydown);

  if (anchor?.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${Math.min(rect.bottom + 8, Math.max(0, window.innerHeight - 440))}px`;
    popover.style.left = `${Math.min(rect.left, Math.max(0, window.innerWidth - 340))}px`;
  }
}
