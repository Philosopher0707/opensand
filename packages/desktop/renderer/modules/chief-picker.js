/**
 * Chief-of-staff picker: choose which bot the app routes to on boot and which
 * bot receives scoped delegation authority. Vanilla JS, no dependencies.
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export function openChiefPicker({ agents = [], currentId = null, anchor, onPick, onClear } = {}) {
  const previousFocus = document.activeElement;
  const backdrop = el('div', 'chief-picker-backdrop');
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0', zIndex: '9999',
    background: 'rgba(0, 0, 0, 0.55)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  });

  const dialog = el('div', 'chief-picker-dialog');
  Object.assign(dialog.style, {
    background: 'var(--panel, #1e1e1e)', color: 'var(--text, inherit)',
    border: '1px solid var(--border, #444)', borderRadius: '10px',
    padding: '16px', minWidth: '280px', maxWidth: '90vw',
    display: 'flex', flexDirection: 'column', gap: '8px',
  });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Choose chief of staff');
  dialog.appendChild(el('h2', 'chief-picker-title', 'Choose chief of staff'));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown);
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  }
  function choose(id) {
    close();
    if (id === null) onClear?.();
    else onPick?.(id);
  }
  function onKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(dialog.querySelectorAll('button:not([disabled])'));
    if (!focusables.length) { event.preventDefault(); return; }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const list = Array.isArray(agents) ? agents : [];
  for (const agent of list) {
    const button = el('button', 'chief-picker-option', agent?.name ?? '');
    button.type = 'button';
    if (agent?.id === currentId) button.disabled = true;
    button.addEventListener('click', () => choose(agent?.id ?? null));
    dialog.appendChild(button);
  }
  const none = el('button', 'chief-picker-option chief-picker-clear', 'No chief');
  none.type = 'button';
  none.addEventListener('click', () => choose(null));
  dialog.appendChild(none);

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKeydown);
  (dialog.querySelector('button:not([disabled])') || none).focus();

  return { close, isOpen: () => !closed };
}
