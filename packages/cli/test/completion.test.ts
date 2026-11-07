import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateZshCompletion,
  generateBashCompletion,
  getReplCompletions,
  CLI_SUBCOMMANDS,
  CLI_FLAGS,
  REPL_SLASH_COMMANDS,
} from "../src/completion.js";

describe("Completion Generator", () => {
  it("generates valid zsh completion script with subcommands and flags", () => {
    const zsh = generateZshCompletion();
    assert.ok(zsh.startsWith("#compdef opensand"));
    assert.ok(zsh.includes("_opensand()"));
    for (const sub of CLI_SUBCOMMANDS) {
      assert.ok(zsh.includes(sub.name), `Zsh script should include subcommand '${sub.name}'`);
    }
    for (const flag of CLI_FLAGS) {
      assert.ok(zsh.includes(flag.flag), `Zsh script should include flag '${flag.flag}'`);
    }
  });

  it("generates valid bash completion script with completion handler", () => {
    const bash = generateBashCompletion();
    assert.ok(bash.includes("_opensand_completions()"));
    assert.ok(bash.includes("complete -F _opensand_completions opensand"));
    assert.ok(bash.includes("doctor status completion"));
    assert.ok(bash.includes("--endpoint"));
    assert.ok(bash.includes("--worktree"));
  });

  it("completes REPL slash commands via getReplCompletions", () => {
    // Exact prefix match for /r
    const [rHits, rLine] = getReplCompletions("/r");
    assert.equal(rLine, "/r");
    assert.ok(rHits.includes("/rollback"));
    assert.ok(rHits.includes("/rooms"));
    assert.ok(rHits.includes("/routines"));
    assert.ok(rHits.includes("/rules"));
    assert.ok(!rHits.includes("/tools"));

    // Prefix match for /t
    const [tHits] = getReplCompletions("/t");
    assert.ok(tHits.includes("/tools"));
    assert.ok(tHits.includes("/template"));
    assert.ok(tHits.includes("/tasks"));
    assert.ok(tHits.includes("/tokens"));

    // Dynamic bot completion for /bot
    const [botHits] = getReplCompletions("/bot c", ["cto", "architect", "reviewer"]);
    assert.deepEqual(botHits, ["/bot cto"]);

    // Exit and quit shorthands
    const [exitHits] = getReplCompletions("ex");
    assert.deepEqual(exitHits, ["exit"]);

    const [quitHits] = getReplCompletions("qu");
    assert.deepEqual(quitHits, ["quit"]);
  });
  it("has /sessions, /resume and /new in REPL_SLASH_COMMANDS", () => {
    assert.ok(REPL_SLASH_COMMANDS.includes("/sessions"));
    assert.ok(REPL_SLASH_COMMANDS.includes("/resume"));
    assert.ok(REPL_SLASH_COMMANDS.includes("/new"));
  });

  it("completes /resume with latest and provided session IDs", () => {
    const [hits, line] = getReplCompletions("/resume ", [], ["sess-1", "sess-2"]);
    assert.equal(line, "/resume ");
    assert.deepEqual(hits, ["/resume latest", "/resume sess-1", "/resume sess-2"]);

    const [filtered] = getReplCompletions("/resume sess-1", [], ["sess-1", "sess-2"]);
    assert.deepEqual(filtered, ["/resume sess-1"]);
  });

  it("completes /attach with filesystem paths", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-attach-test-"));
    try {
      const filePath = path.join(tmpDir, "test-file.txt");
      await fs.writeFile(filePath, "sample content");
      const subDir = path.join(tmpDir, "subdir");
      await fs.mkdir(subDir);

      const [hits] = getReplCompletions(`/attach ${tmpDir}/`);
      assert.ok(hits.includes(`/attach ${tmpDir}/test-file.txt`));
      assert.ok(hits.includes(`/attach ${tmpDir}/subdir/`));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
