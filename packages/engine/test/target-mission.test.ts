import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEvent } from "@opensand/shared";
import { projectReceipt } from "../src/missions/receipt.js";
import { LocalWorkspace } from "../src/missions/workspace.js";
import { buildTargetWorkspace } from "../src/missions/target-workspace.js";

let seq = 0;
function event(kind: string, data: Record<string, unknown>): SessionEvent {
  seq += 1;
  return {
    seq,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    sessionId: "m-target",
    kind,
    data,
    prev: "",
  };
}

function accepted(check: Record<string, unknown> = { passed: true, exitCode: 0 }): SessionEvent[] {
  return [
    event("node.completed", { node: "act", claim: "done" }),
    event("check.completed", check),
    event("review.completed", { accept: true, note: "ok" }),
  ];
}

/** The harness, not the agent, decides verified: a target failure wins. */
describe("receipt target block (Phase 8 S4)", () => {
  it("leaves the local path unnamed", () => {
    const receipt = projectReceipt(accepted());
    assert.equal(receipt.status, "VERIFIED");
    assert.equal(receipt.target, undefined);
  });

  it("folds the container's bind result into the receipt", () => {
    const receipt = projectReceipt([
      ...accepted(),
      event("mission.target", { phase: "connect", name: "container", kind: "container", platform: "linux", root: "/workspace" }),
      event("mission.target", { phase: "apply", name: "container", kind: "container", platform: "linux", root: "/workspace", result: "bind" }),
    ]);
    assert.equal(receipt.status, "VERIFIED");
    assert.deepEqual(receipt.target, {
      name: "container",
      kind: "container",
      platform: "linux",
      root: "/workspace",
      result: "bind",
    });
  });

  it("needs a successful apply on an SSH target", () => {
    const base = [
      ...accepted(),
      event("mission.target", { phase: "connect", name: "devbox", kind: "ssh" }),
    ];
    const applied = projectReceipt([...base, event("mission.target", { phase: "apply", name: "devbox", kind: "ssh", result: "applied" })]);
    assert.equal(applied.status, "VERIFIED");
    assert.equal(applied.target?.result, "applied");

    const failed = projectReceipt([...base, event("mission.target", { phase: "failed", name: "devbox", kind: "ssh", result: "failed", detail: "rsync failed" })]);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.target?.result, "failed");
    assert.equal(failed.target?.detail, "rsync failed");
  });

  it("a conflict after acceptance never verifies", () => {
    const receipt = projectReceipt([
      ...accepted(),
      event("mission.target", { phase: "apply", name: "devbox", kind: "ssh", result: "applied" }),
      event("mission.target", { phase: "conflict", name: "devbox", kind: "ssh", result: "conflict", detail: "local file changed" }),
    ]);
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.target?.result, "conflict");
  });
});

describe("local workspace keeps the Phase 3 behaviour", () => {
  it("writes and reads through the one file seam, under the root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-local-ws-"));
    try {
      const ws = new LocalWorkspace(root);
      assert.equal(ws.kind, "local");
      assert.equal(ws.root, root);
      assert.equal(ws.identity(), undefined);
      await ws.writeFile({ path: path.join(root, "out.txt"), content: "ok\n", overwrite: true });
      assert.equal((await ws.readFile({ path: path.join(root, "out.txt") })).content, "ok\n");
      assert.deepEqual(await ws.prepare(), {});
      assert.deepEqual(await ws.apply(), {});
      await assert.rejects(
        ws.writeFile({ path: path.join(root, "..", "escape.txt"), content: "no", overwrite: true })
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("target workspace construction", () => {
  it("keeps root local and translates only the target side", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-target-ws-"));
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-bundle-"));
    try {
      fs.writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
      const ws = buildTargetWorkspace({
        missionId: "m-target",
        workspaceRoot: root,
        name: "container",
        config: { kind: "container", image: "node:22-bookworm" },
        bundleDir: bundle,
      });
      assert.equal(ws.kind, "container");
      assert.equal(ws.root, root, "root stays local for trust, log and snapshots");
      assert.deepEqual(ws.identity(), { name: "container", kind: "container" });
      assert.deepEqual(await ws.prepare(), {});
      assert.deepEqual(await ws.apply(), {});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});
