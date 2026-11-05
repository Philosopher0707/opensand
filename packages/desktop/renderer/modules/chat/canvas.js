// canvas.js — Side-by-Side Artifact Canvas Controller (Grok Bot & OpenBot Parity)
// Supports split-pane code view with line numbers, sandboxed live preview, unified diffs,
// fullscreen expansion, clipboard copy, and file download.

/**
 * Maps language/extension identifiers to friendly labels and icons.
 */
export const LANGUAGE_METADATA = {
  javascript: { label: 'JavaScript', icon: '🟨', previewable: false },
  js: { label: 'JavaScript', icon: '🟨', previewable: false },
  typescript: { label: 'TypeScript', icon: '🔷', previewable: false },
  ts: { label: 'TypeScript', icon: '🔷', previewable: false },
  tsx: { label: 'TypeScript React', icon: '⚛️', previewable: false },
  jsx: { label: 'JavaScript React', icon: '⚛️', previewable: false },
  html: { label: 'HTML Preview', icon: '🌐', previewable: true },
  htm: { label: 'HTML Preview', icon: '🌐', previewable: true },
  svg: { label: 'SVG Diagram', icon: '🖼️', previewable: true },
  css: { label: 'CSS Stylesheet', icon: '🎨', previewable: false },
  scss: { label: 'SCSS', icon: '🎨', previewable: false },
  json: { label: 'JSON Data', icon: '📋', previewable: false },
  markdown: { label: 'Markdown', icon: '📝', previewable: true },
  md: { label: 'Markdown', icon: '📝', previewable: true },
  python: { label: 'Python', icon: '🐍', previewable: false },
  py: { label: 'Python', icon: '🐍', previewable: false },
  rust: { label: 'Rust', icon: '🦀', previewable: false },
  rs: { label: 'Rust', icon: '🦀', previewable: false },
  go: { label: 'Go', icon: '🐹', previewable: false },
  bash: { label: 'Shell Script', icon: '🐚', previewable: false },
  sh: { label: 'Shell Script', icon: '🐚', previewable: false },
  zsh: { label: 'Zsh Script', icon: '🐚', previewable: false },
  sql: { label: 'SQL Query', icon: '🗄️', previewable: false },
  diff: { label: 'Unified Diff', icon: '🔀', previewable: false },
  patch: { label: 'Patch Diff', icon: '🔀', previewable: false },
};

export function resolveLanguageMeta(langOrExt) {
  const key = (langOrExt || '').toLowerCase().trim().replace(/^\./, '');
  return LANGUAGE_METADATA[key] || {
    label: key ? key.toUpperCase() : 'Code',
    icon: '📄',
    previewable: false,
  };
}

/**
 * Parses unified diff text into structured line records with line numbers.
 */
export function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== 'string') return [];
  const lines = diffText.split(/\r?\n/);
  const records = [];
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Chunk header @@ -old,len +new,len @@
    const chunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (chunkMatch) {
      oldLine = parseInt(chunkMatch[1], 10);
      newLine = parseInt(chunkMatch[2], 10);
      records.push({
        type: 'chunk',
        oldNum: null,
        newNum: null,
        text: raw,
      });
      continue;
    }

    if (raw.startsWith('---') || raw.startsWith('+++')) {
      records.push({
        type: 'file-header',
        oldNum: null,
        newNum: null,
        text: raw,
      });
      continue;
    }

    if (raw.startsWith('+')) {
      records.push({
        type: 'add',
        oldNum: null,
        newNum: newLine++,
        text: raw.slice(1),
      });
    } else if (raw.startsWith('-')) {
      records.push({
        type: 'del',
        oldNum: oldLine++,
        newNum: null,
        text: raw.slice(1),
      });
    } else {
      // Context line
      records.push({
        type: 'context',
        oldNum: oldLine ? oldLine++ : null,
        newNum: newLine ? newLine++ : null,
        text: raw.startsWith(' ') ? raw.slice(1) : raw,
      });
    }
  }

  return records;
}

/**
 * Builds HTML markup for unified diff rows.
 */
export function renderDiffHtml(diffText, escapeHtmlFn = (s) => s) {
  const records = parseUnifiedDiff(diffText);
  if (records.length === 0) {
    return '<div class="diff-empty">No diff content to display.</div>';
  }

  let html = '<div class="diff-table">';
  for (const r of records) {
    if (r.type === 'chunk') {
      html += `<div class="diff-row diff-chunk-row">
        <div class="diff-gutter-num"></div>
        <div class="diff-gutter-num"></div>
        <div class="diff-line-content diff-chunk-text">${escapeHtmlFn(r.text)}</div>
      </div>`;
    } else if (r.type === 'file-header') {
      html += `<div class="diff-row diff-header-row">
        <div class="diff-gutter-num"></div>
        <div class="diff-gutter-num"></div>
        <div class="diff-line-content diff-header-text">${escapeHtmlFn(r.text)}</div>
      </div>`;
    } else if (r.type === 'add') {
      html += `<div class="diff-row diff-row-add">
        <div class="diff-gutter-num"></div>
        <div class="diff-gutter-num">${r.newNum ?? ''}</div>
        <div class="diff-marker">+</div>
        <div class="diff-line-content">${escapeHtmlFn(r.text)}</div>
      </div>`;
    } else if (r.type === 'del') {
      html += `<div class="diff-row diff-row-del">
        <div class="diff-gutter-num">${r.oldNum ?? ''}</div>
        <div class="diff-gutter-num"></div>
        <div class="diff-marker">-</div>
        <div class="diff-line-content">${escapeHtmlFn(r.text)}</div>
      </div>`;
    } else {
      html += `<div class="diff-row diff-row-context">
        <div class="diff-gutter-num">${r.oldNum ?? ''}</div>
        <div class="diff-gutter-num">${r.newNum ?? ''}</div>
        <div class="diff-marker">&nbsp;</div>
        <div class="diff-line-content">${escapeHtmlFn(r.text)}</div>
      </div>`;
    }
  }
  html += '</div>';
  return html;
}

