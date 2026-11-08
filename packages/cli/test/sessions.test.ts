import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchSession, validateResumeEnvironment } from "../src/sessions.js";
import { SessionMetadata } from "@opensand/coordinator";

const sessions = [
  { sessionId: "session_aaa", mtimeMs: 300, turns: 2 },
  { sessionId: "session_bbb", mtimeMs: 200, turns: 1 },
  { sessionId: "other_ccc", mtimeMs: 100, turns: 5 },
];

describe("matchSession", () => {
  it("resolves latest to the newest session", () => {
    assert.equal(matchSession(sessions, "latest").session?.sessionId, "session_aaa");
  });

  it("resolves an exact id", () => {
    assert.equal(matchSession(sessions, "other_ccc").session?.sessionId, "other_ccc");
  });

  it("resolves a unique prefix", () => {
    assert.equal(matchSession(sessions, "other").session?.sessionId, "other_ccc");
  });

  it("reports ambiguity instead of silently picking one", () => {
    const match = matchSession(sessions, "session_");
    assert.equal(match.session, undefined);
    assert.deepEqual(match.ambiguous?.map((s) => s.sessionId), ["session_aaa", "session_bbb"]);
  });

  it("returns nothing for an unknown id", () => {
    assert.deepEqual(matchSession(sessions, "zzz"), {});
  });
});

describe("validateResumeEnvironment", () => {
  const persistedSession: SessionMetadata = {
    sessionId: "persisted_session_1",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
    model: "claude-3-5-sonnet",
    endpoint: "https://api.anthropic.com/v1",
    provider: "anthropic",
    title: "Previous conversation",
  };

  describe("credential validation", () => {
    it("fails in batch mode (--query) with actionable error when cloud endpoint lacks API key", () => {
      const savedEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENSAND_API_KEY;

      try {
        const result = validateResumeEnvironment(undefined, {
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o",
          query: "fix tests in repo",
        });

        assert.equal(result.valid, false);
        assert.ok(result.error?.includes("No API key configured for cloud endpoint"));
        assert.ok(result.error?.includes("Fix options:"));
        assert.ok(result.error?.includes("export OPENAI_API_KEY"));
        assert.ok(result.error?.includes("local Ollama"));
      } finally {
        if (savedEnv) process.env.OPENAI_API_KEY = savedEnv;
      }
    });

    it("returns warning instead of fatal batch error in interactive mode when key is missing", () => {
      const savedEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENSAND_API_KEY;

      try {
        const result = validateResumeEnvironment(undefined, {
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o",
        });

        assert.equal(result.valid, false);
        assert.equal(result.error, undefined);
        assert.ok(result.warning?.includes("No API key configured for cloud endpoint"));
      } finally {
        if (savedEnv) process.env.OPENAI_API_KEY = savedEnv;
      }
    });

    it("succeeds for local Ollama endpoints without requiring an API key", () => {
      const result = validateResumeEnvironment(undefined, {
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3:8b",
        query: "summarize README",
      });

      assert.equal(result.valid, true);
      assert.equal(result.endpoint, "http://127.0.0.1:11434/v1");
      assert.equal(result.model, "qwen3:8b");
      assert.equal(result.error, undefined);
    });

    it("succeeds for cloud endpoint when API key is provided", () => {
      const result = validateResumeEnvironment(undefined, {
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o",
        apiKey: "sk-valid-test-key",
        query: "do task",
      });

      assert.equal(result.valid, true);
      assert.equal(result.apiKey, "sk-valid-test-key");
    });
  });

  describe("CLI override precedence: CLI flags > persisted session configuration > defaults", () => {
    it("uses persisted session configuration when no CLI overrides are specified", () => {
      const result = validateResumeEnvironment(persistedSession, {
        apiKey: "sk-some-key",
      });

      assert.equal(result.model, "claude-3-5-sonnet");
      assert.equal(result.endpoint, "https://api.anthropic.com/v1");
      assert.equal(result.provider, "anthropic");
    });

    it("allows CLI flags to override persisted session model and endpoint", () => {
      const result = validateResumeEnvironment(persistedSession, {
        model: "custom-local-model",
        endpoint: "http://127.0.0.1:11434/v1",
        explicitFlags: new Set(["model", "endpoint"]),
      });

      // CLI overrides must take precedence
      assert.equal(result.model, "custom-local-model");
      assert.equal(result.endpoint, "http://127.0.0.1:11434/v1");
    });

    it("falls back to standard defaults when neither persisted session nor CLI overrides exist", () => {
      const result = validateResumeEnvironment(undefined, {
        apiKey: "sk-fallback-key",
      });

      assert.equal(result.model, "gpt-4o");
      assert.equal(result.endpoint, "https://api.openai.com/v1");
    });
  });
});
