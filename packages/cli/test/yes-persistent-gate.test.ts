import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { decideCliApproval } from "../src/approval-policy.js";

describe("yes-persistent-gate: auto-approve behavior for persistent vs normal tools", () => {
  it("(a) with -y, a skill write is not auto-approved", async () => {
    let refusalMessage = "";
    const addSkillApproved = await decideCliApproval(
      { toolName: "add_skill", arguments: { name: "planted", content: "exfiltrate" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: false,
        onRefusalMessage: (msg) => { refusalMessage = msg; },
      }
    );
    assert.equal(addSkillApproved, false, "add_skill must not be auto-approved under -y");
    assert.equal(refusalMessage, "skill writes need your yes; -y does not cover them");

    const mountSkillApproved = await decideCliApproval(
      { toolName: "mount_skill", arguments: { skill_id_or_name: "test" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: false,
      }
    );
    assert.equal(mountSkillApproved, false, "mount_skill must not be auto-approved under -y");
  });

  it("(b) with -y, a memory write is not auto-approved", async () => {
    let refusalMessage = "";
    const updateMemApproved = await decideCliApproval(
      { toolName: "update_memory", arguments: { action: "write", text: "fact", scope: "user" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: false,
        onRefusalMessage: (msg) => { refusalMessage = msg; },
      }
    );
    assert.equal(updateMemApproved, false, "update_memory (user scope) must not be auto-approved under -y");
    assert.equal(refusalMessage, "memory writes need your yes; -y does not cover them");

    const importMemApproved = await decideCliApproval(
      { toolName: "import_memory", arguments: { path: "memories.json" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: false,
      }
    );
    assert.equal(importMemApproved, false, "import_memory must not be auto-approved under -y");
  });

  it("(c) with -y, a normal tool is still auto-approved", async () => {
    const execApproved = await decideCliApproval(
      { toolName: "exec_command", arguments: { command: "git status" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: false,
      }
    );
    assert.equal(execApproved, true, "exec_command must still be auto-approved under -y");

    const readFileApproved = await decideCliApproval(
      { toolName: "read_file", arguments: { path: "README.md" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: false,
      }
    );
    assert.equal(readFileApproved, true, "read_file must still be auto-approved under -y");
  });

  it("(d) with the explicit opt-in, (a) and (b) are approved", async () => {
    const addSkillApproved = await decideCliApproval(
      { toolName: "add_skill", arguments: { name: "planted", content: "body" } },
      {
        autoApprove: true,
        autoApprovePersistent: true,
        isInteractive: false,
      }
    );
    assert.equal(addSkillApproved, true, "add_skill is approved when autoApprovePersistent is true");

    const mountSkillApproved = await decideCliApproval(
      { toolName: "mount_skill", arguments: { skill_id_or_name: "test" } },
      {
        autoApprove: true,
        autoApprovePersistent: true,
        isInteractive: false,
      }
    );
    assert.equal(mountSkillApproved, true, "mount_skill is approved when autoApprovePersistent is true");

    const updateMemApproved = await decideCliApproval(
      { toolName: "update_memory", arguments: { action: "write", text: "fact", scope: "user" } },
      {
        autoApprove: true,
        autoApprovePersistent: true,
        isInteractive: false,
      }
    );
    assert.equal(updateMemApproved, true, "update_memory is approved when autoApprovePersistent is true");

    const importMemApproved = await decideCliApproval(
      { toolName: "import_memory", arguments: { path: "memories.json" } },
      {
        autoApprove: true,
        autoApprovePersistent: true,
        isInteractive: false,
      }
    );
    assert.equal(importMemApproved, true, "import_memory is approved when autoApprovePersistent is true");
  });

  it("interactive mode asks the person when -y is active without explicit opt-in", async () => {
    let promptedTool = "";
    let promptedArgs: any = null;
    const approved = await decideCliApproval(
      { toolName: "update_memory", arguments: { action: "write", text: "fact", scope: "user" } },
      {
        autoApprove: true,
        autoApprovePersistent: false,
        isInteractive: true,
        promptApproval: async (toolName, args) => {
          promptedTool = toolName;
          promptedArgs = args;
          return "allow_once";
        },
      }
    );
    assert.equal(promptedTool, "update_memory");
    assert.equal(promptedArgs?.text, "fact");
    assert.equal(approved, true);
  });
});
