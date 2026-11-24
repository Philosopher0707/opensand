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

test("settings dialog - chat engine selector has both choices and a plain reason hint", () => {
  const html = fs.readFileSync(indexPath, "utf8");
  assert.ok(html.includes('id="settingEngine"'), "has a chat engine select");
  assert.ok(html.includes('<option value="opensand">OpenSand (API key)</option>'), "default engine option");
  assert.ok(html.includes('<option value="claude" data-label="Claude Code">Claude Code (your account)</option>'), "Claude Code option");
  assert.ok(html.includes('<option value="opencode" data-label="OpenCode">OpenCode (your account)</option>'), "OpenCode option");
  assert.ok(html.includes('<option value="codex" data-label="Codex">Codex (your account)</option>'), "Codex option");
  assert.ok(html.includes('<option value="copilot" data-label="GitHub Copilot">GitHub Copilot (your account)</option>'), "GitHub Copilot option");
  assert.ok(html.includes('<option value="antigravity" data-label="Antigravity">Antigravity (your account)</option>'), "Antigravity option");
  assert.ok(html.includes('id="engineHint"'), "has a place for the plain detection reason");
});

test("settings dialog - each option is disabled with a plain reason when its binary is absent", () => {
  // Logic mirror of the settings-open detection gate in app.js.
  const choices = ["claude", "opencode", "codex", "copilot", "antigravity"];
  const labels: Record<string, string> = { claude: "Claude Code", opencode: "OpenCode", codex: "Codex", copilot: "GitHub Copilot", antigravity: "Antigravity" };
  function resolveEngine(choice: unknown, detected: Array<{ engine: string; installed: boolean }>) {
    const missing = choices.filter((id) => detected.find((e) => e.engine === id)?.installed !== true);
    const selected = choice && !missing.includes(String(choice)) ? String(choice) : "opensand";
    const reasons = missing.map((id) => `${labels[id]} is not installed on this computer.`);
    return {
      selected,
      disabled: missing,
      hint: reasons.length ? `${reasons.join(" ")} Install what you want to use, then reopen Settings to select it.` : "",
    };
  }

  const missing = resolveEngine("opencode", []);
  assert.strictEqual(missing.selected, "opensand");
  assert.deepStrictEqual(missing.disabled, ["claude", "opencode", "codex", "copilot", "antigravity"]);
  assert.match(missing.hint, /OpenCode is not installed on this computer/);
  assert.doesNotMatch(missing.hint, /npm|CLI|--/);

  const installed = resolveEngine("opencode", [
    { engine: "claude", installed: true },
    { engine: "opencode", installed: true },
    { engine: "codex", installed: true },
    { engine: "copilot", installed: true },
    { engine: "antigravity", installed: true },
  ]);
  assert.strictEqual(installed.selected, "opencode");
  assert.deepStrictEqual(installed.disabled, []);
  assert.strictEqual(installed.hint, "");

  assert.deepStrictEqual(resolveEngine("claude", [{ engine: "claude", installed: true }]), {
    selected: "claude",
    disabled: ["opencode", "codex", "copilot", "antigravity"],
    hint: "OpenCode is not installed on this computer. Codex is not installed on this computer. GitHub Copilot is not installed on this computer. Antigravity is not installed on this computer. Install what you want to use, then reopen Settings to select it.",
  });
});
