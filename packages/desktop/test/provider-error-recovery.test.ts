import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopIpcBridge } from "../src/ipc-bridge.js";
import {
  chatTurnReducer,
  chatEventAction,
  INITIAL_CHAT_TURN,
  isChatBusy,
  ChatTurnState,
} from "../src/shell/chat-turn-model.js";

test("Turn and session recovery: 429 provider error renders cause + nextAction, chat remains usable, next query recovers", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-recovery-test-"));
  fs.mkdirSync(path.join(tmpDir, "sessions"), { recursive: true });
  let serverMode: "rate_limit" | "success" = "rate_limit";
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    requestCount++;
    if (serverMode === "rate_limit") {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "1",
      });
      res.end(JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 429,
          metadata: { provider: "openrouter" },
        },
      }));
    } else {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Recovered successfully!" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;
  const endpoint = `http://127.0.0.1:${port}/v1`;

  try {
    const bridge = new DesktopIpcBridge({
      baseDir: tmpDir,
      defaultSettings: {
        endpoint,
        model: "openrouter/auto",
        provider: "openrouter",
        apiKey: "test-token",
        autoApprove: true,
      },
    });

    await bridge.folderTrustStore.setLevel(process.cwd(), "trusted");

    // Track simulated renderer chat state driven by bridge events
    let chatState: ChatTurnState = { ...INITIAL_CHAT_TURN };

    const capturedEvents: any[] = [];
    bridge.on("event", (evt: any) => {
      capturedEvents.push(evt);
      const action = chatEventAction(evt, chatState.sessionId);
      if (action) {
        chatState = chatTurnReducer(chatState, action);
      }
    });

    // --- TURN 1: Fails with 429 ---
    const coord = await bridge.createSessionCoordinator();
    const sessionId = coord.sessionId;
    chatState = { ...chatState, sessionId };

    // Start turn 1 in renderer
    chatState = chatTurnReducer(chatState, { type: "start", query: "Hello assistant" });
    assert.strictEqual(isChatBusy(chatState.status), true, "Turn 1 is initially busy");

    const errEventPromise = new Promise<any>((resolve) => {
      const handler = (evt: any) => {
        if (evt.type === "error") {
          bridge.off("event", handler);
          resolve(evt);
        }
      };
      bridge.on("event", handler);
    });

    const res1 = await bridge.sendQuery("Hello assistant", sessionId);
    assert.strictEqual(res1.success, true);

    const errEvent = await errEventPromise;

    // Verify error event payload has clean cause + nextAction, no stack, no JSON
    assert.ok(errEvent.data, "Error event must have data payload");
    const errMsg = errEvent.data.message;
    assert.ok(errMsg.includes("The upstream model provider is rate-limited"), "Must contain plain cause");
    assert.ok(errMsg.includes("Settings"), "Must contain nextAction pointing to Settings");
    assert.ok(!errMsg.includes("at http"), "Must not leak raw URLs or stack traces");
    assert.ok(!errMsg.includes("{\"error\""), "Must not leak raw JSON");
    assert.strictEqual(errEvent.data.code, "RATE_LIMIT_EXCEEDED");

    // Verify Chat renderer state after error
    assert.strictEqual(chatState.status, "error", "Chat state must reflect error");
    assert.strictEqual(isChatBusy(chatState.status), false, "Chat must NOT be busy after error (accepts next query)");
    assert.strictEqual(chatState.messages.length, 2, "Chat has user message + assistant error message");
    const assistantMsg = chatState.messages[1];
    assert.strictEqual(assistantMsg.role, "assistant");
    assert.strictEqual(assistantMsg.error, errMsg);

    // --- TURN 2: Server recovers, user sends next message ---
    serverMode = "success";

    const completePromise = new Promise<any>((resolve) => {
      const handler = (evt: any) => {
        if (evt.type === "turn_complete") {
          bridge.off("event", handler);
          resolve(evt);
        }
      };
      bridge.on("event", handler);
    });

    // Renderer dispatches start for second query
    chatState = chatTurnReducer(chatState, { type: "start", query: "Can you answer now?" });
    assert.strictEqual(isChatBusy(chatState.status), true, "Turn 2 transitions to busy");

    const res2 = await bridge.sendQuery("Can you answer now?", sessionId);
    assert.strictEqual(res2.success, true);

    const completeEvent = await completePromise;
    assert.strictEqual(completeEvent.type, "turn_complete");
    assert.ok(completeEvent.data.response.includes("Recovered successfully!"));

    // Verify final recovered state in renderer
    assert.strictEqual(chatState.status, "done", "Session recovered to done status");
    assert.strictEqual(isChatBusy(chatState.status), false, "Session is idle and ready");
    assert.strictEqual(chatState.messages.length, 4, "Session history contains both turns");
    assert.strictEqual(chatState.messages[3].text, "Recovered successfully!");
    assert.strictEqual(chatState.messages[3].error, undefined, "New assistant turn has no error");
  } finally {
    (server as any).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
