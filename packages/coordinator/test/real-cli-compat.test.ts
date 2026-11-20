import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ClaudeDriver } from "../src/providers/claude-driver.js";
import { CodexDriver } from "../src/providers/codex-driver.js";
import { OpenCodeDriver } from "../src/providers/opencode-driver.js";

/**
 * Real-binary compatibility gate. Skips a probe when the CLI is not installed;
 * when it is, the flags OpenSand actually spawns must be accepted and the
 * version regex must match the binary's own --version output.
 */
const PROBES = [
  { binary: "claude", driver: ClaudeDriver, args: ["--help"], flags: ["--output-format", "--input-format", "--include-partial-messages", "--permission-mode", "--session-id", "--resume", "stream-json"] },
  { binary: "codex", driver: CodexDriver, args: ["--help"], flags: ["app-server"] },
  { binary: "opencode", driver: OpenCodeDriver, args: ["--help"], flags: ["acp"] },
];

describe("installed CLI compatibility", () => {
  for (const probe of PROBES) {
    it(`${probe.binary}: accepted flags and version regex`, { timeout: 20_000 }, () => {
      const result = spawnSync(probe.binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return; // not installed
      assert.equal(result.status, 0, `${probe.binary} --version failed: ${result.stderr?.slice(0, 200) ?? ""}`);
      const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      assert.ok(probe.driver.metadata.cliVersion?.test(version), `${probe.binary}: version regex did not match ${version.slice(0, 80)}`);

      const help = spawnSync(probe.binary, probe.args, { encoding: "utf8", timeout: 10_000 });
      assert.equal(help.status, 0, `${probe.binary} --help failed`);
      const text = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
      for (const flag of probe.flags) {
        assert.ok(text.includes(flag), `${probe.binary} --help does not mention ${flag}`);
      }
    });
  }
});
