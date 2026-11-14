import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventLogReader, FolderTrustStore, GrantsStore, type SessionEvent } from "@opensand/shared";
import { EngineServer } from "../src/server.js";
import { ScriptedMissionAgent } from "../src/missions/agent.js";

interface Frame {
  id?: string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
  event?: string;
  data?: any;
}

class Harness {
  readonly frames: Frame[] = [];
  readonly server: EngineServer;
  readonly base: string;
  readonly root: string;
  readonly store: FolderTrustStore;
  readonly grants: GrantsStore;
  private n = 0;

  constructor() {
    this.base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-trust-engine-")));
    this.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-trust-ws-")));
    this.grants = new GrantsStore({ baseDir: this.base });
    this.store = new FolderTrustStore({ baseDir: this.base, grants: this.grants });
    this.server = new EngineServer({
      stateDir: this.base,
      version: "test",
      heartbeatIntervalMs: 0,
      missionAgent: new ScriptedMissionAgent([{ claim: "done", review: { accept: true, note: "ok" } }]),
      connection: {
        write: (line) => {
          for (const l of line.split("\n").filter(Boolean)) this.frames.push(JSON.parse(l));
        },
        bufferedBytes: () => 0,
      },
    });
  }

  folder(name: string): string {
    const p = path.join(this.root, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out; frames: ${JSON.stringify(this.frames.map((f) => f.event ?? f.id))}`);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const id = `r${++this.n}`;
    this.server.handleChunk(`${JSON.stringify({ id, method, params })}\n`);
    return this.waitFor((f) => f.id === id);
  }

  async start(workspaceRoot: string, checkCommand: string): Promise<string> {
    await this.request("mission.Missions.subscribe", {});
    const res = await this.request("mission.Missions.start", {
      workspaceRoot,
      title: "trust",
      initialQuery: "q",
      checkCommand,
    });
    assert.equal(res.error, undefined);
    return res.result.missionId;
  }

  async status(missionId: string): Promise<string> {
    // Before the first event is on disk the mission does not exist yet and get answers an error.
    return (await this.request("mission.Missions.get", { missionId })).result?.status ?? "";
  }

  async waitStatus(missionId: string, want: string[]): Promise<string> {
    const deadline = Date.now() + 20_000;
    let s = "";
    while (Date.now() < deadline) {
      s = await this.status(missionId);
      if (want.includes(s)) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`status ${s}, wanted ${want}`);
  }

  async events(missionId: string): Promise<SessionEvent[]> {
    return new EventLogReader(path.join(this.base, "missions", missionId)).readAll();
  }

  async needsYou(missionId: string): Promise<Frame> {
    return this.waitFor((f) => f.event === "mission.Missions.needsYou" && f.data?.missionId === missionId);
  }

  async close(): Promise<void> {
    await this.server.close();
    fs.rmSync(this.base, { recursive: true, force: true });
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** A git shim first on PATH: records every invocation, then runs the real git. */
function installGitShim(dir: string): { log: string; restore: () => void } {
  const realGit = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"].find((p) => fs.existsSync(p)) ?? "git";
  const bin = path.join(dir, "shim-bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev}`;
  return { log, restore: () => void (process.env.PATH = prev) };
}

const touch = (file: string) => `node -e "require('fs').writeFileSync('${file}','x')"`;

describe("folder trust gate in the mission runner", () => {
  it("runs no command (not even git) before the answer, then runs after a trusted answer", async () => {
    const h = new Harness();
    const shim = installGitShim(h.root);
    try {
      const ws = h.folder("ws");
      const marker = path.join(ws, "marker");
      const missionId = await h.start(ws, touch(marker));
      const q = await h.needsYou(missionId);
      assert.equal(q.data.question, "folder-trust");
      assert.equal(q.data.folder, fs.realpathSync.native(ws));
      assert.equal(await h.status(missionId), "needs-you");
      await new Promise((r) => setTimeout(r, 200));
      const events = await h.events(missionId);
      assert.equal(events.filter((e) => e.kind === "node.started").length, 0);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(shim.log), false, "git must not run on an unanswered folder");
      assert.equal(await h.status(missionId), "needs-you");

      const ans = await h.request("inbox.Approvals.answer", { missionId, level: "trusted", epoch: q.data.epoch });
      assert.equal(ans.error, undefined);
      assert.equal(await h.waitStatus(missionId, ["verified", "failed"]), "verified");
      assert.equal(fs.existsSync(marker), true);
      assert.equal(await h.store.getLevel(ws), "trusted");
      assert.ok(fs.existsSync(shim.log), "the git shim is live: after trust, treeOf does call git");
    } finally {
      shim.restore();
      await h.close();
    }
  });

  it("an untrusted answer stops the mission with folder-untrusted before any node or command", async () => {
    const h = new Harness();
    const shim = installGitShim(h.root);
    try {
      const ws = h.folder("ws");
      const marker = path.join(ws, "marker");
      const missionId = await h.start(ws, touch(marker));
      const q = await h.needsYou(missionId);
      await h.request("inbox.Approvals.answer", { missionId, level: "untrusted", epoch: q.data.epoch });
      assert.equal(await h.waitStatus(missionId, ["stopped", "verified", "failed"]), "stopped");
      const events = await h.events(missionId);
      const last = events[events.length - 1];
      assert.equal(last.kind, "mission.stopped");
      assert.equal(last.data.reason, "folder-untrusted");
      assert.equal(events.filter((e) => e.kind === "node.started").length, 0);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(shim.log), false);
      assert.equal(await h.store.getLevel(ws), "untrusted");
    } finally {
      shim.restore();
      await h.close();
    }
  });

  it("a stored trusted folder skips the question; a stored untrusted folder stops without asking", async () => {
    const h = new Harness();
    try {
      const a = h.folder("a");
      const b = h.folder("b");
      await h.store.setLevel(a, "trusted");
      const idA = await h.start(a, touch(path.join(a, "marker")));
      assert.equal(await h.waitStatus(idA, ["verified", "failed"]), "verified");
      assert.equal((await h.events(idA)).filter((e) => e.kind === "mission.needs-you").length, 0);

      await h.store.setLevel(b, "untrusted");
      const idB = await h.start(b, touch(path.join(b, "marker")));
      assert.equal(await h.waitStatus(idB, ["stopped", "verified", "failed"]), "stopped");
      const eventsB = await h.events(idB);
      assert.equal(eventsB.filter((e) => e.kind === "mission.needs-you").length, 0);
      assert.equal(eventsB[eventsB.length - 1].data.reason, "folder-untrusted");
      assert.equal(fs.existsSync(path.join(b, "marker")), false);
    } finally {
      await h.close();
    }
  });

  it("cancelling while parked stops the mission and leaves no marker", async () => {
    const h = new Harness();
    try {
      const ws = h.folder("ws");
      const marker = path.join(ws, "marker");
      const missionId = await h.start(ws, touch(marker));
      await h.needsYou(missionId);
      await h.request("mission.Missions.cancel", { missionId });
      assert.equal(await h.waitStatus(missionId, ["stopped", "verified", "failed"]), "stopped");
      const events = await h.events(missionId);
      assert.equal(events[events.length - 1].data.reason, "cancelled");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(await h.store.getLevel(ws), "prompt");
    } finally {
      await h.close();
    }
  });

  it("server.close() waits for a cancelled, parked mission to finish writing its STOPPED event", async () => {
    const h = new Harness();
    try {
      const ws = h.folder("ws");
      const missionId = await h.start(ws, touch(path.join(ws, "marker")));
      await h.needsYou(missionId);
      await h.server.close();
      // Nothing may still be appending to missions/ once close() has resolved.
      const events = await h.events(missionId);
      assert.equal(events[events.length - 1].kind, "mission.stopped");
      assert.equal(events[events.length - 1].data.reason, "cancelled");
      const size = fs.readdirSync(path.join(h.base, "missions", missionId)).length;
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(fs.readdirSync(path.join(h.base, "missions", missionId)).length, size);
    } finally {
      await h.close();
    }
  });

  it("a stale answer is rejected with 4001 and the mission stays parked; the fresh epoch is accepted", async () => {
    const h = new Harness();
    try {
      const ws = h.folder("ws");
      const marker = path.join(ws, "marker");
      const missionId = await h.start(ws, touch(marker));
      const q = await h.needsYou(missionId);
      const old = q.data.epoch as number;
      const g = await h.grants.addGrant({ tool: "exec_command", scope: "git *", lifetime: "always" });
      await h.grants.revokeGrant(g.id);
      const stale = await h.request("inbox.Approvals.answer", { missionId, level: "trusted", epoch: old });
      assert.equal(stale.error?.code, 4001);
      const missing = await h.request("inbox.Approvals.answer", { missionId, level: "trusted" });
      assert.equal(missing.error?.code, 4001);
      assert.equal(await h.status(missionId), "needs-you");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(await h.store.getLevel(ws), "prompt");

      const ok = await h.request("inbox.Approvals.answer", { missionId, level: "trusted", epoch: old + 1 });
      assert.equal(ok.error, undefined);
      assert.equal(await h.waitStatus(missionId, ["verified", "failed"]), "verified");
    } finally {
      await h.close();
    }
  });

  it("trust never crosses a symlink: U/link -> T (trusted) still asks for U, and does not ask for U/link", async () => {
    const h = new Harness();
    try {
      const t = h.folder("T");
      const u = h.folder("U");
      fs.symlinkSync(t, path.join(u, "link"));
      await h.store.setLevel(t, "trusted");

      const viaU = await h.start(u, touch(path.join(u, "marker")));
      await h.needsYou(viaU);
      assert.equal(await h.status(viaU), "needs-you");
      assert.equal(fs.existsSync(path.join(u, "marker")), false);

      const viaLink = await h.start(path.join(u, "link"), touch(path.join(t, "marker2")));
      assert.equal(await h.waitStatus(viaLink, ["verified", "failed"]), "verified");
      assert.equal((await h.events(viaLink)).filter((e) => e.kind === "mission.needs-you").length, 0);
    } finally {
      await h.close();
    }
  });
});
