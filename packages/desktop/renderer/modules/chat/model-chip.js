// One place that writes the active model into the top bar and the composer chip, so the two
// can never disagree. Kept pure (plain element-like objects) so node:test can drive it.
export function modelShortName(name) {
  const text = String(name || '').trim();
  return text.includes('/') ? text.split('/').pop() : text;
}

// A bot with its own model wins over the global model.
export function effectiveModel({ botModel, settingsModel } = {}) {
  return String(botModel || '').trim() || String(settingsModel || '').trim() || 'Default';
}

export function applyActiveModel({ topBar, chip }, name, detail) {
  const full = String(name || '').trim();
  if (!full || full === 'Model') return;
  const label = modelShortName(full);
  const title = detail ? `Active Model: ${full} (${detail})` : `Active Model: ${full}`;
  for (const node of [topBar, chip]) {
    if (!node) continue;
    node.textContent = label;
    node.title = title;
  }
}
