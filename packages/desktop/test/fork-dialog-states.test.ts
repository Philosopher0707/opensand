import test from "node:test";
import assert from "node:assert";
import { h, render, options } from "preact";
import { ForkDialog } from "../src/shell/fork-dialog-component.js";
import { classifyForkError } from "../src/shell/mission-fork-model.js";
import type { PreviewRestoreResult } from "../src/shell/mission-restore-model.js";

// Minimal DOM implementation for headless Preact component testing in Node.js
class FakeNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  _attributes: Record<string, string> = {};
  _listeners: Record<string, (e: any) => void> = {};
  onclick: any = null;
  onkeydown: any = null;
  value: string = "";

  constructor(nodeType: number, nodeName: string) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    return new Proxy(this, {
      has(target, prop) {
        if (typeof prop === "string" && prop.startsWith("on")) return true;
        return prop in target;
      },
    });
  }

  get className(): string {
    return this._attributes["class"] || "";
  }
  set className(v: string) {
    this._attributes["class"] = v;
  }

  get data(): string {
    return this.nodeValue || "";
  }
  set data(v: string) {
    this.nodeValue = v;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (!ref) return this.appendChild(child);
    child.parentNode = this;
    const idx = this.childNodes.indexOf(ref);
    if (idx >= 0) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(k: string, v: any) {
    this._attributes[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this._attributes[k] ?? null;
  }
  removeAttribute(k: string) {
    delete this._attributes[k];
  }

  addEventListener(type: string, fn: (e: any) => void) {
    this._listeners[type] = fn;
  }
  removeEventListener(type: string, _fn: any) {
    delete this._listeners[type];
  }
  dispatchEvent(event: { type: string; key?: string; defaultPrevented?: boolean; preventDefault?: () => void; target?: any }): boolean {
    if (!event.preventDefault) {
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
    }
    if (!event.target) {
      event.target = this;
    }
    this._listeners[event.type.toLowerCase()]?.call(this, event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: "click" });
  }

  focus() {}

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.childNodes.map((c) => c.textContent).join("");
  }

  querySelector(sel: string): FakeNode | null {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel: string): FakeNode[] {
    const results: FakeNode[] = [];
    const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="?([^"]*)"?)?\]$/);
    const check = (node: FakeNode) => {
      if (node.nodeType === 1) {
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          const classes = (node.getAttribute("class") || "").split(/\s+/);
          if (classes.includes(cls)) results.push(node);
        } else if (sel.startsWith("#") && node.getAttribute("id") === sel.slice(1)) {
          results.push(node);
        } else if (attrMatch) {
          const [, attrName, attrVal] = attrMatch;
          if (attrVal === undefined ? node.getAttribute(attrName) !== null : node.getAttribute(attrName) === attrVal) {
            results.push(node);
          }
        } else if (node.nodeName.toLowerCase() === sel.toLowerCase()) {
          results.push(node);
        }
      }
      for (const child of node.childNodes) check(child);
    };
    for (const child of this.childNodes) check(child);
    return results;
  }
}

const STEP = { kindLabel: "Work", summary: "Edited logic.ts (1.8s)", seq: 1 };

