import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { buildSeatbeltProfile } from "../src/op-launcher.js";
import { registerNativeTools } from "../src/native-tools.js";
import { recognizeScreenText } from "../src/vision-ocr.js";
import { listWindows } from "../src/window-capture.js";
import { readRecentMessages, draftMessage } from "../src/messages-reader.js";
import { speakText } from "../src/speech-bridge.js";

describe("NativeBridge", () => {
  it("generates hardened Seatbelt sandbox profiles", () => {
    const profile = buildSeatbeltProfile(["/custom/restricted/path"]);

    assert.match(profile, /\(version 1\)/);
    assert.match(profile, /\(allow default\)/);
    assert.match(profile, /\(deny file-read\* \(with no-report\) \(subpath "\/custom\/restricted\/path"\)\)/);
    assert.match(profile, /2BUA8C4S2C\.com\.1password/);
  });

  it("registers 7 native tools into LocalExecDaemon", () => {
    const daemon = new LocalExecDaemon();
    registerNativeTools(daemon);

    const defs = daemon.getToolDefinitions();
    const names = defs.map((d) => d.function.name);

    assert.ok(names.includes("recognize_screen_text"));
    assert.ok(names.includes("list_windows"));
    assert.ok(names.includes("capture_window"));
    assert.ok(names.includes("op_exec"));
    assert.ok(names.includes("read_recent_messages"));
    assert.ok(names.includes("draft_imessage"));
    assert.ok(names.includes("speak_text"));
    assert.equal(defs.length, 11); // 4 core + 7 native
  });

  it("enforces deviceTools gate on recognize_screen_text", async () => {
    const daemon = new LocalExecDaemon();
    registerNativeTools(daemon);

    const res = await daemon.executeTool(
      "recognize_screen_text",
      { image_path: "/tmp/nonexistent.png" },
      {
        permissionGates: {
          computerUseAllowed: false,
          deviceToolsAllowed: false,
          standingAllowlist: [],
        },
      }
    );

    assert.equal(res.status, "permission_pending");
  });

  it("handles messages operations safely", async () => {
    // Draft message creates approval-gated structure
    const draft = draftMessage("+1234567890", "Hello from OpenSand");
    assert.equal(draft.status, "success");
    assert.equal(draft.draft?.recipient, "+1234567890");
    assert.equal(draft.draft?.requiresApproval, true);

    // Read messages returns structured result even if TCC restricted
    const result = await readRecentMessages(5);
    assert.ok(["success", "permission_denied", "not_supported"].includes(result.status));
  });

  it("handles speech synthesis safely", async () => {
    // Should return result or not_supported without crashing
    const result = await speakText("OpenSand", undefined);
    assert.ok(["success", "error", "not_supported"].includes(result.status));
  });

  it("handles missing binaries gracefully", async () => {
    const ocrResult = await recognizeScreenText("/tmp/nonexistent_test_image.png");
    assert.equal(ocrResult.status, "error");

    const winResult = await listWindows();
    assert.ok(winResult.status === "ok" || winResult.status === "error");
  });
});
