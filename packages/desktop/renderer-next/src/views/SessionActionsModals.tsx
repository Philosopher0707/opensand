// BTW side question, rollback and compact modals (Phase 5 Row 28).
// Replaces the three legacy modals; rollback/compact must be confirmed before running.
import { useEffect, useState } from "preact/hooks";
import type { ShellData } from "../data";
import {
  BTW_NO_ANSWER,
  BTW_VALIDATION_MESSAGE,
  COMPACT_DEFAULT_KEEP,
  ROLLBACK_DEFAULT_TURNS,
  actionErrorMessage,
  btwAnswer,
  compactMessage,
  parsePositive,
  rollbackMessage,
  validateBtw,
} from "../../../src/shell/session-actions-model";

export interface SessionActionsModalsProps {
  data: ShellData;
  btwOpen: boolean;
  rollbackOpen: boolean;
  compactOpen: boolean;
  onClose: (which: "btw" | "rollback" | "compact") => void;
  onActionDone?: () => void;
}

export function SessionActionsModals({ data, btwOpen, rollbackOpen, compactOpen, onClose, onActionDone }: SessionActionsModalsProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [btwError, setBtwError] = useState<string | null>(null);
  const [btwBusy, setBtwBusy] = useState(false);

  const [turns, setTurns] = useState(String(ROLLBACK_DEFAULT_TURNS));
  const [rollbackStatus, setRollbackStatus] = useState("");
  const [rollbackBusy, setRollbackBusy] = useState(false);

  const [keep, setKeep] = useState(String(COMPACT_DEFAULT_KEEP));
  const [compactStatus, setCompactStatus] = useState("");
  const [compactBusy, setCompactBusy] = useState(false);

  useEffect(() => {
    if (!btwOpen) return;
    setQuestion("");
    setAnswer("");
    setBtwError(null);
  }, [btwOpen]);
  useEffect(() => {
    if (!rollbackOpen) return;
    setTurns(String(ROLLBACK_DEFAULT_TURNS));
    setRollbackStatus("");
  }, [rollbackOpen]);
  useEffect(() => {
    if (!compactOpen) return;
    setKeep(String(COMPACT_DEFAULT_KEEP));
    setCompactStatus("");
  }, [compactOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      if (compactOpen) onClose("compact");
      else if (rollbackOpen) onClose("rollback");
      else if (btwOpen) onClose("btw");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [btwOpen, rollbackOpen, compactOpen, onClose]);

  const handleBtw = async () => {
    const error = validateBtw(question);
    if (error) {
      setBtwError(error);
      return;
    }
    setBtwBusy(true);
    setBtwError(null);
    try {
      setAnswer(btwAnswer(await data.askBtw(question)));
    } catch (err) {
      setBtwError(actionErrorMessage(err));
      setAnswer("");
    } finally {
      setBtwBusy(false);
    }
  };

  const handleRollback = async () => {
    setRollbackBusy(true);
    try {
      setRollbackStatus(rollbackMessage(await data.rollbackTurns(parsePositive(turns, ROLLBACK_DEFAULT_TURNS))));
      onActionDone?.();
    } catch (err) {
      setRollbackStatus(actionErrorMessage(err));
    } finally {
      setRollbackBusy(false);
    }
  };

  const handleCompact = async () => {
    setCompactBusy(true);
    try {
      setCompactStatus(compactMessage(await data.compactHistory(parsePositive(keep, COMPACT_DEFAULT_KEEP))));
      onActionDone?.();
    } catch (err) {
      setCompactStatus(actionErrorMessage(err));
    } finally {
      setCompactBusy(false);
    }
  };

  return (
    <>
      <div id="btwModal" class={`modal-overlay${btwOpen ? "" : " hidden"}`} role="dialog" aria-modal="true" aria-labelledby="btwModalTitle">
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="btwModalTitle">💬 By The Way — Ephemeral Question</h3>
            <button id="btnCloseBtw" type="button" class="btn-close" aria-label="Close BTW dialog" onClick={() => onClose("btw")}>&times;</button>
          </div>
          <div class="modal-body">
            <p class="session-action-intro">Ask a one-off question without adding it to the conversation transcript.</p>
            <div class="form-group">
              <label for="btwQuestion">Question</label>
              <textarea id="btwQuestion" class="form-control" rows={4} value={question}
                onInput={(e) => setQuestion((e.currentTarget as HTMLTextAreaElement).value)} />
            </div>
            {btwError && <div class="session-action-error" role="alert">{btwError}</div>}
            {answer && (
              <div id="btwAnswerContainer" class="session-action-result">
                <div id="btwAnswerContent">{answer === BTW_NO_ANSWER ? BTW_NO_ANSWER : answer}</div>
              </div>
            )}
          </div>
          <div class="modal-actions">
            <button id="btnSubmitBtw" type="button" class="btn btn-primary" disabled={btwBusy} onClick={() => void handleBtw()}>
              {btwBusy ? "Evaluating..." : answer ? "Ask Another" : "Ask Ephemeral"}
            </button>
            <button id="btnCloseBtwDone" type="button" class="btn btn-ghost" onClick={() => onClose("btw")}>Done</button>
          </div>
        </div>
      </div>

      <div id="rollbackModal" class={`modal-overlay${rollbackOpen ? "" : " hidden"}`} role="dialog" aria-modal="true" aria-labelledby="rollbackModalTitle">
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="rollbackModalTitle">⏪ Rewind Conversation Turns</h3>
            <button id="btnCloseRollback" type="button" class="btn-close" aria-label="Close rollback dialog" onClick={() => onClose("rollback")}>&times;</button>
          </div>
          <div class="modal-body">
            <p class="session-action-intro">This removes messages from the current conversation. Ask for confirmation before proceeding.</p>
            <div class="form-group">
              <label for="rollbackTurnCount">Turns to remove</label>
              <input type="number" id="rollbackTurnCount" class="form-control" value={turns}
                onInput={(e) => setTurns((e.currentTarget as HTMLInputElement).value)} />
            </div>
            {rollbackStatus && <div id="rollbackStatusBox" class="session-action-result" role="status">{rollbackStatus}</div>}
          </div>
          <div class="modal-actions">
            <button id="btnConfirmRollback" type="button" class="btn btn-danger" disabled={rollbackBusy} onClick={() => void handleRollback()}>
              {rollbackBusy ? "Rewinding..." : "Rewind Conversation"}
            </button>
            <button id="btnCloseRollbackAction" type="button" class="btn btn-ghost" onClick={() => onClose("rollback")}>Cancel</button>
          </div>
        </div>
      </div>

      <div id="compactModal" class={`modal-overlay${compactOpen ? "" : " hidden"}`} role="dialog" aria-modal="true" aria-labelledby="compactModalTitle">
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="compactModalTitle">🗜️ Auto-Compaction</h3>
            <button id="btnCloseCompact" type="button" class="btn-close" aria-label="Close compact dialog" onClick={() => onClose("compact")}>&times;</button>
          </div>
          <div class="modal-body">
            <p class="session-action-intro">Condense older turns to free context space while keeping the most recent ones.</p>
            <div class="form-group">
              <label for="compactKeepTurns">Recent turns to keep</label>
              <input type="number" id="compactKeepTurns" class="form-control" value={keep}
                onInput={(e) => setKeep((e.currentTarget as HTMLInputElement).value)} />
            </div>
            {compactStatus && <div id="compactResultBox" class="session-action-result" role="status">{compactStatus}</div>}
          </div>
          <div class="modal-actions">
            <button id="btnConfirmCompact" type="button" class="btn btn-primary" disabled={compactBusy} onClick={() => void handleCompact()}>
              {compactBusy ? "Compacting..." : "Run Auto-Compaction"}
            </button>
            <button id="btnCloseCompactAction" type="button" class="btn btn-ghost" onClick={() => onClose("compact")}>Cancel</button>
          </div>
        </div>
      </div>
    </>
  );
}
