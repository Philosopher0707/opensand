import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseCliArgs, validateConfig, loadUserConfig, probeLocalOllama } from "../src/config.js";

describe("CliConfig", () => {
  it("parses custom flags and positional queries", () => {
    const args = [
      "--model",
      "llama3",
      "--endpoint",
      "http://localhost:11434/v1",
      "--api-key",
      "sk-test-123",
      "--auto-approve",
      "inspect",
      "workspace",
    ];

    const config = parseCliArgs(args);

    assert.equal(config.model, "llama3");
    assert.equal(config.endpoint, "http://localhost:11434/v1");
    assert.equal(config.apiKey, "sk-test-123");
    assert.equal(config.autoApprove, true);
    assert.equal(config.query, "inspect workspace");
  });

  it("handles -y shorthand for auto-approval", () => {
    const config = parseCliArgs(["-y", "git", "status"]);

    assert.equal(config.autoApprove, true);
    assert.equal(config.query, "git status");
  });

  it("parses --bot persona flag", () => {
    const config = parseCliArgs(["--bot", "cto", "run", "audit"]);

    assert.equal(config.bot, "cto");
    assert.equal(config.query, "run audit");
  });

  it("parses --worktree and completion flags", () => {
    const wtConfig = parseCliArgs(["--worktree", "feature-branch", "run", "build"]);
    assert.equal(wtConfig.worktree, "feature-branch");
    assert.equal(wtConfig.query, "run build");

    const zshConfig = parseCliArgs(["completion", "zsh"]);
    assert.equal(zshConfig.completion, "zsh");

    const bashConfig = parseCliArgs(["completion", "bash"]);
    assert.equal(bashConfig.completion, "bash");
  });

  it("defaults to standard environment", () => {
    const config = parseCliArgs([]);

    assert.ok(config.endpoint);
    assert.ok(config.model);
    assert.equal(config.autoApprove, false);
    assert.equal(config.query, undefined);
  });

  it("validates config and produces warnings when cloud API key is missing", () => {
    const invalidConfig = {
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      autoApprove: false,
    };
    const res = validateConfig(invalidConfig);
    assert.equal(res.valid, false);
    assert.ok(res.warning?.includes("No API key configured"));

    const validLocalConfig = {
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      autoApprove: false,
    };
    assert.equal(validateConfig(validLocalConfig).valid, true);

    const validKeyConfig = {
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-actual-key",
      autoApprove: false,
    };
    assert.equal(validateConfig(validKeyConfig).valid, true);
  });

  it("loads user config from custom json path", () => {
    const tmpPath = path.join(os.tmpdir(), `opensand-cfg-${Date.now()}.json`);
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        endpoint: "http://custom-host:8000/v1",
        model: "deepseek-coder",
        autoApprove: true,
      })
    );

    try {
      const loaded = loadUserConfig(tmpPath);
      assert.equal(loaded.endpoint, "http://custom-host:8000/v1");
      assert.equal(loaded.model, "deepseek-coder");
      assert.equal(loaded.autoApprove, true);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it("probes local Ollama with mock fetch", async () => {
    const mockFetch = async (url: any): Promise<Response> => {
      if (String(url).includes("11434/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), { status: 200 });
      }
      throw new Error("connect ECONNREFUSED");
    };

    const res = await probeLocalOllama(200, mockFetch as any);
    assert.ok(res);
    assert.equal(res?.endpoint, "http://127.0.0.1:11434/v1");
    assert.equal(res?.model, "qwen3:8b");
  });
});
