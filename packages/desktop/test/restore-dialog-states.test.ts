import test from "node:test";
import assert from "node:assert";
import { h, render, options } from "preact";
import { RestoreDialog } from "../src/shell/restore-dialog-component.js";
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
  dispatchEvent(event: { type: string; key?: string; defaultPrevented?: boolean; preventDefault?: () => void }): boolean {
    if (!event.preventDefault) {
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
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

const STEP = { kindLabel: "Work", summary: "Edited code.ts (2.5s)" };

test("RestoreDialog states suite", async (t) => {
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
    await t.test("dialog state: lists renders counts, file lists (deleted first in warning style), and Confirm + Cancel", async () => {
      const container = new FakeNode(1, "DIV");
      const preview: PreviewRestoreResult = {
        success: true,
        missionId: "m-test",
        targetRef: "refs/opensand/missions/m-test/s-1",
        deletedFiles: ["temp_to_delete.log"],
        overwrittenFiles: ["config_to_overwrite.json"],
        restoredFiles: ["config_to_overwrite.json", "recreated_file.txt"],
      };

      render(
        h(RestoreDialog, {
          step: STEP,
          preview,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      // Dialog container exists
      const dialog = container.querySelector(".restore-dialog");
      assert.ok(dialog, "dialog element must be rendered");
      assert.strictEqual(dialog.getAttribute("role"), "alertdialog");

      // Verify sections and ordering: deleted section must appear before overwritten and recreated
      const allSections = container.querySelectorAll(".restore-section");
      assert.strictEqual(allSections.length, 3, "three sections rendered for deleted, overwritten, recreated");

      // First section is DELETED (shown first in warning style)
      assert.ok(
        (allSections[0].getAttribute("class") || "").includes("restore-section-deleted"),
        "deleted section must be displayed first in warning style"
      );
      assert.strictEqual(allSections[0].querySelector(".badge-deleted")?.textContent, "1");
      assert.ok(allSections[0].textContent.includes("1 file deleted"));
      assert.ok(allSections[0].textContent.includes("temp_to_delete.log"));

      // Second section is OVERWRITTEN (changed back)
      assert.ok(
        (allSections[1].getAttribute("class") || "").includes("restore-section-overwritten"),
        "overwritten section must display changed back files"
      );
      assert.strictEqual(allSections[1].querySelector(".badge-overwritten")?.textContent, "1");
      assert.ok(allSections[1].textContent.includes("1 file changed back"));
      assert.ok(allSections[1].textContent.includes("config_to_overwrite.json"));

      // Third section is RECREATED
      assert.ok(
        (allSections[2].getAttribute("class") || "").includes("restore-section-recreated"),
        "recreated section must display recreated files"
      );
      assert.strictEqual(allSections[2].querySelector(".badge-recreated")?.textContent, "1");
      assert.ok(allSections[2].textContent.includes("1 file recreated"));
      assert.ok(allSections[2].textContent.includes("recreated_file.txt"));

      // Buttons: both Cancel and Confirm restore must be present
      const cancelBtn = container.querySelector(".btn-restore-cancel");
      const confirmBtn = container.querySelector(".btn-restore-confirm");
      assert.ok(cancelBtn, "Cancel button must be rendered");
      assert.ok(confirmBtn, "Confirm restore button must be rendered");
      assert.strictEqual(confirmBtn.textContent, "Confirm restore");
    });

    await t.test("dialog state: zero changes says 'Nothing to restore' and shows no Confirm button", async () => {
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
        h(RestoreDialog, {
          step: STEP,
          preview: zeroPreview,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      // Must show "Nothing to restore"
      const emptyEl = container.querySelector(".restore-empty");
      assert.ok(emptyEl, ".restore-empty must be rendered");
      assert.strictEqual(emptyEl.textContent, "Nothing to restore");

      // No file sections
      assert.strictEqual(container.querySelectorAll(".restore-section").length, 0);

      // Cancel button present, Confirm button MUST NOT be present
      assert.ok(container.querySelector(".btn-restore-cancel"), "Cancel button must be present");
      assert.strictEqual(container.querySelector(".btn-restore-confirm"), null, "Confirm button must not be present when 0 changes");
    });

    await t.test("dialog state: error shows the error message and no Confirm button", async () => {
      const container = new FakeNode(1, "DIV");
      const errorMessage = "This folder is not trusted yet. Trust the folder, then try again. No files were changed.";

      render(
        h(RestoreDialog, {
          step: STEP,
          error: errorMessage,
          onConfirm: () => {},
          onCancel: () => {},
        }),
        container as unknown as Element
      );

      // Must show error element with alert role
      const errorEl = container.querySelector(".restore-error");
      assert.ok(errorEl, ".restore-error must be rendered");
      assert.strictEqual(errorEl.getAttribute("role"), "alert");
      assert.strictEqual(errorEl.textContent, errorMessage);

      // No file sections
      assert.strictEqual(container.querySelectorAll(".restore-section").length, 0);

      // Cancel button present, Confirm button MUST NOT be present
      assert.ok(container.querySelector(".btn-restore-cancel"), "Cancel button must be present");
      assert.strictEqual(container.querySelector(".btn-restore-confirm"), null, "Confirm button must not be present on error");
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
        h(RestoreDialog, {
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

      const cancelBtn = container.querySelector(".btn-restore-cancel");
      assert.ok(cancelBtn);
      cancelBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(cancelCount, 1, "onCancel must be called once");
      assert.strictEqual(confirmCount, 0, "onConfirm must not be called when canceling");
    });

    await t.test("dialog state: confirm calls restore once", async () => {
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
        h(RestoreDialog, {
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

      const confirmBtn = container.querySelector(".btn-restore-confirm");
      assert.ok(confirmBtn);
      confirmBtn.click();

      assert.strictEqual(confirmCount, 1, "onConfirm must be called once");
      assert.strictEqual(cancelCount, 0, "onCancel must not be called when confirming");
    });
  } finally {
    (globalThis as any).document = prevDoc;
  }
});
