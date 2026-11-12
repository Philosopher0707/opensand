import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildSandboxedSpawn } from "../src/sandbox/spawn-builder.js";
import { SandboxInitializationError } from "../src/sandbox/errors.js";

const HOME = "/home/tester";
const WS = "/work/project";
const TMP = "/work/session-tmp";

/** Fake exists: bwrap is assumed present on linux, sandbox-exec present on darwin. */
function fakeExists(platform: "linux" | "darwin") {
  return (p: string) => {
    if (platform === "linux") return p === "/usr/bin/bwrap";
    return p === "/usr/bin/sandbox-exec";
  };
}

describe("buildSandboxedSpawn", () => {
  it("darwin + workspace-write: generates sandbox-exec with -p profile and target command", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "workspace-write",
      platform: "darwin",
      env: {},
      exists: fakeExists("darwin"),
    });
    assert.equal(config.isSandboxed, true);
    assert.equal(config.isSandboxExec, true);
    assert.equal(config.isBwrap, false);
    assert.equal(config.command, "/usr/bin/sandbox-exec");
    assert.ok(config.args[0] === "-p", "first arg must be -p");
    assert.match(config.args[1], /^\(version 1\)/);
    assert.ok(config.args.includes("echo hello"), "target command must be present");
  });

  it("linux + workspace-write: generates bwrap with -- delimiter and omits --info-fd 3 when useInfoFd is false", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      tempDir: TMP,
      sandboxProfile: "workspace-write",
      platform: "linux",
      env: {},
      exists: fakeExists("linux"),
    });
    assert.equal(config.isSandboxed, true);
    assert.equal(config.isBwrap, true);
    assert.equal(config.isSandboxExec, false);
    assert.equal(config.command, "/usr/bin/bwrap");
    assert.ok(!config.args.includes("--info-fd"), "--info-fd must be omitted for PTY");
    assert.ok(config.args.includes("--"), "-- delimiter must separate bwrap flags from target");
    assert.ok(config.args.includes("echo hello") || config.args.includes("--"));
  });

  it("linux + useInfoFd: appends --info-fd 3 and sets infoFd: 3", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "workspace-write",
      platform: "linux",
      env: {},
      exists: () => true,
      useInfoFd: true,
    });
    assert.ok(config.args.includes("--info-fd"));
    assert.equal(config.infoFd, 3);
    assert.ok(config.args.includes("3"));
  });

  it("full profile: binds root writable", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "full",
      platform: "linux",
      env: {},
      exists: fakeExists("linux"),
    });
    assert.ok(config.args.includes("--bind"));
    assert.ok(config.args.includes("/"));
  });

  it("read-only profile: no writable workspace bind", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "read-only",
      platform: "linux",
      env: {},
      exists: fakeExists("linux"),
    });
    assert.ok(config.args.includes("--ro-bind"));
    assert.equal(config.args.indexOf("--bind"), -1);
  });

  it("network cut: includes --unshare-net when allowNetwork is false", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "workspace-write",
      allowNetwork: false,
      platform: "linux",
      env: {},
      exists: fakeExists("linux"),
    });
    assert.ok(config.args.includes("--unshare-net"));
  });

  it("network allowed: omits --unshare-net", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "workspace-write",
      allowNetwork: true,
      platform: "linux",
      env: {},
      exists: fakeExists("linux"),
    });
    assert.equal(config.args.indexOf("--unshare-net"), -1);
  });

  it("secret overlays are present and positioned after directory binds", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      tempDir: TMP,
      sandboxProfile: "workspace-write",
      platform: "linux",
      env: {},
      exists: () => true,
    });
    const wsBind = config.args.indexOf("--bind");
    const wsBindIdx = config.args.findIndex((a, i) => a === "--bind" && config.args[i + 1] === WS);
    const overlayIdx = config.args.findIndex((a, i) => a === "--tmpfs" && config.args[i + 1] === path.join(HOME, ".ssh"));
    assert.ok(wsBindIdx >= 0, "workspace bind must exist");
    assert.ok(overlayIdx >= 0, ".ssh tmpfs overlay must exist");
    assert.ok(overlayIdx > wsBindIdx, "secret overlay must come after workspace bind");
  });

  it("platform with missing launcher throws SandboxInitializationError with code SANDBOX_UNAVAILABLE", () => {
    assert.throws(
      () =>
        buildSandboxedSpawn({
          command: "echo hello",
          cwd: WS,
          workspaceRoot: WS,
          homeDir: HOME,
          sandboxProfile: "workspace-write",
          platform: "win32",
          env: {},
          exists: () => false,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.equal((err as SandboxInitializationError).code, "SANDBOX_UNAVAILABLE");
        return true;
      }
    );
  });

  it("linux with customProfileString throws SandboxInitializationError (macOS-only)", () => {
    assert.throws(
      () =>
        buildSandboxedSpawn({
          command: "echo hello",
          cwd: WS,
          workspaceRoot: WS,
          homeDir: HOME,
          customProfileString: "(version 1)(allow default)",
          platform: "linux",
          env: {},
          exists: () => true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof SandboxInitializationError);
        assert.equal((err as SandboxInitializationError).message.includes("macOS-only"), true);
        return true;
      }
    );
  });

  it("no sandbox requested: returns target command directly with isSandboxed false", () => {
    const config = buildSandboxedSpawn({
      command: "echo",
      args: ["hello"],
      cwd: WS,
      platform: "linux",
      env: {},
      exists: () => false,
    });
    assert.equal(config.isSandboxed, false);
    assert.equal(config.isBwrap, false);
    assert.equal(config.isSandboxExec, false);
    assert.equal(config.command, "echo");
    assert.deepEqual(config.args, ["hello"]);
  });

  it("command with spaces and no args: normalizes to /bin/bash -c", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello world",
      cwd: WS,
      platform: "linux",
      env: {},
      exists: () => false,
    });
    assert.equal(config.command, "/bin/bash");
    assert.deepEqual(config.args, ["-c", "echo hello world"]);
  });

  it("darwin missing launcher throws unavailable even when sandbox-exec path does not exist", () => {
    const config = () =>
      buildSandboxedSpawn({
        command: "echo hello",
        cwd: WS,
        workspaceRoot: WS,
        homeDir: HOME,
        sandboxProfile: "workspace-write",
        platform: "darwin",
        env: {},
        exists: () => false,
      });
    assert.throws(config, SandboxInitializationError);
  });

  it("uses OPENSAND_BWRAP_PATH override on linux", () => {
    const config = buildSandboxedSpawn({
      command: "echo hello",
      cwd: WS,
      workspaceRoot: WS,
      homeDir: HOME,
      sandboxProfile: "workspace-write",
      platform: "linux",
      env: { OPENSAND_BWRAP_PATH: "/opt/custom-bwrap" },
      exists: (p) => p === "/opt/custom-bwrap",
    });
    assert.equal(config.command, "/opt/custom-bwrap");
    assert.equal(config.isBwrap, true);
  });
});
