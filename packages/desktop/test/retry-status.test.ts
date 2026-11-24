import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(__dirname, "../../renderer/modules/chat/retry-status.js");
const appPath = path.join(__dirname, "../../renderer/app.js");

test("legacy renderer formats a live 429 countdown from an onRetry event", async () => {
  assert.ok(fs.existsSync(modulePath), `retry status module missing at ${modulePath}`);
  const { formatRetryStatus } = await import(pathToFileURL(modulePath).href);
  const now = 1_700_000_000_000;
  const info = { attempt: 2, maxRetries: 6, retryAt: now + 7000, provider: "openrouter", status: 429 };

  assert.strictEqual(
    formatRetryStatus(info, now),
    "Rate limited, retrying in 7s (attempt 2/6)"
  );
  assert.strictEqual(
    formatRetryStatus(info, now + 3000),
    "Rate limited, retrying in 4s (attempt 2/6)"
  );
  assert.strictEqual(
    formatRetryStatus(info, now + 9000),
    "Rate limited, retrying in 0s (attempt 2/6)"
  );
  // Missing fields must fail plain, not render NaN/undefined to the owner.
  assert.strictEqual(formatRetryStatus({}, now), "Rate limited, retrying in 0s (attempt 1/1)");
});

test("legacy app.js paints the countdown on retry and clears it on Stop and the next token/done/error", () => {
  const app = fs.readFileSync(appPath, "utf8");
  assert.ok(app.includes("import { formatRetryStatus } from './modules/chat/retry-status.js';"), "formatter imported");
  assert.ok(app.includes("if (event.type === 'retry')"), "retry event handled");
  assert.ok(app.includes("showRetryNotice(event.data || event)"), "bridge data feeds the notice");
  assert.ok(app.includes("setInterval(paint, 1000)"), "one-second countdown tick");
  assert.ok(app.includes("function clearRetryNotice()"), "clear helper exists");
  assert.ok(app.includes("setTurnBusy(false);\n    clearRetryNotice();"), "Stop clears the wait");
  const clears = app.split("clearRetryNotice();").length - 1;
  assert.ok(clears >= 7, `expected clear on Stop, new turn, token, thought, done, cancel and error; got ${clears}`);
});
