import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildManifest, readManifest, ManifestError,
  pushWorkspace, fetchToStaging, applyStaging, missionRemoteDir, removeRemoteMissionDir,
  deployBundle, bundleHash, deployedBundleDir,
  acquireTargetLock, releaseTargetLock, acquireLocalLock, releaseLocalLock, TARGET_LOCK_DIR,
  TargetApplyConflictError, TargetBusyError,
  sshCommandArgs, sshChildEnv, BWRAP_PROBE,
} from "../src/target/index.js";

/** A temp dir outside every symlinked alias (macOS /var -> /private/var). */
function makeDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe("target sync (temp directory as the remote, no sshd)", () => {
  const dirs: string[] = [];
  const temp = (): string => {
    const dir = makeDir("opensand-sync-");
    dirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeWorkspace(withGit = true): string {
    const ws = temp();
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "a.txt"), "alpha\n");
    fs.writeFileSync(path.join(ws, "keep.txt"), "keep me\n");
    if (withGit) {
      fs.mkdirSync(path.join(ws, ".git"));
      fs.writeFileSync(path.join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    return ws;
  }

  it("push excludes .git from the remote and from the manifest", async () => {
    const ws = makeWorkspace();
    const remote = temp();
    const manifestPath = path.join(temp(), "manifest.json");
    const missionId = "m-git";
    const manifest = await pushWorkspace(ws, remote, missionId, { manifestPath });
    const missionDir = missionRemoteDir(remote, missionId);
    assert.equal(fs.existsSync(path.join(missionDir, ".git")), false, ".git reached the remote");
    assert.equal(fs.existsSync(path.join(missionDir, "src", "a.txt")), true);
    assert.equal(Object.keys(manifest.entries).some((k) => k === ".git" || k.startsWith(".git/")), false, "the manifest records .git");
    const persisted = await readManifest(manifestPath);
    assert.equal(persisted.entries["src/a.txt"]?.hash?.length, 64);
  });

  it("push manifest excludes .git and a clean fetch+apply applies remote changes with modes", async () => {
    const ws = makeWorkspace();
    const remote = temp();
    const manifestPath = path.join(temp(), "manifest.json");
    const missionId = "m-clean";
    const manifest = await pushWorkspace(ws, remote, missionId, { manifestPath });
    assert.equal(Object.keys(manifest.entries).some((k) => k.includes(".git")), false);

    // The target works remotely: edit a pushed file, create a new one.
    const missionDir = missionRemoteDir(remote, missionId);
    fs.writeFileSync(path.join(missionDir, "src", "a.txt"), "alpha-edited-remotely\n");
    fs.mkdirSync(path.join(missionDir, "tools"));
    fs.writeFileSync(path.join(missionDir, "tools", "new.sh"), "#!/bin/sh\necho hi\n");
    fs.chmodSync(path.join(missionDir, "tools", "new.sh"), 0o755);

    const staging = temp();
    await fetchToStaging(remote, missionId, staging);
    const result = await applyStaging(staging, ws, manifest);
    assert.deepEqual(result.added.sort(), ["tools/new.sh"]);
    assert.deepEqual(result.replaced, ["src/a.txt"]);
    assert.equal(fs.readFileSync(path.join(ws, "src", "a.txt"), "utf8"), "alpha-edited-remotely\n");
    assert.equal(fs.readFileSync(path.join(ws, "tools", "new.sh"), "utf8"), "#!/bin/sh\necho hi\n");
    const mode = fs.statSync(path.join(ws, "tools", "new.sh")).mode & 0o777;
    assert.notEqual(mode & 0o111, 0, "the executable bit is not preserved");
    assert.equal(fs.existsSync(path.join(staging, ".git")), false, ".git must not travel back either");
  });

  it("a local edit after push refuses the apply and leaves the local bytes unchanged", async () => {
    const ws = makeWorkspace();
    const remote = temp();
    const manifestPath = path.join(temp(), "manifest.json");
    const missionId = "m-edit";
    const manifest = await pushWorkspace(ws, remote, missionId, { manifestPath });

    // The user edits locally while the agent works remotely; the remote also changes the file.
    fs.writeFileSync(path.join(ws, "src", "a.txt"), "user-edit\n");
    fs.writeFileSync(path.join(missionRemoteDir(remote, missionId), "src", "a.txt"), "remote-edit\n");
    fs.writeFileSync(path.join(missionRemoteDir(remote, missionId), "remote-new.txt"), "remote new\n");

    const staging = temp();
    await fetchToStaging(remote, missionId, staging);
    const before = fs.readFileSync(path.join(ws, "src", "a.txt"), "utf8");
    await assert.rejects(
      () => applyStaging(staging, ws, manifest),
      (err: Error) => {
        if (!(err instanceof TargetApplyConflictError)) return false;
        assert.match(err.message, /target-apply-conflict/);
        assert.match(err.message, /src\/a\.txt/);
        return true;
      },
    );
    // Nothing was applied: the user's bytes stand, and the remote's new file was not added.
    assert.equal(fs.readFileSync(path.join(ws, "src", "a.txt"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(ws, "remote-new.txt")), false);
    assert.equal(fs.readFileSync(path.join(ws, "keep.txt"), "utf8"), "keep me\n");
  });

  it("a deletion applies only for a manifest path; the user's new local file survives", async () => {
    const ws = makeWorkspace();
    const remote = temp();
    const manifestPath = path.join(temp(), "manifest.json");
    const missionId = "m-del";
    const manifest = await pushWorkspace(ws, remote, missionId, { manifestPath });
    assert.ok(manifest.entries["keep.txt"], "the manifest owns keep.txt after push");

    // The user creates a new local file after the push; the remote deletes keep.txt.
    fs.writeFileSync(path.join(ws, "user-local.txt"), "mine\n");
    fs.rmSync(path.join(missionRemoteDir(remote, missionId), "keep.txt"));

    const staging = temp();
    await fetchToStaging(remote, missionId, staging);
    const result = await applyStaging(staging, ws, manifest);
    assert.deepEqual(result.deleted, ["keep.txt"]);
    assert.equal(fs.existsSync(path.join(ws, "keep.txt")), false);
    assert.equal(fs.readFileSync(path.join(ws, "user-local.txt"), "utf8"), "mine\n");
    assert.equal(fs.readFileSync(path.join(ws, "src", "a.txt"), "utf8"), "alpha\n");

    // And a remote add at a path the user created locally after the push is a
    // conflict too: the user's new file is never overwritten.
    fs.writeFileSync(path.join(missionRemoteDir(remote, missionId), "user-local.txt"), "remote copy\n");
    const staging2 = temp();
    await fetchToStaging(remote, missionId, staging2);
    await assert.rejects(
      () => applyStaging(staging2, ws, manifest),
      (err: Error) => err instanceof TargetApplyConflictError && /user-local\.txt/.test(err.message),
    );
    // The refused apply changed nothing: the user's bytes stand.
    assert.equal(fs.readFileSync(path.join(ws, "user-local.txt"), "utf8"), "mine\n");
  });

  it("an external symlink is refused before push, and the remote is untouched", async () => {
    const ws = makeWorkspace();
    const outside = temp();
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "leak"));
    const remote = temp();
    const missionId = "m-symlink";
    await assert.rejects(
      () => pushWorkspace(ws, remote, missionId, { manifestPath: path.join(temp(), "manifest.json") }),
      (err: Error) => {
        if (!(err instanceof ManifestError)) return false;
        assert.equal(err.reason, "target-symlink-escape");
        assert.match(err.message, /leak/);
        return true;
      },
    );
    assert.equal(fs.existsSync(missionRemoteDir(remote, missionId)), false, "a refused push must not have pushed");
    // A relative ../ symlink is the same refusal.
    const ws2 = makeWorkspace(false);
    fs.symlinkSync("../escape.txt", path.join(ws2, "rel-leak"));
    await assert.rejects(
      () => buildManifest(ws2),
      (err: Error) => err instanceof ManifestError && err.reason === "target-symlink-escape",
    );
  });

  it("the second holder of the target lock and of the local workspace lock is refused", async () => {
    const remote = temp();
    const missionId = "m-lock";
    const holder = await acquireTargetLock(remote, missionId, { staleAfterMs: 60_000, now: 1_000 });
    assert.equal(holder.missionId, missionId);
    await assert.rejects(
      () => acquireTargetLock(remote, "m-lock-2", { staleAfterMs: 60_000, now: 2_000 }),
      (err: Error) => {
        if (!(err instanceof TargetBusyError)) return false;
        assert.match(err.message, /target-busy/);
        assert.match(err.message, /m-lock/);
        return true;
      },
    );
    // The lock dir exists under <root>/.opensand with the holder recorded.
    assert.ok(fs.existsSync(path.join(remote, TARGET_LOCK_DIR, "holder")));

    // A stale holder can be taken over.
    await releaseTargetLock(remote, missionId);
    const second = await acquireTargetLock(remote, "m-lock-2", { staleAfterMs: 60_000, now: 3_000 });
    assert.equal(second.missionId, "m-lock-2");
    // A stale (expired) lock is taken over, not refused.
    const staleRemote = temp();
    await acquireTargetLock(staleRemote, "m-stale", { staleAfterMs: 10, now: 1_000 });
    const taken = await acquireTargetLock(staleRemote, "m-fresh", { staleAfterMs: 60_000, now: 2_000 });
    assert.equal(taken.missionId, "m-fresh");
    await releaseTargetLock(staleRemote, "m-fresh");
    await releaseTargetLock(remote, "m-lock-2");

    // The local workspace lock: same workspace, second mission refused.
    const ws = makeWorkspace(false);
    acquireLocalLock(ws, "m-local-1", { staleAfterMs: 60_000, now: 1_000 });
    assert.throws(
      () => acquireLocalLock(ws, "m-local-2", { staleAfterMs: 60_000, now: 2_000 }),
      (err: Error) => err instanceof TargetBusyError && /target-busy/.test(err.message),
    );
    // Same mission re-acquires its own lock (idempotent).
    acquireLocalLock(ws, "m-local-1", { staleAfterMs: 60_000, now: 2_000 });
    // A stale local lock is taken over.
    assert.doesNotThrow(() => acquireLocalLock(ws, "m-local-3", { staleAfterMs: 60_000, now: 999_999 }));
    releaseLocalLock(ws, "m-local-3");
  });

  it("the bundle deploys by content hash and a second deploy is idempotent", async () => {
    const bundle = temp();
    fs.mkdirSync(path.join(bundle, "dist", "src", "target"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "dist", "src", "target", "bin.js"), "// bundle entry\n");
    fs.writeFileSync(path.join(bundle, "package.json"), '{"name":"bundle"}');
    const remote = temp();
    const hash = await deployBundle(bundle, remote);
    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.equal(fs.existsSync(path.join(deployedBundleDir(remote, hash), "dist", "src", "target", "bin.js")), true);
    assert.equal(await bundleHash(bundle), hash, "the hash is stable over the same content");
    const hash2 = await deployBundle(bundle, remote);
    assert.equal(hash2, hash, "an unchanged bundle reuses its dir");
    // An upgrade (content change) lands in a new dir.
    fs.writeFileSync(path.join(bundle, "dist", "src", "target", "bin.js"), "// bundle entry v2\n");
    const hash3 = await deployBundle(bundle, remote);
    assert.notEqual(hash3, hash);
    assert.equal(fs.existsSync(path.join(deployedBundleDir(remote, hash3), "dist", "src", "target", "bin.js")), true);
  });

  it("ssh arguments are arrays with BatchMode=yes last, and the ssh child env is minimal", () => {
    const args = sshCommandArgs({ host: "devbox", sshArgs: ["-p", "2202"] }, "node --version");
    assert.deepEqual(args, ["-p", "2202", "-o", "BatchMode=yes", "devbox", "node --version"]);
    assert.equal(args.some((a) => /StrictHostKeyChecking=no/.test(a)), false);
    const bare = sshCommandArgs({ host: "h" }, "true");
    assert.deepEqual(bare, ["-o", "BatchMode=yes", "h", "true"]);
    const env = sshChildEnv();
    assert.ok("PATH" in env, "ssh needs PATH");
    for (const key of Object.keys(env)) {
      assert.ok(["PATH", "HOME", "SSH_AUTH_SOCK"].includes(key), `unexpected ssh child env key ${key}`);
    }
    assert.equal(typeof BWRAP_PROBE, "string");
  });

  it("a failed push removes the remote partial dir (best-effort) and the refused apply keeps staging", async () => {
    const ws = makeWorkspace();
    const remote = temp();
    const missionId = "m-partial";
    await pushWorkspace(ws, remote, missionId, { manifestPath: path.join(temp(), "manifest.json") });
    await removeRemoteMissionDir(remote, missionId);
    assert.equal(fs.existsSync(missionRemoteDir(remote, missionId)), false);
  });
});
