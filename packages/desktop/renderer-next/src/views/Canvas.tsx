// packages/desktop/renderer-next/src/views/Canvas.tsx
// Preact Artifact Canvas: side-by-side split pane for code, markdown, and html/svg preview.
// Features multi-tab management, synchronized line numbers, clipboard copy, and preview toggle.

import { useState } from "preact/hooks";
import {
  generateLineNumbers,
  resolveLanguageMeta,
  type ArtifactItem,
  type CanvasState,
} from "../../../src/shell/canvas-model";
import { renderMarkdown } from "./chat-markdown";

export interface CanvasProps {
  state: CanvasState;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseCanvas: () => void;
  onSetViewMode: (id: string, mode: "code" | "preview" | "diff") => void;
}

export function Canvas({
  state,
  onSelectTab,
  onCloseTab,
  onCloseCanvas,
  onSetViewMode,
}: CanvasProps) {
  const [copied, setCopied] = useState(false);

  if (!state.isOpen || state.artifacts.length === 0) {
    return null;
  }

  const activeArtifact: ArtifactItem | undefined =
    state.artifacts.find((a) => a.id === state.activeId) || state.artifacts[0];

  if (!activeArtifact) {
    return null;
  }

  const activeMeta = resolveLanguageMeta(activeArtifact.language);
  const lineNumbers = generateLineNumbers(activeArtifact.content);

  const handleCopy = () => {
    if (activeArtifact.content && navigator.clipboard) {
      navigator.clipboard.writeText(activeArtifact.content).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  };

  const isMarkdown =
    activeArtifact.language === "markdown" || activeArtifact.language === "md";
  const isSvg = activeArtifact.language === "svg";
  const isHtml =
    activeArtifact.language === "html" || activeArtifact.language === "htm";

  return (
    <aside
      class="canvas-container"
      id="artifactCanvas"
      data-screen="canvas"
      aria-label="Artifact Canvas"
    >
      {/* Tab Strip */}
      <nav class="canvas-tabs canvas-tab-strip" id="canvasTabStrip" role="tablist" aria-label="Open Artifacts">
        {state.artifacts.map((art) => {
          const meta = resolveLanguageMeta(art.language);
          const isActive = art.id === activeArtifact.id;
          return (
            <div
              key={art.id}
              class={`canvas-file-tab ${isActive ? "active" : ""}`}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => onSelectTab(art.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectTab(art.id);
                }
              }}
            >
              <span class="canvas-file-tab-icon" aria-hidden="true">{meta.icon}</span>
              <span class="canvas-file-tab-label" title={art.title}>{art.title}</span>
              <button
                type="button"
                class="canvas-file-tab-close"
                title={`Close ${art.title}`}
                aria-label={`Close ${art.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(art.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}
      </nav>

      {/* Canvas Header */}
      <header class="canvas-header">
        <div class="canvas-header-left">
          <span class="canvas-icon" aria-hidden="true">{activeMeta.icon}</span>
          <span class="canvas-title" title={activeArtifact.title}>{activeArtifact.title}</span>
          <span class="badge badge-canvas">{activeMeta.label}</span>
        </div>
        <div class="canvas-header-actions">
          {activeMeta.previewable && (
            <div class="canvas-tab-group" role="group" aria-label="View Mode">
              <button
                type="button"
                class={`canvas-tab ${activeArtifact.viewMode === "code" ? "active" : ""}`}
                onClick={() => onSetViewMode(activeArtifact.id, "code")}
              >
                Code
              </button>
              <button
                type="button"
                class={`canvas-tab ${activeArtifact.viewMode === "preview" ? "active" : ""}`}
                onClick={() => onSetViewMode(activeArtifact.id, "preview")}
              >
                Preview
              </button>
              {activeArtifact.diff && (
                <button
                  type="button"
                  class={`canvas-tab ${activeArtifact.viewMode === "diff" ? "active" : ""}`}
                  onClick={() => onSetViewMode(activeArtifact.id, "diff")}
                >
                  Diff
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            class="btn btn-sm btn-canvas-action btn-copy-canvas"
            title="Copy content to clipboard"
            onClick={handleCopy}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-close-canvas"
            id="btnCloseCanvas"
            title="Close Canvas"
            aria-label="Close Canvas"
            onClick={onCloseCanvas}
          >
            ✕
          </button>
        </div>
      </header>

      {/* Canvas Body */}
      <div class="canvas-body" id="canvasBody">
        {activeArtifact.viewMode === "preview" && activeMeta.previewable ? (
          isMarkdown ? (
            <div
              class="canvas-pane canvas-markdown-preview chat-markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(activeArtifact.content) }}
            />
          ) : isSvg ? (
            <div
              class="canvas-pane canvas-preview-pane svg-preview"
              dangerouslySetInnerHTML={{ __html: activeArtifact.content }}
            />
          ) : isHtml ? (
            <div class="canvas-pane canvas-preview-pane html-preview">
              <iframe
                class="canvas-preview-iframe"
                sandbox="allow-scripts"
                title="Preview"
                srcdoc={activeArtifact.content}
              />
            </div>
          ) : (
            <div class="canvas-pane canvas-code-pane" id="canvasCodePane">
              <div class="canvas-line-numbers" id="canvasLineNumbers" aria-hidden="true">{lineNumbers}</div>
              <pre class="canvas-code-pre"><code class={`canvas-code-content language-${activeArtifact.language}`}>{activeArtifact.content}</code></pre>
            </div>
          )
        ) : activeArtifact.viewMode === "diff" && activeArtifact.diff ? (
          <div class="canvas-pane canvas-diff-pane">
            <pre class="canvas-diff-pre">{activeArtifact.diff}</pre>
          </div>
        ) : (
          <div class="canvas-pane canvas-code-pane" id="canvasCodePane">
            <div class="canvas-line-numbers" id="canvasLineNumbers" aria-hidden="true">{lineNumbers}</div>
            <pre class="canvas-code-pre"><code class={`canvas-code-content language-${activeArtifact.language}`}>{activeArtifact.content}</code></pre>
          </div>
        )}
      </div>
    </aside>
  );
}
