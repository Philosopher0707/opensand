import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";

describe("ToolRegistry", () => {
  it("provides OpenAI-compatible tool definitions for 4 core tools", () => {
    const registry = new ToolRegistry();
    const defs = registry.getDefinitions();

    assert.equal(defs.length, 4);
    const names = defs.map((d) => d.function.name);
    assert.deepEqual(names.sort(), ["exec_command", "list_directory", "read_file", "write_file"].sort());

    for (const d of defs) {
      assert.equal(d.type, "function");
      assert.ok(d.function.name);
      assert.ok(d.function.description);
      assert.equal(d.function.parameters.type, "object");
      assert.ok(Array.isArray(d.function.parameters.required));
    }
  });

  it("dispatches read_file and write_file operations", async () => {
    const registry = new ToolRegistry();
    const tempFile = `/tmp/opensand-tool-test-${Date.now()}.txt`;

    const writeRes = await registry.dispatch("write_file", {
      path: tempFile,
      content: "registry test content",
    });

    assert.equal(writeRes.status, "ok");
    assert.ok(writeRes.output.bytesWritten > 0);

    const readRes = await registry.dispatch("read_file", {
      path: tempFile,
    });

    assert.equal(readRes.status, "ok");
    assert.equal(readRes.output.content, "registry test content");
  });

  it("requires permission when computerUseAllowed is false and command is not allowlisted", async () => {
    const registry = new ToolRegistry();
    const res = await registry.dispatch(
      "exec_command",
      { command: "curl -s https://example.com" },
      {
        permissionGates: {
          computerUseAllowed: false,
          deviceToolsAllowed: false,
          standingAllowlist: ["ls *"],
        },
      }
    );

    assert.equal(res.status, "permission_pending");
    assert.equal(res.error?.code, "PERMISSION_REQUIRED");
    assert.ok(res.approvalId);
  });

  it("executes command when allowlisted even if computerUseAllowed is false", async () => {
    const registry = new ToolRegistry();
    const res = await registry.dispatch(
      "exec_command",
      { command: "echo permitted" },
      {
        permissionGates: {
          computerUseAllowed: false,
          deviceToolsAllowed: false,
          standingAllowlist: ["echo *"],
        },
      }
    );

    assert.equal(res.status, "ok");
    assert.equal(res.output.stdout.trim(), "permitted");
  });

  it("executes command when approvalGranted is true", async () => {
    const registry = new ToolRegistry();
    const res = await registry.dispatch(
      "exec_command",
      { command: "echo approved" },
      {
        permissionGates: {
          computerUseAllowed: false,
          deviceToolsAllowed: false,
          standingAllowlist: [],
        },
        approvalGranted: true,
      }
    );

    assert.equal(res.status, "ok");
    assert.equal(res.output.stdout.trim(), "approved");
  });

  it("allows registering and executing custom tools", async () => {
    const registry = new ToolRegistry();
    registry.registerCustomTool({
      definition: {
        type: "function",
        function: {
          name: "calculate_sum",
          description: "Calculate sum of two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      },
      handler: async (args) => {
        return { sum: (args.a || 0) + (args.b || 0) };
      },
    });

    assert.equal(registry.getDefinitions().length, 5);
    const res = await registry.dispatch("calculate_sum", { a: 10, b: 32 });
    assert.equal(res.status, "ok");
    assert.equal(res.output.sum, 42);
  });
});
