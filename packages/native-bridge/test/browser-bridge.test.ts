import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BrowserBridge, convertHtmlToMarkdown } from "../src/browser-bridge.js";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerNativeTools } from "../src/native-tools.js";

describe("BrowserBridge", () => {
  it("converts raw HTML into clean readable Markdown", () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>OpenSand Architecture &amp; Invariants</title>
          <meta name="description" content="Comprehensive guide to clean-room agent architecture.">
          <style>body { background: #000; }</style>
          <script>console.log("tracking code");</script>
        </head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <h1>System Overview</h1>
          <p>OpenSand is a <strong>local-first</strong> autonomous agent &amp; orchestrator.</p>
          <h2>Code Example</h2>
          <pre><code>const a = 1;\nconsole.log(a);</code></pre>
          <p>Check the <a href="https://github.com/opensand">GitHub Repository</a> for source code.</p>
          <ul>
            <li>Invariant 1: Zero data leakage</li>
            <li>Invariant 2: AES-256 vault protection</li>
          </ul>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const { title, description, markdown } = convertHtmlToMarkdown(rawHtml);

    assert.strictEqual(title, "OpenSand Architecture & Invariants");
    assert.strictEqual(description, "Comprehensive guide to clean-room agent architecture.");

    // Verify scripts, styles, nav, and footer are stripped
    assert.ok(!markdown.includes("console.log(\"tracking code\");"));
    assert.ok(!markdown.includes("background: #000;"));
    assert.ok(!markdown.includes("Copyright 2026"));

    // Verify markdown structure
    assert.ok(markdown.includes("# System Overview"));
    assert.ok(markdown.includes("## Code Example"));
    assert.ok(markdown.includes("```"));
    assert.ok(markdown.includes("[GitHub Repository](https://github.com/opensand)"));
    assert.ok(markdown.includes("- Invariant 1: Zero data leakage"));
    assert.ok(markdown.includes("- Invariant 2: AES-256 vault protection"));
  });

  it("truncates oversized web page text according to maxChars budget", () => {
    const hugeHtml = `<h1>Huge</h1><p>${"Content ".repeat(5000)}</p>`;
    const { markdown } = convertHtmlToMarkdown(hugeHtml, 500);

    assert.ok(markdown.length <= 600);
    assert.ok(markdown.includes("Content truncated for token budget"));
  });

  it("registers web search and browser tools into LocalExecDaemon", () => {
    const daemon = new LocalExecDaemon();
    registerNativeTools(daemon);

    const defs = daemon.getToolDefinitions();
    const names = defs.map((d) => d.function.name);

    assert.ok(names.includes("web_search"));
    assert.ok(names.includes("fetch_web_page"));
    assert.ok(names.includes("safari_inspect_active_tab"));
  });

  it("queries web search and returns structured results", async () => {
    const bridge = new BrowserBridge();
    const results = await bridge.webSearch("Node.js runtime", 3);

    // Results should be an array (if offline or rate-limited, safely returns empty array or hits)
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      assert.ok(results[0].title);
      assert.ok(results[0].url);
      assert.ok(results[0].snippet !== undefined);
    }
  });

  it("handles invalid or non-http protocols safely in fetchWebPage", async () => {
    const bridge = new BrowserBridge();
    await assert.rejects(
      async () => {
        await bridge.fetchWebPage("file:///etc/passwd");
      },
      /Unsupported protocol/
    );
  });
});
