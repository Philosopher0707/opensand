import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runCommandOperation } from "../src/command-runner.js";
import { resolveSandboxLauncher } from "../src/sandbox/launcher.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";

// Real bubblewrap needs Linux, a bwrap binary and unprivileged user namespaces. ubuntu-latest CI
// has no bwrap and AppArmor blocks user namespaces, so these run only where the probe succeeds.
function bwrapSkipReason(): string | false {
  if (process.platform !== "linux") return "bubblewrap tests run on Linux only";
  const launcher = resolveSandboxLauncher("linux", process.env);
  if (launcher.kind !== "bwrap") return "no bwrap binary found";
  const probe = spawnSync(launcher.path, ["--ro-bind", "/", "/", "true"], { encoding: "utf8" });
  if (probe.status !== 0) return `bwrap probe failed (user namespaces unavailable): ${probe.stderr.trim()}`;
  return false;
}

const skip = bwrapSkipReason();
if (skip) {
  console.log(`bubblewrap tests skipped: ${skip}`);
}

// Fixtures live outside /tmp: the sandbox mounts a private tmpfs over /tmp, so an "outside the
// workspace" folder there does not exist inside the sandbox and the write fails for the wrong
// reason. A hermetic test run often points HOME at a folder under /tmp, so fall back to /var/tmp.
function fixtureRoot(home: string = os.homedir()): string {
  const tmp = fs.realpathSync("/tmp");
  const real = fs.realpathSync(home);
  return real === tmp || real.startsWith(`${tmp}/`) ? "/var/tmp" : home;
}

function makeFixture(): { base: string; workspace: string; outside: string; home: string; tempDir: string } {
  const base = fs.mkdtempSync(path.join(fixtureRoot(), "sandbox_linux_test_"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  const home = path.join(base, "fake-home");
  const tempDir = path.join(base, "session-tmp");
  for (const dir of [workspace, outside, home, tempDir, path.join(home, ".ssh")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { base, workspace, outside, home, tempDir };
}

describe("bubblewrap fixture root", () => {
  it("keeps fixtures out of /tmp when HOME is under /tmp", () => {
    const home = fs.mkdtempSync("/tmp/sandbox_home_");
    try {
      assert.equal(fixtureRoot(home), "/var/tmp");
      assert.equal(fixtureRoot("/tmp"), "/var/tmp");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses HOME when it is outside /tmp", () => {
    assert.equal(fixtureRoot("/var"), "/var");
  });
});

const SECRET_MARKER = "SANDBOX_TEST_SECRET_MARKER_7f3a";

describe("bubblewrap containment", { skip: skip || false }, () => {
  it("writing outside the workspace fails and creates no file", async () => {
    const fx = makeFixture();
    try {
      const target = path.join(fx.outside, "escape.txt");
      const res = await runCommandOperation({
        command: `echo x > "${target}"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      assert.notEqual(res.exitCode, 0, "write outside the workspace must fail");
      assert.match(res.stderr, /Read-only file system|Operation not permitted|Permission denied/);
      assert.ok(!fs.existsSync(target), "file outside the workspace must not be created");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("secret files in the fake home cannot be read from inside the sandbox", async () => {
    const fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.home, ".ssh", "id_rsa"), SECRET_MARKER);
      fs.writeFileSync(path.join(fx.home, ".netrc"), SECRET_MARKER);
      const res = await runCommandOperation({
        command: `cat "${fx.home}/.ssh/id_rsa"; cat "${fx.home}/.netrc"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      assert.ok(!res.stdout.includes(SECRET_MARKER), "secret must not appear on stdout");
      assert.ok(!res.stderr.includes(SECRET_MARKER), "secret must not appear on stderr");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("writes inside the workspace and the temp dir succeed", async () => {
    const fx = makeFixture();
    try {
      const res = await runCommandOperation({
        command: `echo ok > "${fx.workspace}/inside.txt" && mktemp -p "${fx.tempDir}"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.ok(fs.existsSync(path.join(fx.workspace, "inside.txt")));
      assert.ok(fs.readdirSync(fx.tempDir).length > 0, "mktemp must create a file in the temp dir");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("a workspace reached through a symlink is writable by its canonical path", async () => {
    // Under /tmp on purpose: the sandbox mounts a private tmpfs over /tmp, so the canonical
    // path of the workspace is not there unless the profile binds it. A mission on a symlinked
    // folder addresses the workspace by its realpath.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox_linux_link_"));
    const target = path.join(base, "target");
    const link = path.join(base, "link");
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(target, link);
      const res = await runCommandOperation({
        command: `echo ok > "${path.join(target, "by-canonical-path.txt")}"`,
        cwd: link,
        workspaceRoot: link,
        sandboxProfile: "workspace-write",
      });
      assert.equal(res.exitCode, 0, res.stderr);
      assert.ok(fs.existsSync(path.join(target, "by-canonical-path.txt")));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("read-only profile refuses a write inside the workspace", async () => {
    const fx = makeFixture();
    try {
      const res = await runCommandOperation({
        command: `echo x > "${fx.workspace}/inside.txt"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "read-only",
      });
      assert.notEqual(res.exitCode, 0);
      assert.ok(!fs.existsSync(path.join(fx.workspace, "inside.txt")));
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("network is cut by default", async () => {
    const fx = makeFixture();
    try {
      const res = await runCommandOperation({
        command: "exec 3<>/dev/tcp/1.1.1.1/53",
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
        sandboxProfile: "workspace-write",
      });
      assert.notEqual(res.exitCode, 0, "outbound connection must fail without allowNetwork");
    } finally {
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("OPENSAND_SANDBOX=1 alone contains a command that was not given a profile", async () => {
    const fx = makeFixture();
    const previous = process.env.OPENSAND_SANDBOX;
    process.env.OPENSAND_SANDBOX = "1";
    try {
      const target = path.join(fx.outside, "env-escape.txt");
      const res = await runCommandOperation({
        command: `echo x > "${target}"`,
        cwd: fx.workspace,
        workspaceRoot: fx.workspace,
        homeDir: fx.home,
        tempDir: fx.tempDir,
      });
      assert.notEqual(res.exitCode, 0);
      assert.ok(!fs.existsSync(target));
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAND_SANDBOX;
      } else {
        process.env.OPENSAND_SANDBOX = previous;
      }
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });

  it("a bwrap that fails before the namespace is set up raises SandboxInitializationError", async () => {
    const fx = makeFixture();
    const fakeBwrap = path.join(fx.base, "fake-bwrap");
    fs.writeFileSync(fakeBwrap, "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });
    const previous = process.env.OPENSAND_BWRAP_PATH;
    process.env.OPENSAND_BWRAP_PATH = fakeBwrap;
    try {
      await assert.rejects(
        runCommandOperation({
          command: "true",
          cwd: fx.workspace,
          workspaceRoot: fx.workspace,
          homeDir: fx.home,
          tempDir: fx.tempDir,
          sandboxProfile: "workspace-write",
        }),
        (caught: unknown) => {
          assert.ok(caught instanceof SandboxInitializationError);
          assert.equal(caught.mechanism, "Linux bubblewrap");
          return true;
        }
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSAND_BWRAP_PATH;
      } else {
        process.env.OPENSAND_BWRAP_PATH = previous;
      }
      fs.rmSync(fx.base, { recursive: true, force: true });
    }
  });
});
