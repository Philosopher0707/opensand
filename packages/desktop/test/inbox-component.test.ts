import test from "node:test";
import assert from "node:assert";
import { h, render, options } from "preact";
import { Inbox, InboxBadge, type ShellDataWithApprovals } from "../src/shell/inbox-component.js";
import type { ToolApprovalRequest } from "../src/shell/inbox-model.js";

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
    child.parentNode = this;
    if (!ref) {
      this.childNodes.push(child);
      return child;
    }
    const idx = this.childNodes.indexOf(ref);
    if (idx >= 0) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: unknown): void {
    this._attributes[name] = String(value);
  }

  removeAttribute(name: string): void {
    delete this._attributes[name];
  }

  getAttribute(name: string): string | null {
    return this._attributes[name] ?? null;
  }

  addEventListener(type: string, fn: (e: any) => void): void {
    this._listeners[type.toLowerCase()] = fn;
  }

  removeEventListener(type: string): void {
    delete this._listeners[type.toLowerCase()];
  }

  dispatchEvent(event: { type: string; key?: string; defaultPrevented?: boolean; preventDefault?: () => void; stopPropagation?: () => void }): boolean {
    if (!event.preventDefault) {
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
    }
    // This fake does not bubble, so stopping propagation is a no-op here.
    if (!event.stopPropagation) event.stopPropagation = () => {};
    this._listeners[event.type.toLowerCase()]?.call(this, event);
    return !event.defaultPrevented;
  }

  click(): void {
    this.dispatchEvent({ type: "click" });
  }

  focus(): void {
    this.dispatchEvent({ type: "focus" });
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.childNodes.map((c) => c.textContent).join("");
  }

  querySelector(sel: string): FakeNode | null {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel: string): FakeNode[] {
    const results: FakeNode[] = [];
    const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:=["']?(.*?)["']?)?\]$/);
    const check = (node: FakeNode) => {
      if (node.nodeType === 1) {
        if (sel.startsWith(".") && (node.getAttribute("class") || "").split(/\s+/).includes(sel.slice(1))) {
          results.push(node);
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

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeMockData(approvalsPromise: () => Promise<ToolApprovalRequest[]>): ShellDataWithApprovals {
  return {
    listPendingApprovals: approvalsPromise,
  };
}

const itemA: ToolApprovalRequest = {
  approvalId: "appr-1",
  toolName: "exec_command",
  args: { cmd: "pnpm test" },
  reason: "Run test suite",
  timestamp: 1700000000000 - 60_000 * 2, // 2 minutes ago
  epoch: 1,
};

const itemB: ToolApprovalRequest = {
  approvalId: "appr-2",
  toolName: "write_file",
  args: { path: "src/config.json", content: "{}" },
  timestamp: 1700000000000 - 60_000 * 10, // 10 minutes ago
  epoch: 1,
};

test("Inbox Component suite", async (t) => {
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
  };

  try {
    await t.test("badge count renders correctly and reflects pending items", async () => {
      const container = new FakeNode(1, "DIV");
      // 0 count
      render(h(InboxBadge, { pendingCount: 0 }), container as unknown as Element);
      const badge0 = container.querySelector(".inbox-badge");
      assert.ok(badge0);
      assert.strictEqual(container.querySelector(".inbox-badge-count")?.textContent, "0");
      assert.strictEqual(badge0.getAttribute("aria-label"), "NEEDS YOU: 0 pending approvals");
      assert.strictEqual(
        (container.querySelector(".inbox-badge-count")?.getAttribute("class") || "").includes("has-pending"),
        false
      );

      // 2 count
      render(h(InboxBadge, { pendingCount: 2 }), container as unknown as Element);
      const badge2 = container.querySelector(".inbox-badge");
      assert.ok(badge2);
      assert.strictEqual(container.querySelector(".inbox-badge-count")?.textContent, "2");
      assert.strictEqual(badge2.getAttribute("aria-label"), "NEEDS YOU: 2 pending approvals");
      assert.strictEqual(
        (container.querySelector(".inbox-badge-count")?.getAttribute("class") || "").includes("has-pending"),
        true
      );
    });

    await t.test("empty state displays 'Nothing needs you' when no approvals pending", async () => {
      const container = new FakeNode(1, "DIV");
      const data = makeMockData(async () => []);
      render(h(Inbox, { data, now: () => 1700000000000 }), container as unknown as Element);

      await waitFor(() => Boolean(container.querySelector(".inbox-empty")));
      const emptyTitle = container.querySelector(".inbox-empty-title")?.textContent;
      assert.strictEqual(emptyTitle, "Nothing needs you");
      assert.strictEqual(container.querySelector(".inbox-badge-count")?.textContent, "0");
      assert.strictEqual(container.querySelectorAll(".inbox-item").length, 0);
    });

    await t.test("error state shows 'Couldn't load approvals' with Retry button", async () => {
      const container = new FakeNode(1, "DIV");
      let fail = true;
      const data = makeMockData(async () => {
        if (fail) throw new Error("Network error");
        return [itemA];
      });

      render(h(Inbox, { data, now: () => 1700000000000 }), container as unknown as Element);

      await waitFor(() => Boolean(container.querySelector(".inbox-error")));
      const errText = container.querySelector(".inbox-error")?.textContent || "";
      assert.match(errText.toLowerCase(), /couldn't load approvals/);

      const retryBtn = container.querySelector(".btn-retry");
      assert.ok(retryBtn);

      // Click retry with failure resolved
      fail = false;
      retryBtn.click();

      await waitFor(() => container.querySelectorAll(".inbox-item").length === 1);
      assert.strictEqual(container.querySelector(".inbox-item-asking")?.textContent, "exec_command");
    });

    await t.test("list of 2 items shows asking, wants, time and handles click/keyboard", async () => {
      const container = new FakeNode(1, "DIV");
      const data = makeMockData(async () => [itemA, itemB]);
      let selectedReq: ToolApprovalRequest | null = null;

      render(
        h(Inbox, {
          data,
          now: () => 1700000000000,
          onSelectApproval: (r: ToolApprovalRequest) => {
            selectedReq = r;
          },
        }),
        container as unknown as Element
      );

      await waitFor(() => container.querySelectorAll(".inbox-item").length === 2);

      // Badge count
      assert.strictEqual(container.querySelector(".inbox-badge-count")?.textContent, "2");

      const items = container.querySelectorAll(".inbox-item");
      assert.strictEqual(items.length, 2);

      // First item (itemA: pnpm test, 2 minutes ago - newest first)
      const askA = items[0].querySelector(".inbox-item-asking")?.textContent;
      const wantsA = items[0].querySelector(".inbox-item-wants")?.textContent;
      const timeA = items[0].querySelector(".inbox-item-time")?.textContent;
      assert.strictEqual(askA, "exec_command");
      assert.strictEqual(wantsA, "pnpm test");
      assert.strictEqual(timeA, "2 minutes ago");

      // Second item (itemB: src/config.json, 10 minutes ago)
      const askB = items[1].querySelector(".inbox-item-asking")?.textContent;
      const wantsB = items[1].querySelector(".inbox-item-wants")?.textContent;
      const timeB = items[1].querySelector(".inbox-item-time")?.textContent;
      assert.strictEqual(askB, "write_file");
      assert.strictEqual(wantsB, "src/config.json");
      assert.strictEqual(timeB, "10 minutes ago");

      // Click to expand details
      assert.strictEqual(items[0].querySelector(".inbox-item-details"), null);
      items[0].click();
      await waitFor(() => Boolean(items[0].querySelector(".inbox-item-details")));

      const details = items[0].querySelector(".inbox-item-details")!;
      assert.match(details.textContent, /Tool:.*exec_command/);
      assert.match(details.textContent, /Reason:.*Run test suite/);
      assert.match(details.textContent, /pnpm test/);
      assert.strictEqual((selectedReq as ToolApprovalRequest | null)?.approvalId, "appr-1");

      // Keyboard navigation: Enter on listbox toggles selection
      const listbox = container.querySelector('[role="listbox"]')!;
      assert.ok(listbox);
      listbox.dispatchEvent({ type: "keydown", key: "ArrowDown" });
      await new Promise((r) => setTimeout(r, 10));
      listbox.dispatchEvent({ type: "keydown", key: "Enter" });

      await waitFor(() => Boolean(container.querySelectorAll(".inbox-item")[1]?.querySelector(".inbox-item-details")));
      assert.strictEqual((selectedReq as ToolApprovalRequest | null)?.approvalId, "appr-2");
    });

    await t.test("expanded row answers through approveTool with the request epoch, then reloads the list", async () => {
      const container = new FakeNode(1, "DIV");
      const calls: Array<{ id: string; decision: unknown }> = [];
      let pending = [itemA, itemB];
      const data: ShellDataWithApprovals = {
        listPendingApprovals: async () => pending,
        approveTool: async (id, decision) => {
          calls.push({ id, decision });
          pending = pending.filter((r) => r.approvalId !== id);
          return { success: true };
        },
      };

      render(h(Inbox, { data, now: () => 1700000000000 }), container as unknown as Element);
      await waitFor(() => container.querySelectorAll(".inbox-item").length === 2);

      container.querySelectorAll(".inbox-item")[0].click();
      await waitFor(() => Boolean(container.querySelector(".inbox-decision-row")));

      const labels = [...container.querySelector(".inbox-decision-row")!.querySelectorAll("button")].map((b) => b.textContent);
      assert.deepStrictEqual(labels, ["Approve Once", "Always Allow", "Reject"]);

      const approve = [...container.querySelector(".inbox-decision-row")!.querySelectorAll("button")].find((b) => b.textContent === "Approve Once");
      assert.ok(approve);
      approve.click();

      await waitFor(() => container.querySelectorAll(".inbox-item").length === 1);
      assert.deepStrictEqual(calls, [{ id: "appr-1", decision: { action: "approve_once", epoch: 1 } }]);
      assert.strictEqual(container.querySelector(".inbox-item-asking")?.textContent, "write_file");
    });

    await t.test("a refused answer shows an alert and keeps the request listed", async () => {
      const container = new FakeNode(1, "DIV");
      const data: ShellDataWithApprovals = {
        listPendingApprovals: async () => [itemA],
        approveTool: async () => ({ success: false }),
      };

      render(h(Inbox, { data, now: () => 1700000000000 }), container as unknown as Element);
      await waitFor(() => container.querySelectorAll(".inbox-item").length === 1);
      container.querySelectorAll(".inbox-item")[0].click();
      await waitFor(() => Boolean(container.querySelector(".inbox-decision-row")));

      const reject = [...container.querySelector(".inbox-decision-row")!.querySelectorAll("button")].find((b) => b.textContent === "Reject");
      assert.ok(reject);
      reject.click();

      await waitFor(() => Boolean(container.querySelector('[role="alert"]')));
      assert.match(container.querySelector('[role="alert"]')!.textContent, /no longer pending/);
      assert.strictEqual(container.querySelectorAll(".inbox-item").length, 1);
    });

    await t.test("without approveTool the expanded row has no decision buttons", async () => {
      const container = new FakeNode(1, "DIV");
      render(h(Inbox, { data: makeMockData(async () => [itemA]), now: () => 1700000000000 }), container as unknown as Element);
      await waitFor(() => container.querySelectorAll(".inbox-item").length === 1);
      container.querySelectorAll(".inbox-item")[0].click();
      await waitFor(() => Boolean(container.querySelector(".inbox-item-details")));
      assert.strictEqual(container.querySelector(".inbox-decision-row"), null);
    });

    await t.test("stale epoch error produces specific stale approval alert", async () => {
      const container = new FakeNode(1, "DIV");
      const data: ShellDataWithApprovals = {
        listPendingApprovals: async () => [itemA],
        approveTool: async () => {
          throw new Error("Stale epoch: request made at epoch 1, current is 2");
        },
      };

      render(h(Inbox, { data, now: () => 1700000000000 }), container as unknown as Element);
      await waitFor(() => container.querySelectorAll(".inbox-item").length === 1);
      container.querySelectorAll(".inbox-item")[0].click();
      await waitFor(() => Boolean(container.querySelector(".inbox-decision-row")));

      const approve = [...container.querySelector(".inbox-decision-row")!.querySelectorAll("button")].find((b) => b.textContent === "Approve Once");
      assert.ok(approve);
      approve.click();

      await waitFor(() => Boolean(container.querySelector("[role=\"alert\"]")));
      const alertText = container.querySelector("[role=\"alert\"]")!.textContent;
      assert.match(alertText, /Stale approval: the system epoch changed/);
    });

    await t.test("ApprovalDecisionButtons with idPrefix='main' renders legacy action button IDs", async () => {
      const container = new FakeNode(1, "DIV");
      const calls: Array<{ id: string; decision: unknown }> = [];
      const data: ShellDataWithApprovals = {
        listPendingApprovals: async () => [itemA],
        approveTool: async (id, decision) => {
          calls.push({ id, decision });
          return { success: true };
        },
      };

      // Import ApprovalDecisionButtons
      const { ApprovalDecisionButtons } = await import("../src/shell/inbox-component.js");
      render(h(ApprovalDecisionButtons, { data, req: itemA, idPrefix: "main" }), container as unknown as Element);

      await waitFor(() => Boolean(container.querySelector(".inbox-decision-row")));

      const btnApprove = container.querySelector("#btnApproveOnce");
      const btnAlways = container.querySelector("#btnAlwaysAllow");
      const btnReject = container.querySelector("#btnRejectTool");

      assert.ok(btnApprove, "has #btnApproveOnce");
      assert.ok(btnAlways, "has #btnAlwaysAllow");
      assert.ok(btnReject, "has #btnRejectTool");

      assert.strictEqual(btnApprove.getAttribute("data-action"), "approve_once");
      assert.strictEqual(btnAlways.getAttribute("data-action"), "always_allow");
      assert.strictEqual(btnReject.getAttribute("data-action"), "reject");

      btnAlways.click();
      await waitFor(() => calls.length === 1);
      assert.deepStrictEqual(calls[0], { id: "appr-1", decision: { action: "always_allow", epoch: 1 } });
    });
  } finally {
    (globalThis as any).document = prevDoc;
  }
});
