import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GrantsStore } from "@opensand/shared";
import { LocalExecDaemon } from "../src/daemon.js";

const worker = fileURLToPath(new URL("./helpers/standing-grants-worker.js", import.meta.url));

function spawnWorker(args: string[]): { child: ChildProcess; lines: string[]; waitFor: (text: string) => Promise<void>; exited: Promise<number | null> } {
  const child = fork(worker, args, { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  const lines: string[] = [];
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  let buf = "";
  child.stdout!.on("data", (d) => {
    buf += String(d);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    for (const w of waiters.splice(0)) {
      if (lines.some((l) => l.includes(w.text))) w.resolve();
      else waiters.push(w);
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const waitFor = (text: string) =>
    lines.some((l) => l.includes(text)) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ text, resolve }));
  return { child, lines, waitFor, exited };
}

describe("standing grants across processes", () => {
  it("a child process revokes while the parent keeps calling exec_command", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-standing-race-"));
    try {
      const store = new GrantsStore({ baseDir: base });
      const grant = await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
      const daemon = new LocalExecDaemon({ stateDir: path.join(base, "state") });
      assert.equal((await daemon.executeTool("exec_command", { command: "echo warm" })).status, "ok");

      const w = spawnWorker(["revoke", base, grant.id]);
      let revokedEpoch: number | undefined;
      void w.waitFor("revoked epoch=").then(() => {
        revokedEpoch = Number(w.lines.find((l) => l.startsWith("revoked epoch="))!.split("=")[1]);
      });

      const afterRevoke: string[] = [];
      let ran = 0;
      let pending = 0;
      const deadline = Date.now() + 20_000;
      let seenAfter = 0;
      while (Date.now() < deadline && seenAfter < 5) {
        const sawRevokeBeforeCall = revokedEpoch !== undefined;
        const res = await daemon.executeTool("exec_command", { command: "echo race" });
        assert.ok(res.status === "ok" || res.status === "permission_pending", `unexpected status ${res.status}`);
        if (res.status === "ok") ran++; else pending++;
        if (sawRevokeBeforeCall) {
          seenAfter++;
          afterRevoke.push(res.status);
        }
      }
      assert.equal(await w.exited, 0);
      assert.equal(revokedEpoch, 2);
      assert.ok(seenAfter >= 5, "the revoke never became visible to the parent");
      assert.deepEqual(afterRevoke, afterRevoke.map(() => "permission_pending"), "every call that started after the revoke was seen must be pending");
      assert.ok(ran >= 1, "the warm-up/early calls ran");
      assert.equal((await daemon.getGates()).grantsEpoch, 2);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("reads are lock-free: a child holding grants.lock does not block the parent and the parent sees the whole pre-lock file", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "opensand-standing-lock-"));
    let w: ReturnType<typeof spawnWorker> | undefined;
    try {
      const store = new GrantsStore({ baseDir: base });
      await store.addGrant({ tool: "exec_command", scope: "echo *", lifetime: "always" });
      const before = fs.readFileSync(store.filePath, "utf8");
      const daemon = new LocalExecDaemon({ stateDir: path.join(base, "state") });
      w = spawnWorker(["hold", base, "1500"]);
      await w.waitFor("locked");
      const t0 = Date.now();
      const res = await daemon.executeTool("exec_command", { command: "echo unblocked" });
      assert.equal(res.status, "ok");
      assert.ok(Date.now() - t0 < 1200, "exec decision waited for grants.lock");
      assert.equal(fs.readFileSync(store.filePath, "utf8"), before);
      assert.equal(await w.exited, 0);
    } finally {
      if (w && w.child.exitCode === null) w.child.kill("SIGKILL");
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