/**
 * Generates plain-text line numbers for the code gutter.
 */
export function generateLineNumbers(text) {
  if (!text) return '1';
  const lineCount = (text.match(/\n/g) || []).length + 1;
  const numbers = [];
  for (let i = 1; i <= lineCount; i++) {
    numbers.push(i);
  }
  return numbers.join('\n');
}

/**
 * Creates and manages the Artifact Canvas component lifecycle.
 */
export function createArtifactCanvas(options = {}) {
  const {
    canvasEl,
    iconEl,
    titleEl,
    badgeEl,
    tabCodeBtn,
    tabPreviewBtn,
    tabDiffBtn,
    codePaneEl,
    previewPaneEl,
    diffPaneEl,
    codeContentEl,
    lineNumbersEl,
    previewIframeEl,
    markdownPreviewEl,
    diffContentEl,
    copyBtn,
    downloadBtn,
    expandBtn,
    closeBtn,
    toggleBtn,
    renderMarkdownFn,
    escapeHtmlFn = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    onStateChange,
  } = options;

  let state = {
    isOpen: false,
    isFullscreen: false,
    activeTab: 'code', // 'code' | 'preview' | 'diff'
    title: 'Artifact',
    language: 'text',
    content: '',
    diff: '',
    filePath: '',
  };

  function updateUi() {
    if (!canvasEl) return;

    if (state.isOpen) {
      canvasEl.classList.remove('hidden');
    } else {
      canvasEl.classList.add('hidden');
      if (state.isFullscreen) {
        setFullscreen(false);
      }
    }

    if (toggleBtn) {
      toggleBtn.classList.toggle('active', state.isOpen);
    }

    // Title and Meta
    const meta = resolveLanguageMeta(state.language);
    if (iconEl) iconEl.textContent = meta.icon;
    if (titleEl) {
      titleEl.textContent = state.title || 'Artifact';
      titleEl.title = state.filePath || state.title || 'Artifact';
    }
    if (badgeEl) badgeEl.textContent = meta.label;

    // Tabs Visibility & Availability
    const hasPreview = meta.previewable || state.language === 'html' || state.language === 'svg' || state.language === 'markdown' || state.language === 'md';
    const hasDiff = Boolean(state.diff && state.diff.trim());

    if (tabPreviewBtn) {
      tabPreviewBtn.disabled = !hasPreview;
      tabPreviewBtn.classList.toggle('disabled', !hasPreview);
    }
    if (tabDiffBtn) {
      tabDiffBtn.disabled = !hasDiff;
      tabDiffBtn.classList.toggle('disabled', !hasDiff);
    }

    // Active Tab button state
    if (tabCodeBtn) tabCodeBtn.classList.toggle('active', state.activeTab === 'code');
    if (tabPreviewBtn) tabPreviewBtn.classList.toggle('active', state.activeTab === 'preview');
    if (tabDiffBtn) tabDiffBtn.classList.toggle('active', state.activeTab === 'diff');

    // Panes visibility
    if (codePaneEl) codePaneEl.classList.toggle('hidden', state.activeTab !== 'code');
    if (previewPaneEl) previewPaneEl.classList.toggle('hidden', state.activeTab !== 'preview');
    if (diffPaneEl) diffPaneEl.classList.toggle('hidden', state.activeTab !== 'diff');

    if (onStateChange) onStateChange({ ...state });
  }

  function switchTab(tabName) {
    if (tabName !== 'code' && tabName !== 'preview' && tabName !== 'diff') return;
    state.activeTab = tabName;

    if (tabName === 'preview') {
      renderPreviewPane();
    } else if (tabName === 'diff') {
      renderDiffPane();
    } else {
      renderCodePane();
    }

    updateUi();
  }

  function renderCodePane() {
    if (lineNumbersEl) {
      lineNumbersEl.textContent = generateLineNumbers(state.content);
    }
    if (codeContentEl) {
      codeContentEl.textContent = state.content;
      codeContentEl.className = `canvas-code-content language-${state.language || 'text'}`;
    }
  }

  function renderPreviewPane() {
    const lang = (state.language || '').toLowerCase().trim();

    if (lang === 'markdown' || lang === 'md') {
      if (previewIframeEl) previewIframeEl.classList.add('hidden');
      if (markdownPreviewEl) {
        markdownPreviewEl.classList.remove('hidden');
        if (typeof renderMarkdownFn === 'function') {
          markdownPreviewEl.innerHTML = renderMarkdownFn(state.content);
        } else {
          markdownPreviewEl.textContent = state.content;
        }
      }
      return;
    }

    // HTML / SVG / Web Preview via Sandboxed Iframe
    if (markdownPreviewEl) markdownPreviewEl.classList.add('hidden');
    if (previewIframeEl) {
      previewIframeEl.classList.remove('hidden');
      let srcDoc = state.content;

      if (lang === 'svg') {
        srcDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 24px; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #0f1115; }
    svg { max-width: 100%; height: auto; filter: drop-shadow(0 8px 16px rgba(0,0,0,0.4)); }
  </style>
</head>
<body>${state.content}</body>
</html>`;
      } else if (!srcDoc.includes('<html') && !srcDoc.includes('<!DOCTYPE')) {
        srcDoc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 20px; color: #24292f; background: #ffffff; }
  </style>
</head>
<body>
  ${srcDoc}
</body>
</html>`;
      }

      previewIframeEl.srcdoc = srcDoc;
    }
  }

  function renderDiffPane() {
    if (diffContentEl) {
      diffContentEl.innerHTML = renderDiffHtml(state.diff, escapeHtmlFn);
    }
  }

  function openArtifact(artifact = {}) {
    state.title = artifact.title || 'Artifact';
    state.language = artifact.language || 'text';
    state.content = artifact.content || '';
    state.diff = artifact.diff || '';
    state.filePath = artifact.filePath || '';
    state.isOpen = true;

    // Pick smart default tab:
    // If diff is explicit, open on diff
    // Else if previewable (e.g. html/svg/md), open on preview if autoPreview requested
    // Otherwise open code
    if (artifact.defaultTab === 'diff' || (artifact.diff && !artifact.content)) {
      state.activeTab = 'diff';
    } else if (artifact.autoPreview || artifact.defaultTab === 'preview') {
      const meta = resolveLanguageMeta(state.language);
      state.activeTab = meta.previewable ? 'preview' : 'code';
    } else {
      state.activeTab = 'code';
    }

    renderCodePane();
    if (state.activeTab === 'preview') renderPreviewPane();
    if (state.activeTab === 'diff') renderDiffPane();

    updateUi();
  }

  function closeArtifact() {
    state.isOpen = false;
    updateUi();
  }

  function toggleCanvas() {
    if (state.isOpen) {
      closeArtifact();
    } else {
      state.isOpen = true;
      updateUi();
    }
  }

  function setFullscreen(isFullscreen) {
    state.isFullscreen = Boolean(isFullscreen);
    if (canvasEl) {
      canvasEl.classList.toggle('fullscreen', state.isFullscreen);
    }
    if (expandBtn) {
      expandBtn.textContent = state.isFullscreen ? '🗗' : '⛶';
      expandBtn.title = state.isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen';
    }
    if (onStateChange) onStateChange({ ...state });
  }

  function toggleFullscreen() {
    setFullscreen(!state.isFullscreen);
  }

  async function copyContent() {
    const textToCopy = state.activeTab === 'diff' && state.diff ? state.diff : state.content;
    if (!textToCopy) return;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(textToCopy);
      }
      if (copyBtn) {
        const prevText = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => {
          copyBtn.textContent = prevText;
        }, 1800);
      }
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
  }

  function downloadContent() {
    const textToDownload = state.activeTab === 'diff' && state.diff ? state.diff : state.content;
    if (!textToDownload) return;

    try {
      const blob = new Blob([textToDownload], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = state.language === 'text' ? 'txt' : state.language;
      const baseName = (state.title || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_');
      a.download = baseName.includes('.') ? baseName : `${baseName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('Download artifact failed:', err);
    }
  }

  // Wire event handlers
  if (tabCodeBtn) tabCodeBtn.addEventListener('click', () => switchTab('code'));
  if (tabPreviewBtn) tabPreviewBtn.addEventListener('click', () => switchTab('preview'));
  if (tabDiffBtn) tabDiffBtn.addEventListener('click', () => switchTab('diff'));
  if (copyBtn) copyBtn.addEventListener('click', copyContent);
  if (downloadBtn) downloadBtn.addEventListener('click', downloadContent);
  if (expandBtn) expandBtn.addEventListener('click', toggleFullscreen);
  if (closeBtn) closeBtn.addEventListener('click', closeArtifact);
  if (toggleBtn) toggleBtn.addEventListener('click', toggleCanvas);

  return {
    getState: () => ({ ...state }),
    openArtifact,
    closeArtifact,
    toggleCanvas,
    switchTab,
    setFullscreen,
    toggleFullscreen,
    copyContent,
    downloadContent,
    updateUi,
  };
}
