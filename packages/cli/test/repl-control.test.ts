import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError } from "@opensand/coordinator";
import { clientCommandResult, formatTurnError } from "../src/repl-control.js";

const current = { model: "gpt-4o", endpoint: "http://127.0.0.1:11434/v1" };

describe("REPL turn error messages", () => {
  const cases = [
    { status: 401, code: "AUTH_INVALID_KEY", hint: /API key/ },
    { status: 403, code: "AUTH_FORBIDDEN", hint: /permission/i },
    { status: 404, code: "MODEL_NOT_FOUND", hint: /not found/i },
    { status: 429, code: "RATE_LIMIT_EXCEEDED", hint: /Wait/ },
    { status: 503, code: "PROVIDER_UNAVAILABLE", hint: /Try again/ },
  ];

  for (const c of cases) {
    it(`explains ${c.status} in plain words with a next step`, () => {
      const err = Object.assign(new Error(`provider error ${c.status}`), { status: c.status });
      assert.equal(classifyError(err).code, c.code);

      const rendered = formatTurnError(err, "sk-secret-value");
      assert.equal(rendered.split("\n").length, 2);
      assert.match(rendered, c.hint);
      assert.ok(rendered.split("\n")[1].length > 0);
      assert.equal(rendered.includes("sk-secret-value"), false);
    });
  }

  it("never prints the configured API key on unknown errors", () => {
    const rendered = formatTurnError(new Error("failed with sk-secret-value"), "sk-secret-value");
    assert.equal(rendered.includes("sk-secret-value"), false);
    assert.match(rendered, /\[redacted\]/);
  });
});

describe("REPL client switching commands", () => {
  it("/model <name> sets the model", () => {
    assert.deepEqual(clientCommandResult("/model qwen3:8b", current), {
      message: "Model switched to: qwen3:8b",
      model: "qwen3:8b",
    });
  });

  it("/model shows the current model", () => {
    const result = clientCommandResult("/model", current);
    assert.ok(result);
    assert.match(result!.message, /gpt-4o/);
    assert.equal(result!.model, undefined);
  });

  it("/endpoint rejects a bad URL", () => {
    const result = clientCommandResult("/endpoint not-a-url", current);
    assert.ok(result);
    assert.match(result!.message, /Invalid endpoint/i);
    assert.equal(result!.endpoint, undefined);
  });

  it("/endpoint accepts a valid URL", () => {
    assert.deepEqual(clientCommandResult("/endpoint http://127.0.0.1:8000/v1", current), {
      message: "Endpoint switched to: http://127.0.0.1:8000/v1",
      endpoint: "http://127.0.0.1:8000/v1",
    });
  });
});
