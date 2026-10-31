import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { buildSeatbeltProfile } from "../src/op-launcher.js";
import { registerNativeTools } from "../src/native-tools.js";
import { recognizeScreenText } from "../src/vision-ocr.js";
import { listWindows } from "../src/window-capture.js";

describe("NativeBridge", () => {
  it("generates hardened Seatbelt sandbox profiles", () => {
    const profile = buildSeatbeltProfile(["/custom/restricted/path"]);

    assert.match(profile, /\(version 1\)/);
    assert.match(profile, /\(allow default\)/);
    assert.match(profile, /\(deny file-read\* \(with no-report\) \(subpath "\/custom\/restricted\/path"\)\)/);
    assert.match(profile, /2BUA8C4S2C\.com\.1password/);
  });

  it("registers 4 native tools into LocalExecDaemon", () => {
    const daemon = new LocalExecDaemon();
    registerNativeTools(daemon);

    const defs = daemon.getToolDefinitions();
    const names = defs.map((d) => d.function.name);

    assert.ok(names.includes("recognize_screen_text"));
    assert.ok(names.includes("list_windows"));
    assert.ok(names.includes("capture_window"));
    assert.ok(names.includes("op_exec"));
    assert.equal(defs.length, 8); // 4 core + 4 native
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
    assert.equal(res.error?.code, "PERMISSION_REQUIRED");
    assert.match(res.error?.message || "", /deviceTools gate approval/);
  });

  it("gracefully reports missing image in recognizeScreenText", async () => {
    const res = await recognizeScreenText("/tmp/definitely-does-not-exist-12345.png");
    assert.equal(res.status, "error");
    assert.match(res.message || "", /does not exist/);
  });

  it("lists open windows through native CoreGraphics bridge", async () => {
    const res = await listWindows();
    assert.equal(res.status, "ok");
    assert.ok(Array.isArray(res.windows));
    // Verify window shape if any window is returned
    if (res.windows && res.windows.length > 0) {
      const first = res.windows[0];
      assert.ok(typeof first.id === "number");
      assert.ok(typeof first.owner === "string");
      assert.ok(first.bounds);
    }
  });
});
