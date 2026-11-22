import test from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, "../../renderer/index.html");

test("settings dialog - index.html has 3-way mode selector and no legacy checkbox", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  assert.ok(html.includes('id="settingApprovalMode"'), "has settingApprovalMode select dropdown");
  assert.ok(html.includes('<option value="ask">Ask every time</option>'), "has ask option");
  assert.ok(
    html.includes('<option value="auto_edit">Auto-edit files &amp; sandboxed shell</option>'),
    "has auto_edit option"
  );
  assert.ok(
    html.includes('<option value="auto">Auto-approve all actions with network</option>'),
    "has auto option"
  );
  assert.ok(!html.includes('id="settingAutoApprove"'), "legacy settingAutoApprove checkbox is removed");
});

test("settings dialog - handles 3 approval modes and backwards compatibility", () => {
  // Logic mirror of app.js settings dialog bind and save
  function resolveMode(s: { approvalMode?: unknown; autoApprove?: boolean }): string {
    return (s.approvalMode === "auto_edit" || s.approvalMode === "auto" || s.approvalMode === "ask")
      ? s.approvalMode
      : (s.autoApprove ? "auto" : "ask");
  }

  function formatBadge(mode: string): { icon: string; label: string; badgeCls: string; composerText: string } {
    if (mode === "auto") {
      return { icon: "spark", label: "Auto-Approve", badgeCls: "badge badge-warning", composerText: "Auto-Approve" };
    }
    if (mode === "auto_edit") {
      return { icon: "code", label: "Auto-Edit", badgeCls: "badge badge-info", composerText: "Auto-Edit" };
    }
    return { icon: "shield", label: "Safe Mode", badgeCls: "badge badge-success", composerText: "Safe Mode" };
  }

  function cycleMode(currentMode: string): string {
    return currentMode === "ask" ? "auto_edit" : (currentMode === "auto_edit" ? "auto" : "ask");
  }

  function createSavePayload(selectorValue: string): { approvalMode: string; autoApprove: boolean } {
    return {
      approvalMode: selectorValue,
      autoApprove: selectorValue === "auto",
    };
  }

  // 1. Ask mode (default)
  assert.strictEqual(resolveMode({}), "ask");
  assert.strictEqual(resolveMode({ approvalMode: "ask" }), "ask");
  assert.deepStrictEqual(formatBadge("ask"), {
    icon: "shield",
    label: "Safe Mode",
    badgeCls: "badge badge-success",
    composerText: "Safe Mode",
  });
  assert.deepStrictEqual(createSavePayload("ask"), {
    approvalMode: "ask",
    autoApprove: false,
  });

  // 2. Auto-edit mode
  assert.strictEqual(resolveMode({ approvalMode: "auto_edit" }), "auto_edit");
  assert.deepStrictEqual(formatBadge("auto_edit"), {
    icon: "code",
    label: "Auto-Edit",
    badgeCls: "badge badge-info",
    composerText: "Auto-Edit",
  });
  assert.deepStrictEqual(createSavePayload("auto_edit"), {
    approvalMode: "auto_edit",
    autoApprove: false,
  });

  // 3. Auto mode
  assert.strictEqual(resolveMode({ approvalMode: "auto" }), "auto");
  assert.deepStrictEqual(formatBadge("auto"), {
    icon: "spark",
    label: "Auto-Approve",
    badgeCls: "badge badge-warning",
    composerText: "Auto-Approve",
  });
  assert.deepStrictEqual(createSavePayload("auto"), {
    approvalMode: "auto",
    autoApprove: true,
  });

  // 4. Backwards compatibility for legacy autoApprove boolean
  assert.strictEqual(resolveMode({ autoApprove: true }), "auto");
  assert.strictEqual(resolveMode({ autoApprove: false }), "ask");

  // 5. Cycling button transitions
  assert.strictEqual(cycleMode("ask"), "auto_edit");
  assert.strictEqual(cycleMode("auto_edit"), "auto");
  assert.strictEqual(cycleMode("auto"), "ask");
});
