/**
 * Bot identity editor: fixed inline-SVG icons + a popover to pick one.
 *
 * The stored logoSvg is only ever trusted when it is byte-identical to what
 * iconMarkup() itself emits for the icon/expression/color parsed out of it.
 * That exact match — not a blacklist — is the whole security boundary.
 */

const SHAPES = ['mascot', 'diamond', 'gear', 'spark', 'orb'];
const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#64748b'];
const EXPRESSIONS = ['neutral', 'happy', 'focused'];

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function bodyFor(shape, expression) {
  switch (shape) {
    case 'mascot': {
      const brows = expression === 'focused'
        ? '<line x1="8" y1="7" x2="10" y2="8"/><line x1="14" y1="8" x2="16" y2="7"/>'
        : '';
      const mouth = expression === 'happy'
        ? '<path d="M8 14 Q12 18 16 14"/>'
        : '<line x1="9" y1="15" x2="15" y2="15"/>';
      return `<rect x="3" y="3" width="18" height="18" rx="5"/>${brows}<circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>${mouth}`;
    }
    case 'diamond':
      return '<path d="M12 3 L21 12 L12 21 L3 12 Z"/>';
    case 'gear':
      return '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/>';
    case 'spark':
      return '<path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z"/>';
    case 'orb':
    default:
      return '<circle cx="12" cy="12" r="9"/>';
  }
}

/** Build a canonical, deterministic inline SVG from whitelisted constants only. */
export function iconMarkup(shape, color, expression) {
  const kind = SHAPES.includes(shape) ? shape : SHAPES[0];
  const paint = COLORS.includes(color) ? color : COLORS[0];
  const face = EXPRESSIONS.includes(expression) ? expression : EXPRESSIONS[0];
  if (kind === 'orb') {
    return `${SVG_OPEN} data-icon="orb" data-expression="${face}" fill="${paint}">${bodyFor(kind, face)}</svg>`;
  }
  return `${SVG_OPEN} data-icon="${kind}" data-expression="${face}" stroke="${paint}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${bodyFor(kind, face)}</svg>`;
}

/** Return the stored logoSvg only if it is exactly one of our own canonical icons. */
export function safeAvatarMarkup(bot) {
  const svg = bot && typeof bot.logoSvg === 'string' ? bot.logoSvg : '';
  if (!svg) return null;
  const icon = /data-icon="([^"]*)"/.exec(svg);
  const expr = /data-expression="([^"]*)"/.exec(svg);
  const color = /stroke="(#[0-9a-fA-F]{6})"|fill="(#[0-9a-fA-F]{6})"/.exec(svg);
  if (!icon || !color) return null;
  const canonical = iconMarkup(icon[1], color[1] || color[2], expr ? expr[1] : undefined);
  return canonical === svg ? svg : null;
}

function readParts(bot) {
  const svg = bot && typeof bot.logoSvg === 'string' ? bot.logoSvg : '';
  const shape = /data-icon="([^"]*)"/.exec(svg)?.[1];
  const expression = /data-expression="([^"]*)"/.exec(svg)?.[1];
  return {
    shape: SHAPES.includes(shape) ? shape : SHAPES[0],
    color: COLORS.includes(bot?.logoColor) ? bot.logoColor : COLORS[0],
    expression: EXPRESSIONS.includes(expression) ? expression : EXPRESSIONS[0],
  };
}

let root = null;
let onKeydown = null;
let returnFocus = null;

function close() {
  if (root) root.remove();
  root = null;
  if (onKeydown) document.removeEventListener('keydown', onKeydown);
  onKeydown = null;
  const restore = returnFocus;
  returnFocus = null;
  if (restore?.isConnected) restore.focus();
}

/** Open the identity popover anchored to `anchor`; Save returns { logoSvg, logoColor }. */
export function openBotIdentity({ bot, anchor, onSave } = {}) {
  close();
  returnFocus = anchor ?? null;
  const state = readParts(bot);
  const effectiveExpression = () => (state.shape === 'mascot' ? state.expression : 'neutral');

  root = el('div', 'identity-backdrop');
  const popover = el('div', 'identity-popover');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true');
  popover.setAttribute('aria-label', 'Edit bot identity');
  root.appendChild(popover);

  popover.appendChild(el('div', 'identity-title', 'Edit identity'));
  const preview = el('div', 'identity-preview');
  popover.appendChild(preview);

  popover.appendChild(el('div', 'identity-label', 'Icon'));
  const shapes = el('div', 'identity-shapes');
  const shapeButtons = new Map();
  for (const shape of SHAPES) {
    const button = el('button', 'identity-shape');
    button.type = 'button';
    button.title = shape;
    button.setAttribute('aria-label', shape);
    const glyph = el('span', 'identity-glyph');
    glyph.innerHTML = iconMarkup(shape, COLORS[0], 'neutral');
    button.appendChild(glyph);
    button.onclick = () => { state.shape = shape; refresh(); };
    shapes.appendChild(button);
    shapeButtons.set(shape, button);
  }
  popover.appendChild(shapes);

  popover.appendChild(el('div', 'identity-label', 'Accent color'));
  const colors = el('div', 'identity-colors');
  const colorButtons = new Map();
  for (const color of COLORS) {
    const button = el('button', 'identity-swatch');
    button.type = 'button';
    button.title = color;
    button.setAttribute('aria-label', color);
    button.dataset.color = color;
    button.style.backgroundColor = color;
    button.onclick = () => { state.color = color; refresh(); };
    colors.appendChild(button);
    colorButtons.set(color, button);
  }
  popover.appendChild(colors);

  popover.appendChild(el('div', 'identity-label', 'Expression'));
  const expressions = el('div', 'identity-expressions');
  const expressionButtons = new Map();
  for (const expression of EXPRESSIONS) {
    const button = el('button', 'identity-chip', expression);
    button.type = 'button';
    button.onclick = () => { state.expression = expression; refresh(); };
    expressions.appendChild(button);
    expressionButtons.set(expression, button);
  }
  popover.appendChild(expressions);

  const actions = el('div', 'identity-actions');
  const cancel = el('button', 'identity-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = close;
  const save = el('button', 'identity-save', 'Save');
  save.type = 'button';
  save.onclick = () => {
    const logoSvg = iconMarkup(state.shape, state.color, effectiveExpression());
    const logoColor = state.color;
    close();
    onSave?.({ logoSvg, logoColor });
  };
  actions.append(cancel, save);
  popover.appendChild(actions);

  function refresh() {
    preview.innerHTML = iconMarkup(state.shape, state.color, effectiveExpression());
    for (const [shape, button] of shapeButtons) button.classList.toggle('active', shape === state.shape);
    for (const [color, button] of colorButtons) button.classList.toggle('active', color === state.color);
    for (const [expression, button] of expressionButtons) {
      button.classList.toggle('active', expression === state.expression);
      button.disabled = state.shape !== 'mascot';
    }
  }
  refresh();

  root.onclick = (event) => { if (event.target === root) close(); };
  document.body.appendChild(root);
  shapeButtons.get(SHAPES[0])?.focus();
  onKeydown = (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...popover.querySelectorAll('button')].filter((button) => !button.disabled);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const outside = !popover.contains(document.activeElement);
    if (event.shiftKey && (outside || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || document.activeElement === last)) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown);

  if (anchor && anchor.getBoundingClientRect) {
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${Math.min(rect.bottom + 8, Math.max(0, window.innerHeight - 420))}px`;
    popover.style.left = `${Math.min(rect.left, Math.max(0, window.innerWidth - 320))}px`;
  }
}
