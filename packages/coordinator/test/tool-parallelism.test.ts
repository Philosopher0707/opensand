import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isParallelSafeTool } from "../src/tool-parallelism.js";

describe("tool parallelism safety", () => {
  it("parallelizes explicitly read-only tools", () => {
    assert.equal(isParallelSafeTool("read_file"), true);
    assert.equal(isParallelSafeTool("list_directory"), true);
    assert.equal(isParallelSafeTool("list_agents"), true);
    assert.equal(isParallelSafeTool("discover_tools"), true);
  });

  it("keeps mutating, shell, and unknown tools sequential", () => {
    for (const name of [
      "exec_command",
      "write_file",
      "apply_patch",
      "create_agent",
      "delegate_to_agent",
      "vault_store_secret",
      "git_auto_commit",
      "unknown_mcp_tool",
    ]) {
      assert.equal(isParallelSafeTool(name), false, name);
    }
  });
});
