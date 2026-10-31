import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBashCommand } from "../src/bash-validator.js";

describe("BashValidator", () => {
  it("allows standard valid bash commands", () => {
    const validCommands = [
      "echo 'hello world'",
      "ls -la /tmp",
      "git status",
      "find . -name '*.ts' | xargs wc -l",
      "cat << 'EOF'\nline 1\nline 2\nEOF",
      "if [ -f foo ]; then echo yes; fi",
      "for i in {1..5}; do echo $i; done",
    ];

    for (const cmd of validCommands) {
      const res = validateBashCommand(cmd);
      assert.equal(res.valid, true, `Command should be valid: ${cmd}`);
      assert.equal(res.isDangerous, false);
    }
  });

  it("detects unbalanced single quotes", () => {
    const res = validateBashCommand("echo 'unclosed string");
    assert.equal(res.valid, false);
    assert.match(res.error || "", /Unclosed single quote/i);
  });

  it("detects unbalanced double quotes", () => {
    const res = validateBashCommand('echo "unclosed string');
    assert.equal(res.valid, false);
    assert.match(res.error || "", /Unclosed double quote/i);
  });

  it("detects unclosed parentheses", () => {
    const res = validateBashCommand("(cd /tmp && ls");
    assert.equal(res.valid, false);
    assert.match(res.error || "", /Unclosed parenthesis/i);
  });

  it("detects unclosed curly braces", () => {
    const res = validateBashCommand("{ echo 1; echo 2;");
    assert.equal(res.valid, false);
    assert.match(res.error || "", /Unclosed curly brace/i);
  });

  it("flags destructive root commands as dangerous", () => {
    const dangerousCommands = [
      "rm -rf /",
      "rm -rf /*",
      "rm --no-preserve-root -rf /",
      "mkfs.ext4 /dev/sda",
      ":(){ :|:& };:",
      "dd if=/dev/zero of=/dev/sda",
      "> /dev/sda",
    ];

    for (const cmd of dangerousCommands) {
      const res = validateBashCommand(cmd);
      assert.equal(res.isDangerous, true, `Command should be flagged dangerous: ${cmd}`);
      assert.ok(res.dangerReason);
    }
  });
});
