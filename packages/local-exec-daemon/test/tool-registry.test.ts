import * as fs from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";

describe("ToolRegistry", () => {
  it("provides OpenAI-compatible tool definitions for 7 core tools", () => {
    const registry = new ToolRegistry();
    const defs = registry.getDefinitions();

    assert.equal(defs.length, 7);
    const names = defs.map((d) => d.function.name);
    assert.deepEqual(names.sort(), ["edit_file", "exec_command", "glob", "grep", "list_directory", "read_file", "write_file"].sort());

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

  it("dispatches edit_file, grep, and glob operations", async () => {
    const registry = new ToolRegistry();
    const tempDir = `/tmp/opensand-reg-${Date.now()}`;
    const tempFile = `${tempDir}/sub/code.txt`;

    await registry.dispatch("write_file", {
      path: tempFile,
      content: "line 1: hello\nline 2: target word\nline 3: world\n",
    });

    // edit_file dispatch
    const editRes = await registry.dispatch("edit_file", {
      path: tempFile,
      old_string: "target word",
      new_string: "replacement string",
    });
    assert.equal(editRes.status, "ok");
    assert.equal(editRes.output.replacementCount, 1);

    // grep dispatch
    const grepRes = await registry.dispatch("grep", {
      pattern: "replacement",
      path: tempDir,
    });
    assert.equal(grepRes.status, "ok");
    assert.equal(grepRes.output.matches.length, 1);
    assert.ok(grepRes.output.lines[0].includes("replacement string"));

    // glob dispatch
    const globRes = await registry.dispatch("glob", {
      pattern: "**/*.txt",
      path: tempDir,
    });
    assert.equal(globRes.status, "ok");
    assert.equal(globRes.output.matches.length, 1);

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
          standingAllowlist: [],
          standingGrants: [{ id: "g1", tool: "exec_command", scope: "ls *", lifetime: "always", epoch: 1, createdAt: 0 }],
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
          standingAllowlist: [],
          standingGrants: [{ id: "g1", tool: "exec_command", scope: "echo *", lifetime: "always", epoch: 1, createdAt: 0 }],
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

  it("rejects auto-approval when command uses shell chaining even if prefix is allowlisted", async () => {
    const registry = new ToolRegistry();
    const chainedCommands = [
      "echo permitted; rm -rf /",
      "echo permitted && cat /etc/passwd",
      "echo permitted | bash",
      "echo `id`",
      "echo $(whoami)",
    ];

    for (const cmd of chainedCommands) {
      const res = await registry.dispatch(
        "exec_command",
        { command: cmd },
        {
          permissionGates: {
            computerUseAllowed: false,
            deviceToolsAllowed: false,
            standingAllowlist: [],
          standingGrants: [{ id: "g1", tool: "exec_command", scope: "echo *", lifetime: "always", epoch: 1, createdAt: 0 }],
          },
        }
      );

      assert.equal(res.status, "permission_pending", `Command "${cmd}" should have required approval`);
      assert.equal(res.error?.code, "PERMISSION_REQUIRED");
    }
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

    assert.equal(registry.getDefinitions().length, 8);
    const res = await registry.dispatch("calculate_sum", { a: 10, b: 32 });
    assert.equal(res.status, "ok");
    assert.equal(res.output.sum, 42);
  });

  it("allows unregistering custom tools", async () => {
    const registry = new ToolRegistry();
    registry.registerCustomTool({
      definition: {
        type: "function",
        function: {
          name: "temp_tool",
          description: "Temporary tool",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => "ok",
    });
    assert.equal(registry.getDefinitions().length, 8);
    const removed = registry.unregisterCustomTool("temp_tool");
    assert.equal(removed, true);
    assert.equal(registry.getDefinitions().length, 7);
  });
});
