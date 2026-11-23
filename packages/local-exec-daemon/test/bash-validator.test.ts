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

  it("F3: flags quoted and variable-indirection bypasses of destructive root deletion", () => {
    const bypasses = [
      'rm -rf "/"',
      "rm -rf '/'",
      'X=/; rm -rf $X',
      'X=/; rm -rf ${X}',
      'rm -rf -- /',
    ];
    for (const cmd of bypasses) {
      const res = validateBashCommand(cmd);
      assert.equal(res.isDangerous, true, `Quoted/variable bypass must be flagged dangerous: ${cmd}`);
      assert.ok(res.dangerReason);
    }
  });

  it("F3: does not flag ordinary recursive deletes of relative paths", () => {
    for (const cmd of ["rm -rf ./build", "rm file.txt"]) {
      const res = validateBashCommand(cmd);
      assert.equal(res.isDangerous, false, `Ordinary delete must stay safe: ${cmd}`);
    }
  });

  it("F3b: nested shells, substitution, split flags and quote tricks are all dangerous", () => {
    // Every string Rigel reported as isDangerous=false against the compiled validator.
    const bypasses = [
      'sh -c "rm -rf /"',
      "bash -c 'rm -rf /'",
      "(rm -rf /)",
      "$(rm -rf /)",
      "`rm -rf /`",
      'rm -rf "$HOME"',
      'rm -rf "$X"',
      "rm -rf ~/",
      "rm -r -f /",
      "rm --recursive --force /",
      'r""m -rf /',
      "rm -rf $(echo /)",
      'rm -rf ""/',
    ];
    for (const cmd of bypasses) {
      const res = validateBashCommand(cmd);
      assert.equal(res.isDangerous, true, `Bypass must be flagged dangerous: ${cmd}`);
      assert.ok(res.dangerReason, `Bypass must carry a plain-language reason: ${cmd}`);
    }
  });

  it("F3b: no regression - Rigel's 19 previously blocked strings stay dangerous", () => {
    // 16 verbatim from Rigel's PR #203 check; fork bomb / dd / mkfs were recorded by
    // description only, so use the strings already in this file's dangerous table.
    const blocked = [
      "rm -rf /",
      'rm -rf "/"',
      "rm -rf '/'",
      "rm -rf $HOME",
      "X=/; rm -rf $X",
      "env rm -rf /",
      "echo hi; rm -rf /",
      "true && rm -rf /",
      "/bin/rm -rf /",
      "command rm -rf /",
      "sudo rm -rf /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -fr /",
      "rm -rf -- /",
      "rm -rf / --no-preserve-root",
      ":(){ :|:& };:",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sda",
    ];
    for (const cmd of blocked) {
      const res = validateBashCommand(cmd);
      assert.equal(res.isDangerous, true, `Previously blocked string regressed: ${cmd}`);
      assert.ok(res.dangerReason);
    }
  });

  it("F3b: relative-path deletes still pass after the denylist hardening", () => {
    for (const cmd of ["rm -rf ./build", "rm -rf node_modules", "rm -rf ./dist", "rm -r ./build"]) {
      const res = validateBashCommand(cmd);
      assert.equal(res.isDangerous, false, `Relative-path delete must stay safe: ${cmd}`);
      assert.equal(res.valid, true, `Relative-path delete must stay syntactically valid: ${cmd}`);
    }
  });
});
