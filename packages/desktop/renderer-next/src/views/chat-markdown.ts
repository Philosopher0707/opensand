// packages/desktop/renderer-next/src/views/chat-markdown.ts
// Pure, lightweight, XSS-hardened markdown renderer for the Preact chat screen.
// Escapes raw HTML first, handles code blocks, headings, lists, links, bold, italic.

export function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeHref(url: string): string {
  const trimmed = String(url || "").trim();
  if (/^(https?:|file:|mailto:|\/|#)/i.test(trimmed)) {
    return trimmed;
  }
  return "#";
}

export function renderMarkdown(rawText: string): string {
  if (!rawText) return "";
  let text = rawText;

  // Balance unclosed fenced code block during streaming
  const fenceMatches = text.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    text += "\n```";
  }

  // 1. Extract fenced code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const cleanLang = /^[a-zA-Z0-9_-]{1,20}$/.test((lang || "").trim()) ? (lang || "").trim() : "text";
    const cleanCode = code.replace(/\n$/, "");
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${cleanLang}</span><button class="btn-copy-code" type="button" data-code="${escapeHtml(cleanCode)}">Copy</button></div><pre><code class="language-${cleanLang}">${escapeHtml(cleanCode)}</code></pre></div>`
    );
    return `\n\x00CODEBLOCK${idx}\x00\n`;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, inlineCode) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(inlineCode)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // 3. Escape HTML
  text = escapeHtml(text);

  // 4. Headings
  text = text.replace(/^#### (.*$)/gim, "<h5>$1</h5>");
  text = text.replace(/^### (.*$)/gim, "<h4>$1</h4>");
  text = text.replace(/^## (.*$)/gim, "<h3>$1</h3>");
  text = text.replace(/^# (.*$)/gim, "<h2>$1</h2>");

  // 5. Blockquotes
  text = text.replace(/^> (.*$)/gim, "<blockquote>$1</blockquote>");

  // 6. Bold & Italic
  text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.*?)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^\*\n]+)\*/g, "<em>$1</em>");
  text = text.replace(/_([^_\n]+)_/g, "<em>$1</em>");

  // 7. Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const safe = sanitizeHref(href);
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 8. Lists
  text = text.replace(/(?:^|\n)[*-] (.*(?:\n[*-] .*)*)/g, (match) => {
    const items = match
      .trim()
      .split(/\n/)
      .map((line) => line.replace(/^[*-] /, "").trim());
    return "\n<ul>" + items.map((it) => `<li>${it}</li>`).join("") + "</ul>\n";
  });
  text = text.replace(/(?:^|\n)\d+\. (.*(?:\n\d+\. .*)*)/g, (match) => {
    const items = match
      .trim()
      .split(/\n/)
      .map((line) => line.replace(/^\d+\. /, "").trim());
    return "\n<ol>" + items.map((it) => `<li>${it}</li>`).join("") + "</ol>\n";
  });

  // 9. Paragraphs and Linebreaks
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  text = paragraphs
    .map((p) => {
      p = p.trim();
      if (/^<(h[2-5]|ul|ol|blockquote|div)/i.test(p) || p.includes("\x00CODEBLOCK")) {
        return p;
      }
      return `<p>${p.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");

  // 10. Re-insert code blocks and inline code
  codeBlocks.forEach((block, idx) => {
    text = text.replace(`\x00CODEBLOCK${idx}\x00`, block);
  });
  inlineCodes.forEach((code, idx) => {
    text = text.replace(`\x00INLINE${idx}\x00`, code);
  });

  return text;
}
