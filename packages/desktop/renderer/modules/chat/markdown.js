// markdown.js — XSS-hardened markdown renderer (extracted from app.js).
// escape-first: every interpolation is escapeHtml'd; link schemes are allowlisted.

import { highlightToHtml } from './highlight.js';
  function renderMarkdown(rawText) {
    if (!rawText) return '';

    let content = rawText;

    // Handle unclosed fenced code block during streaming
    const fenceMatches = content.match(/```/g);
    if (fenceMatches && fenceMatches.length % 2 !== 0) {
      content += '\n```';
    }

    // 1. Extract <thinking> and <think> tags (both closed and unclosed streaming)
    content = content.replace(/<(?:thinking|think)>([\s\S]*?)(?:<\/(?:thinking|think)>|$)/gi, (match, thoughtText) => {
      const trimmed = thoughtText.trim();
      if (!trimmed) return '';
      return `\n<div class="thought-accordion">
  <div class="thought-header">
    <span class="thought-toggle">▶</span>
    <span class="thought-icon">💭</span>
    <span class="thought-label">Thinking Process</span>
  </div>
  <div class="thought-body hidden">${escapeHtml(trimmed)}</div>
</div>\n`;
    });

    // 1.5 Extract [connect-app]{...} markers (OpenBot & Grok Bot Parity)
    const connectCards = [];
    content = content.replace(/\[connect-app\](\{[^}]+\})\s*([^\n]*)/g, (match, rawJson, trailingMsg) => {
      try {
        const data = JSON.parse(rawJson);
        const serverId = escapeHtml(data.serverId || 'app');
        const title = escapeHtml(data.title || serverId);
        const msg = escapeHtml(trailingMsg || data.message || `Connect ${title} to enable this tool.`);
        
        let brandIcon = '🔌';
        let brandColor = '#3b82f6';
        if (serverId === 'slack') {
          brandIcon = '💬';
          brandColor = '#4A154B';
        } else if (serverId === 'linear') {
          brandIcon = '📐';
          brandColor = '#5E6AD2';
        } else if (serverId === 'github') {
          brandIcon = '🐙';
          brandColor = '#24292e';
        }

        const idx = connectCards.length;
        connectCards.push(`
<div class="connect-app-card" data-connect-app="${serverId}" data-title="${title}">
  <div class="connect-card-header">
    <div class="connect-card-icon" style="background-color: ${brandColor};">${brandIcon}</div>
    <div class="connect-card-meta">
      <div class="connect-card-title">Connect ${title}</div>
      <div class="connect-card-subtitle">${msg}</div>
    </div>
    <span class="connect-card-badge badge-pending">Required</span>
  </div>
  <div class="connect-card-body">
    <div class="connect-card-actions">
      <button class="btn btn-primary btn-sm btn-connect-oauth" type="button" data-server="${serverId}" data-title="${title}">
        Connect ${title}
      </button>
      <button class="btn btn-secondary btn-sm btn-connect-manual-toggle" type="button" data-server="${serverId}">
        Enter Token…
      </button>
    </div>
    <div class="connect-manual-form hidden" id="manualForm_${serverId}">
      <input type="password" class="input-text input-sm connect-token-input" placeholder="Paste ${title} Token / API Key" />
      <button class="btn btn-primary btn-sm btn-save-token" type="button" data-server="${serverId}">Save</button>
    </div>
    <div class="connect-card-status-message hidden" role="status"></div>
  </div>
</div>`);
        return `\n%%CONNECT_CARD_${idx}%%\n`;
      } catch {
        return match;
      }
    });

    // 2. Fenced code blocks ```lang\ncode\n```
    const codeBlocks = [];
    content = content.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const idx = codeBlocks.length;
      const cleanLang = /^[a-zA-Z0-9_-]{1,20}$/.test((lang || '').trim()) ? (lang || '').trim() : 'text';
      const cleanCode = code.replace(/\n$/, '');
      const safeCode = escapeHtml(cleanCode);
      codeBlocks.push(`
<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-lang">${cleanLang}</span>
    <div class="code-block-actions">
      <button class="btn-open-canvas" type="button" data-lang="${cleanLang}" title="Open in Canvas">Canvas ⛶</button>
      <button class="btn-copy-code" type="button" data-code="${escapeHtml(cleanCode)}">Copy</button>
    </div>
  </div>
  <pre><code class="language-${cleanLang}">${highlightToHtml(cleanCode, cleanLang)}</code></pre>
</div>`);
      return `\n%%CODE_BLOCK_${idx}%%\n`;
    });

    // 2.5 Markdown Tables (| Header 1 | Header 2 |)
    content = content.replace(/(?:^|\n)(\|[^\n]+\|\r?\n\|[-:\s|]+\|\r?\n(?:\|[^\n]+\|\r?\n?)*)/g, (match, tableText) => {
      const lines = tableText.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return match;
      const parseRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const headers = parseRow(lines[0]);
      const dataRows = lines.slice(2).map(parseRow);
      let html = '<div class="table-container"><table class="markdown-table"><thead><tr>';
      for (const h of headers) {
        html += `<th>${escapeHtml(h)}</th>`;
      }
      html += '</tr></thead><tbody>';
      for (const row of dataRows) {
        html += '<tr>';
        for (let i = 0; i < headers.length; i++) {
          html += `<td>${escapeHtml(row[i] !== undefined ? row[i] : '')}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      return `\n${html}\n`;
    });

    // 3. Inline code `code`
    content = content.replace(/`([^`\n]+)`/g, (match, inlineCode) => {
      return `<code>${escapeHtml(inlineCode)}</code>`;
    });

    // 4. Headings (###, ##, #)
    content = content.replace(/^### (.*$)/gim, (m, t) => `<h4>${escapeHtml(t)}</h4>`);
    content = content.replace(/^## (.*$)/gim, (m, t) => `<h3>${escapeHtml(t)}</h3>`);
    content = content.replace(/^# (.*$)/gim, (m, t) => `<h2>${escapeHtml(t)}</h2>`);

    // 5. Blockquotes (> quote)
    content = content.replace(/^\> (.*$)/gim, (m, t) => `<blockquote>${escapeHtml(t)}</blockquote>`);

    // 6. Bold & Italics
    content = content.replace(/\*\*([^*]+)\*\*/g, (m, t) => `<strong>${escapeHtml(t)}</strong>`);
    content = content.replace(/\*([^*]+)\*/g, (m, t) => `<em>${escapeHtml(t)}</em>`);

    // 7. Task list items (- [ ] or - [x]) and Unordered lists (- item or * item)
    content = content.replace(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/gim, (m, check, text) => {
      const isChecked = check.toLowerCase() === 'x';
      return `<li class="task-list-item"><input type="checkbox" disabled ${isChecked ? 'checked' : ''} /> <span>${escapeHtml(text)}</span></li>`;
    });
    content = content.replace(/^\s*[-*]\s+(.*)$/gim, (m, t) => `<li>${escapeHtml(t)}</li>`);
    content = content.replace(/(<li>.*<\/li>)/gms, '<ul>$1</ul>');
    content = content.replace(/<\/ul>\s*<ul>/g, '');

    // 8. Markdown links [text](url)
    content = content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      const trimmed = String(url).trim();
      if (!/^(?:https?|mailto):/i.test(trimmed) && !trimmed.startsWith('#')) {
        return escapeHtml(String(text));
      }
      return `<a href="${escapeHtml(trimmed)}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(text))}</a>`;
    });

    // 9. Line breaks: replace double newlines with paragraphs, single with <br>
    content = content.replace(/\n{2,}/g, '</p><p>');
    content = content.replace(/\n/g, '<br>');
    content = `<p>${content}</p>`;

    // Clean empty paragraphs and wrappers around block elements
    content = content.replace(/<p>\s*<\/p>/g, '');
    content = content.replace(/<p>\s*(<div class="thought-accordion">[\s\S]*?<\/div>)\s*<\/p>/g, '$1');
    content = content.replace(/<p>\s*(<div class="table-container">[\s\S]*?<\/div>)\s*<\/p>/g, '$1');
    content = content.replace(/<p>\s*(<h2>.*?<\/h2>|<h3>.*?<\/h3>|<h4>.*?<\/h4>|<blockquote>.*?<\/blockquote>|<ul>.*?<\/ul>)\s*<\/p>/g, '$1');

    // 10. Re-insert code blocks and connect cards
    codeBlocks.forEach((blockHtml, i) => {
      content = content.replace(new RegExp(`<p>\\s*%%CODE_BLOCK_${i}%%\\s*<\\/p>|%%CODE_BLOCK_${i}%%`, 'g'), blockHtml);
    });
    connectCards.forEach((cardHtml, i) => {
      content = content.replace(new RegExp(`<p>\\s*%%CONNECT_CARD_${i}%%\\s*<\\/p>|%%CONNECT_CARD_${i}%%`, 'g'), cardHtml);
    });

    return content;
  }


  const __mdCache = new Map();
  function __mdKey(text) {
    const head = text.slice(0, 512);
    const tail = text.slice(-512);
    return `${text.length}:${head}:${tail}`;
  }

  function renderMarkdownCached(text) {
    const key = __mdKey(text);
    const hit = __mdCache.get(key);
    if (hit) return hit;
    // Bound the cache: keep the last 32 entries
    if (__mdCache.size > 32) {
      const firstKey = __mdCache.keys().next().value;
      __mdCache.delete(firstKey);
    }
    const out = renderMarkdown(text);
    __mdCache.set(key, out);
    return out;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


export { renderMarkdown, renderMarkdownCached, escapeHtml };
