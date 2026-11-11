import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { registerOrchestratorTools } from "../src/orchestrator-tools.js";
import { DEFAULT_ROLE_TOOLS } from "../src/token-hygiene.js";
import { CURATED_GALLERY_TEMPLATES } from "../src/template-gallery.js";

describe("Tool Resolution Gate", () => {
  it("every tool in DEFAULT_ROLE_TOOLS and every template allowedTools resolves to a registered definition", async () => {
    const daemon = new LocalExecDaemon();
    registerOrchestratorTools({ daemon });

    // Register native bridge tools dynamically via file URL
    const nativeModule = await import(
      new URL("../../../native-bridge/dist/src/index.js", import.meta.url).href
    );
    if (typeof nativeModule.registerNativeTools === "function") {
      nativeModule.registerNativeTools(daemon);
    }

    const registeredToolNames = new Set(
      daemon.tools.getDefinitions().map((d) => d.function.name)
    );

    // 1. Verify all DEFAULT_ROLE_TOOLS resolve
    const unresolvableRoleTools: string[] = [];
    for (const [role, tools] of Object.entries(DEFAULT_ROLE_TOOLS)) {
      for (const toolName of tools) {
        if (!registeredToolNames.has(toolName)) {
          unresolvableRoleTools.push(`Role [${role}] -> Tool [${toolName}]`);
        }
      }
    }
    assert.deepEqual(
      unresolvableRoleTools,
      [],
      `Found unregistered tools in DEFAULT_ROLE_TOOLS:\n${unresolvableRoleTools.join("\n")}`
    );

    // 2. Verify all template gallery allowedTools resolve
    const unresolvableTemplateTools: string[] = [];
    for (const tpl of CURATED_GALLERY_TEMPLATES) {
      for (const toolName of tpl.allowedTools) {
        if (!registeredToolNames.has(toolName)) {
          unresolvableTemplateTools.push(`Template [${tpl.id}] -> Tool [${toolName}]`);
        }
      }
    }
    assert.deepEqual(
      unresolvableTemplateTools,
      [],
      `Found unregistered tools in CURATED_GALLERY_TEMPLATES:\n${unresolvableTemplateTools.join("\n")}`
    );
  });
});
