import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { LocalExecDaemon } from "@opensand/local-exec-daemon";
import { createWorkspaceSnapshot } from "@opensand/shared";
import { UniversalLLMClient } from "../src/llm-client.js";
import { AgentCoordinator } from "../src/coordinator.js";

function getWorkspaceFileHashes(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  function scan(current: string) {
    if (!fsSync.existsSync(current)) return;
    for (const ent of fsSync.readdirSync(current, { withFileTypes: true })) {
      if (ent.name === ".opensand-snapshots" || ent.name === ".git" || ent.name === "node_modules") continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        scan(full);
      } else if (ent.isFile()) {
        const rel = path.relative(dir, full);
        const hash = crypto.createHash("sha256").update(fsSync.readFileSync(full)).digest("hex");
        map.set(rel, hash);
      }
    }
  }
  scan(dir);
  return map;
}

describe("Restore Points and Workspace Snapshots", () => {
  let tempBase: string;
  let daemon: LocalExecDaemon;

  before(async () => {
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-restore-test-"));
    daemon = new LocalExecDaemon({
      stateDir: path.join(tempBase, "daemon-state"),
      heartbeatIntervalMs: 200,
    });
    await daemon.start();
  });

  after(async () => {
    await daemon.stop();
    await fs.rm(tempBase, { recursive: true, force: true });
  });

  it("takes a restore point before mutating tools, and restoreTo leaves workspace byte-identical", async () => {
    const workspaceDir = path.join(tempBase, "ws1");
    await fs.mkdir(workspaceDir, { recursive: true });

    const fileA = path.join(workspaceDir, "fileA.txt");
    const fileB = path.join(workspaceDir, "fileB.txt");
    const fileC = path.join(workspaceDir, "fileC.txt");

    await fs.writeFile(fileA, "Content of file A\nUnchanged line\n");
    await fs.writeFile(fileB, "Line 1\nTarget String To Edit\nLine 3\n");

    const preHashes = getWorkspaceFileHashes(workspaceDir);
    assert.equal(preHashes.size, 2);
    assert.ok(preHashes.has("fileA.txt"));
    assert.ok(preHashes.has("fileB.txt"));

    let iteration = 0;
    const mockFetch = async (_url: any, init: any): Promise<Response> => {
      iteration++;
      const encoder = new TextEncoder();
      let chunks: string[] = [];

      if (iteration === 1) {
        // Model performs write_file (creating fileC.txt) and edit_file (modifying fileB.txt)
        chunks = [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: "Executing mutations.",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_write_1",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: fileC,
                          content: "Brand new file C created by LLM turn!\n",
                        }),
                      },
                    },
                    {
                      index: 1,
                      id: "call_edit_2",
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: fileB,
                          old_string: "Target String To Edit",
                          new_string: "Replacement by LLM turn",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          "data: [DONE]\n\n",
        ];
      } else {
        // Model concludes turn
        chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Turn finished." } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
      }

      const stream = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: mockFetch as any,
    });

    const coordinator = new AgentCoordinator({
      sessionId: "restore_session_101",
      llmClient: client,
      daemon,
      workspaceDir,
      sessionsBaseDir: path.join(tempBase, "sessions"),
    });

    const result = await coordinator.runTurn("Modify fileB and create fileC");
    assert.equal(result, "Turn finished.");

    // Verify mutations happened
    assert.ok(fsSync.existsSync(fileC), "fileC.txt should exist after turn");
    const mutatedB = await fs.readFile(fileB, "utf8");
    assert.ok(mutatedB.includes("Replacement by LLM turn"));

    // Verify restore point was recorded
    const restorePoints = await coordinator.listRestorePoints();
    assert.equal(restorePoints.length, 1);
    const point = restorePoints[0];
    assert.ok(point.id.includes("restore_session_101"));
    assert.equal(point.skipped, false);

    // Perform restore
    const revertRes = await coordinator.restoreTo(point.id);
    assert.ok(revertRes.deleted.includes("fileC.txt"));
    assert.ok(revertRes.restored.includes("fileB.txt"));

    // Verify byte-identical restoration
    assert.equal(fsSync.existsSync(fileC), false, "Created fileC must be removed after restore");
    const postHashes = getWorkspaceFileHashes(workspaceDir);
    assert.equal(postHashes.size, preHashes.size);
    for (const [rel, hash] of preHashes.entries()) {
      assert.equal(postHashes.get(rel), hash, `File ${rel} hash must match pre-turn snapshot exactly`);
    }
  });

  it("ensures a failing snapshot does not fail the turn", async () => {
    // Non-existent directory where snapshot fails
    const brokenWorkspaceDir = path.join(tempBase, "non_existent_folder_xyz");

    const mockFetch = async (): Promise<Response> => {
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: "Attempting shell command.",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_exec_1",
                    type: "function",
                    function: {
                      name: "exec_command",
                      arguments: JSON.stringify({ command: "echo snapshot-failure-safe" }),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ];
      let step = 0;
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    let secondTurn = false;
    const fetchWrapper = async (url: any, init: any): Promise<Response> => {
      const body = JSON.parse(init.body as string);
      const last = body.messages[body.messages.length - 1];
      if (last.role === "tool") {
        const encoder = new TextEncoder();
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Finished successfully despite snapshot failure." } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const c of chunks) controller.enqueue(encoder.encode(c));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return mockFetch();
    };

    const client = new UniversalLLMClient({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      fetch: fetchWrapper as any,
    });

    const coordinator = new AgentCoordinator({
      sessionId: "fail_snapshot_sess",
      llmClient: client,
      daemon,
      workspaceDir: brokenWorkspaceDir,
      sessionsBaseDir: path.join(tempBase, "sessions"),
    });

    // The turn must succeed without throwing
    const result = await coordinator.runTurn("Do command");
    assert.equal(result, "Finished successfully despite snapshot failure.");
  });

  it("skips snapshot with recorded reason when workspace file count exceeds limit", async () => {
    const hugeWorkspaceDir = path.join(tempBase, "huge_ws");
    await fs.mkdir(hugeWorkspaceDir, { recursive: true });

    for (let i = 0; i < 15; i++) {
      await fs.writeFile(path.join(hugeWorkspaceDir, `f${i}.txt`), "data");
    }

    const manifest = createWorkspaceSnapshot(hugeWorkspaceDir, "turn_guard_test", undefined, {
      maxFiles: 5,
    });

    assert.equal(manifest.skipped, true);
    assert.match(manifest.skipReason || "", /exceeds snapshot limit/);
  });
});
