// Continuous Learned Guidelines modal (Phase 5 Row 27).
// Replaces the legacy #learnedRulesModal opened from the account menu.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  LEARNED_RULES_DONE,
  LEARNED_RULES_LOADING,
  LEARNED_RULES_REFRESHING,
  reportSummary,
  rulesContent,
} from "../../../src/shell/learned-rules-model";

export interface LearnedRulesModalProps {
  data: ShellData;
  open: boolean;
  onClose: () => void;
}

export function LearnedRulesModal({ data, open, onClose }: LearnedRulesModalProps) {
  const [content, setContent] = useState(LEARNED_RULES_LOADING);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContent(LEARNED_RULES_LOADING);
    setError(null);
    (async () => {
      try {
        const rules = await data.getLearnedRules();
        if (!cancelled) setContent(rulesContent(rules));
      } catch (err) {
        if (!cancelled) setContent(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    setContent(LEARNED_RULES_REFRESHING);
    try {
      const report = await data.refreshLearnedRules();
      setContent(reportSummary(report));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setContent(LEARNED_RULES_DONE);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      id="learnedRulesModal"
      class={`modal-overlay${open ? "" : " hidden"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="learnedRulesModalTitle"
    >
      <div class="modal-card">
        <div class="modal-header">
          <h3 id="learnedRulesModalTitle">🧠 Continuous Learned User Guidelines</h3>
          <button id="btnCloseLearnedRules" type="button" class="btn-close" aria-label="Close learned rules" onClick={onClose}>
            &times;
          </button>
        </div>
        <div class="modal-body">
          <p class="learned-rules-intro">
            Automatically extracted from your conversation transcripts according to Grok Bot Continuous Learning standards:
          </p>
          {error && <div class="learned-rules-error" role="alert">{error}</div>}
          <pre class="markdown-viewer learned-rules-content" id="learnedRulesContent">{content}</pre>
        </div>
        <div class="modal-actions">
          <button id="btnRefreshLearnedRules" type="button" class="btn btn-secondary" disabled={refreshing}
            onClick={() => void handleRefresh()}>
            {refreshing ? "Re-analyzing…" : "Re-Analyze Transcripts"}
          </button>
          <button id="btnCloseLearnedRulesAction" type="button" class="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
