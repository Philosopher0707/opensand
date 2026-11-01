import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebPageContent {
  url: string;
  title: string;
  description?: string;
  markdown: string;
  contentLength: number;
  statusCode: number;
}

/**
 * Pure standard HTML to Markdown converter without heavy DOM dependencies.
 * Strips script, style, navigation, ads and converts headings, paragraphs, lists, and code blocks.
 */
export function convertHtmlToMarkdown(html: string, maxChars = 40000): { title: string; description?: string; markdown: string } {
  // 1. Extract Title
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : "Untitled Web Page";

  // 2. Extract Meta Description
  const descMatch = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)
    || /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html);
  const description = descMatch ? decodeHtmlEntities(descMatch[1].trim()) : undefined;

  // 3. Remove non-content blocks
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "");

  // 4. Transform semantic elements to markdown
  // Headings
  clean = clean.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n");
  clean = clean.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n");
  clean = clean.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n");
  clean = clean.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n#### $1\n\n");

  // Code blocks
  clean = clean.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n\n```\n$1\n```\n\n");
  clean = clean.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n\n```\n$1\n```\n\n");
  clean = clean.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Lists & items
  clean = clean.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  clean = clean.replace(/<\/(ul|ol)>/gi, "\n");

  // Paragraphs & breaks
  clean = clean.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n\n$1\n\n");
  clean = clean.replace(/<br\s*\/?>/gi, "\n");
  clean = clean.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Links: <a href="url">text</a> -> [text](url)
  clean = clean.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, text) => {
    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (!cleanText || href.startsWith("javascript:") || href.startsWith("#")) return cleanText;
    return `[${cleanText}](${href})`;
  });

  // Strip all remaining HTML tags
  clean = clean.replace(/<[^>]+>/g, "");

  // Decode entities & collapse whitespace
  clean = decodeHtmlEntities(clean);
  clean = clean
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  // Cap size
  if (clean.length > maxChars) {
    clean = clean.slice(0, maxChars) + "\n\n...[Content truncated for token budget]";
  }

  return { title, description, markdown: clean };
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

export class BrowserBridge {
  private userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  /**
   * Search the web using DuckDuckGo Instant Answers & Wikipedia API
   * Zero third-party packages, zero API keys required.
   */
  async webSearch(query: string, maxResults = 8): Promise<WebSearchResult[]> {
    const results: WebSearchResult[] = [];
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // 1. Query DuckDuckGo Instant Answers API
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(ddgUrl, {
        headers: { "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const data = await res.json() as any;
        if (data.AbstractText && data.AbstractURL) {
          results.push({
            title: data.Heading || cleanQuery,
            url: data.AbstractURL,
            snippet: data.AbstractText,
            source: "DuckDuckGo Instant Answer",
          });
        }

        if (Array.isArray(data.RelatedTopics)) {
          for (const item of data.RelatedTopics) {
            if (results.length >= maxResults) break;
            if (item.Text && item.FirstURL) {
              results.push({
                title: item.Text.split(" - ")[0] || item.Text.slice(0, 50),
                url: item.FirstURL,
                snippet: item.Text,
                source: "DuckDuckGo Topic",
              });
            }
          }
        }
      }
    } catch {
      // Fall through to next provider
    }

    // 2. Query Wikipedia API for technical and knowledge queries
    if (results.length < maxResults) {
      try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&format=json&utf8=1`;
        const res = await fetch(wikiUrl, {
          headers: { "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(5000),
        });

        if (res.ok) {
          const data = await res.json() as any;
          const searchHits = data?.query?.search || [];
          for (const hit of searchHits) {
            if (results.length >= maxResults) break;
            const snippet = hit.snippet ? hit.snippet.replace(/<[^>]+>/g, "") : "";
            results.push({
              title: hit.title,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/\s+/g, "_"))}`,
              snippet,
              source: "Wikipedia",
            });
          }
        }
      } catch {
        // Best effort
      }
    }

    return results;
  }

  /**
   * Fetch and inspect web page content, converting HTML to clean Markdown
   */
  async fetchWebPage(urlStr: string, maxBytes = 40000): Promise<WebPageContent> {
    const url = new URL(urlStr);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Unsupported protocol: ${url.protocol}. Only http and https are allowed.`);
    }

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });

    const rawHtml = await res.text();
    const { title, description, markdown } = convertHtmlToMarkdown(rawHtml, maxBytes);

    return {
      url: url.toString(),
      title,
      description,
      markdown,
      contentLength: markdown.length,
      statusCode: res.status,
    };
  }

  /**
   * Inspect current Safari active tab on macOS
   */
  async inspectSafariActiveTab(): Promise<{ url: string; title: string } | null> {
    try {
      const script = `tell application "Safari"
        if (count of windows) > 0 then
          set currTab to current tab of window 1
          return (URL of currTab) & "|||" & (name of currTab)
        end if
        return ""
      end tell`;

      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      const line = stdout.trim();
      if (!line || !line.includes("|||")) return null;
      const [tabUrl, tabTitle] = line.split("|||");
      return { url: tabUrl, title: tabTitle };
    } catch {
      return null;
    }
  }
}
