const $ = (id) => document.getElementById(id);

function fail(message) {
  const error = $('error');
  error.textContent = message;
  error.hidden = false;
}

async function post(body) {
  const res = await fetch('/api/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showPrimer() {
  $('choose').hidden = true;
  $('primer').hidden = false;
  $('start').focus();
}

async function init() {
  const res = await fetch('/api/onboarding');
  if (!res.ok) {
    fail(`Could not read settings (${res.status}).`);
    return;
  }
  const state = await res.json();
  if (!state.needsOnboarding) {
    location.replace('/');
    return;
  }

  if (state.ollama && state.ollama.available) {
    $('ollamaBlock').hidden = false;
    const model = state.ollama.models[0];
    if (model) $('ollamaModel').textContent = ` · ${model}`;
  }

  // Do not prefill the key form with the local Ollama endpoint.
  try {
    const host = new URL(state.endpoint).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') $('endpoint').value = state.endpoint;
  } catch {
    // Keep the cloud default.
  }
}

$('useOllama').addEventListener('click', async () => {
  $('error').hidden = true;
  try {
    await post({ mode: 'ollama' });
    showPrimer();
  } catch (err) {
    fail(err.message);
  }
});

$('keyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('error').hidden = true;
  try {
    await post({
      mode: 'key',
      endpoint: $('endpoint').value,
      model: $('model').value,
      apiKey: $('apiKey').value,
    });
    $('apiKey').value = '';
    showPrimer();
  } catch (err) {
    fail(err.message);
  }
});

$('start').addEventListener('click', () => {
  location.href = '/';
});

init().catch((err) => fail(err.message));