test("ForkDialog states suite", async (t) => {
  options.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const prevDoc = (globalThis as any).document;
  (globalThis as any).document = {
    createElement(tag: string) {
      return new FakeNode(1, tag.toUpperCase());
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeNode(1, tag.toUpperCase());
    },
    createTextNode(text: string) {
      const n = new FakeNode(3, "#text");
      n.nodeValue = text;
      return n;
    },
    getElementById(_id: string) {
      return null;
    },
    activeElement: null,
  };

  try {
    await t.test("dialog state: preview lists rendered with deleted first, instruction textarea, and buttons", async () => {
      const container = new FakeNode(1, "DIV");
      const preview: PreviewRestoreResult = {
        success: true,
        missionId: "m-test",
        targetRef: "refs/opensand/missions/m-test/s-1",
        deletedFiles: ["obsolete_log.txt"],
        overwrittenFiles: ["config.json"],
        restoredFiles: ["config.json", "created_by_step1.ts"],
      };

      render(
        h(ForkDialog, {
          step: STEP,
          preview,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      // Dialog container exists
      const dialog = container.querySelector(".fork-dialog");
      assert.ok(dialog, "fork-dialog element must be rendered");
      assert.strictEqual(dialog.getAttribute("role"), "alertdialog");

      // Verify sections and ordering: deleted section must appear before overwritten and recreated
      const allSections = container.querySelectorAll(".restore-section");
      assert.strictEqual(allSections.length, 3, "three sections rendered for deleted, overwritten, recreated");

      // First section is DELETED
      assert.ok(
        (allSections[0].getAttribute("class") || "").includes("restore-section-deleted"),
        "deleted section must be displayed first in warning style"
      );
      assert.strictEqual(allSections[0].querySelector(".badge-deleted")?.textContent, "1");
      assert.ok(allSections[0].textContent.includes("1 file deleted"));
      assert.ok(allSections[0].textContent.includes("obsolete_log.txt"));

      // Second section is OVERWRITTEN
      assert.ok(
        (allSections[1].getAttribute("class") || "").includes("restore-section-overwritten"),
        "overwritten section must display changed back files"
      );
      assert.strictEqual(allSections[1].querySelector(".badge-overwritten")?.textContent, "1");
      assert.ok(allSections[1].textContent.includes("1 file changed back"));

      // Third section is RECREATED
      assert.ok(
        (allSections[2].getAttribute("class") || "").includes("restore-section-recreated"),
        "recreated section must display recreated files"
      );
      assert.strictEqual(allSections[2].querySelector(".badge-recreated")?.textContent, "1");
      assert.ok(allSections[2].textContent.includes("1 file recreated"));

      // Instruction textarea
      const textarea = container.querySelector(".fork-instruction-input");
      assert.ok(textarea, "fork-instruction-input textarea must be rendered");

      // Buttons: Cancel and Confirm fork
      const cancelBtn = container.querySelector(".btn-fork-cancel");
      const confirmBtn = container.querySelector(".btn-fork-confirm");
      assert.ok(cancelBtn, "Cancel button must be rendered");
      assert.ok(confirmBtn, "Confirm fork button must be rendered");
      assert.strictEqual(confirmBtn.textContent, "Confirm fork");
    });

    await t.test("dialog state: instruction passed through on confirm", async () => {
      const container = new FakeNode(1, "DIV");
      let confirmedOptions: any = null;

      const preview: PreviewRestoreResult = {
        success: true,
        missionId: "m-test",
        targetRef: "refs/opensand/missions/m-test/s-1",
        deletedFiles: ["a.txt"],
        overwrittenFiles: [],
        restoredFiles: [],
      };

      render(
        h(ForkDialog, {
          step: STEP,
          preview,
          onConfirm: (opts) => {
            confirmedOptions = opts;
          },
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      const textarea = container.querySelector(".fork-instruction-input");
      assert.ok(textarea);
      textarea.value = "refactor authentication flow";
      textarea.dispatchEvent({ type: "input", target: { value: "refactor authentication flow" } });
      await new Promise((r) => setTimeout(r, 20));

      const confirmBtn = container.querySelector(".btn-fork-confirm");
      assert.ok(confirmBtn);
      confirmBtn.click();

      assert.deepStrictEqual(confirmedOptions, { newInstruction: "refactor authentication flow" });
    });

    await t.test("dialog state: blank instruction leaves newInstruction undefined", async () => {
      const container = new FakeNode(1, "DIV");
      let confirmedOptions: any = null;

      const preview: PreviewRestoreResult = {
        success: true,
        missionId: "m-test",
        targetRef: "refs/opensand/missions/m-test/s-1",
        deletedFiles: ["a.txt"],
        overwrittenFiles: [],
        restoredFiles: [],
      };

      render(
        h(ForkDialog, {
          step: STEP,
          preview,
          onConfirm: (opts) => {
            confirmedOptions = opts;
          },
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      const textarea = container.querySelector(".fork-instruction-input");
      assert.ok(textarea);
      textarea.value = "   ";
      textarea.dispatchEvent({ type: "input", target: { value: "   " } });
      await new Promise((r) => setTimeout(r, 20));

      const confirmBtn = container.querySelector(".btn-fork-confirm");
      assert.ok(confirmBtn);
      confirmBtn.click();

      assert.deepStrictEqual(confirmedOptions, { newInstruction: undefined });
    });

    await t.test("dialog state: cancel calls nothing (calls onCancel, never onConfirm)", async () => {
      const container = new FakeNode(1, "DIV");
      let cancelCount = 0;
      let confirmCount = 0;

      const preview: PreviewRestoreResult = {
        success: true,
        missionId: "m-test",
        targetRef: "refs/opensand/missions/m-test/s-1",
        deletedFiles: ["temp.txt"],
        overwrittenFiles: [],
        restoredFiles: [],
      };

      render(
        h(ForkDialog, {
          step: STEP,
          preview,
          onConfirm: () => {
            confirmCount++;
          },
          onCancel: () => {
            cancelCount++;
          },
        }),
        container as unknown as Element
      );

      const cancelBtn = container.querySelector(".btn-fork-cancel");
      assert.ok(cancelBtn);
      cancelBtn.click();

      assert.strictEqual(cancelCount, 1, "onCancel must be called once");
      assert.strictEqual(confirmCount, 0, "onConfirm must not be called when canceling");
    });

    await t.test("dialog state: zero changes says Nothing to restore and omits Confirm button", async () => {
      const container = new FakeNode(1, "DIV");
      const zeroPreview: PreviewRestoreResult = {
        success: true,
        missionId: "m-test",
        targetRef: "refs/opensand/missions/m-test/s-1",
        deletedFiles: [],
        overwrittenFiles: [],
        restoredFiles: [],
      };

      render(
        h(ForkDialog, {
          step: STEP,
          preview: zeroPreview,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      const emptyEl = container.querySelector(".restore-empty");
      assert.ok(emptyEl, "restore-empty must be rendered");
      assert.strictEqual(emptyEl.textContent, "Nothing to restore");
      assert.strictEqual(container.querySelector(".btn-fork-confirm"), null, "Confirm button must not be present when 0 changes");
    });

    await t.test("error state: -32600 InvalidRequest (untrusted or actively running)", async () => {
      const errUntrusted = classifyForkError({ code: -32600, message: "Workspace folder is untrusted" });
      assert.strictEqual(errUntrusted.kind, "untrusted");
      assert.ok(errUntrusted.message.includes("not trusted yet"));

      const errRunning = classifyForkError({ code: -32600, message: "Cannot fork workspace while mission m-1 is actively running." });
      assert.strictEqual(errRunning.kind, "running");
      assert.ok(errRunning.message.includes("still running"));

      const container = new FakeNode(1, "DIV");
      render(
        h(ForkDialog, {
          step: STEP,
          error: errUntrusted.message,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      const errorEl = container.querySelector(".fork-error");
      assert.ok(errorEl);
      assert.strictEqual(errorEl.getAttribute("role"), "alert");
      assert.ok(errorEl.textContent.includes("not trusted yet"));
      assert.strictEqual(container.querySelector(".btn-fork-confirm"), null);
    });

    await t.test("error state: -32602 InvalidParams (ref does not belong or missing id)", async () => {
      const errParams = classifyForkError({ code: -32602, message: "Ref does not belong to mission m-1" });
      assert.strictEqual(errParams.kind, "invalid_params");
      assert.ok(errParams.message.includes("does not belong"));

      const container = new FakeNode(1, "DIV");
      render(
        h(ForkDialog, {
          step: STEP,
          error: errParams.message,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      const errorEl = container.querySelector(".fork-error");
      assert.ok(errorEl);
      assert.ok(errorEl.textContent.includes("does not belong"));
      assert.strictEqual(container.querySelector(".btn-fork-confirm"), null);
    });

    await t.test("error state: -32603 InternalError with recovery hint", async () => {
      const recoveryCmd = "REC_IDX=$(mktemp -t opensand-rec-XXXXXX) && git checkout-index --all";
      const errInternal = classifyForkError({
        code: -32603,
        message: "Restore failed midway: checkout failed",
        data: {
          preRestoreSnapshot: "refs/opensand/missions/m-1/s-pre-restore-12345",
          manualRecoveryCommand: recoveryCmd,
        },
      });

      assert.strictEqual(errInternal.kind, "internal_error");
      assert.ok(errInternal.recoveryHint?.includes(recoveryCmd));
      assert.strictEqual(errInternal.manualRecoveryCommand, recoveryCmd);

      const container = new FakeNode(1, "DIV");
      render(
        h(ForkDialog, {
          step: STEP,
          error: errInternal.message,
          recoveryHint: errInternal.recoveryHint,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      const errorEl = container.querySelector(".fork-error");
      assert.ok(errorEl);
      assert.ok(errorEl.textContent.includes("Restore failed midway"));

      const hintEl = container.querySelector(".fork-recovery-hint");
      assert.ok(hintEl, "fork-recovery-hint must be rendered");
      assert.ok(hintEl.textContent.includes("REC_IDX="));
      assert.strictEqual(container.querySelector(".btn-fork-confirm"), null);
    });
  } finally {
    (globalThis as any).document = prevDoc;
  }
});
