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
});
