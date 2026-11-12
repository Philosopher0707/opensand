import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildBwrapArgs } from "../src/sandbox/linux-bwrap.js";
import { resolveSandboxLauncher } from "../src/sandbox/launcher.js";
import { DENIED_SECRET_REL_PATHS } from "../src/sandbox/constants.js";

const HOME = "/home/tester";
const WS = "/work/project";
const TMP = "/work/session-tmp";

/** Index of the first `flag a b` triple, or -1. */
function indexOfTriple(args: string[], flag: string, a: string, b: string): number {
  for (let i = 0; i + 2 < args.length; i++) {
    if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return i;
  }
  return -1;
}

/** Index of the first `--tmpfs target` or `--ro-bind /dev/null target` overlay, or -1. */
function indexOfOverlay(args: string[], target: string): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tmpfs" && args[i + 1] === target) return i;
    if (args[i] === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2] === target) return i;
  }
  return -1;
}

const PROFILES = ["workspace-write", "read-only", "full"] as const;

describe("buildBwrapArgs", () => {
  for (const profile of PROFILES) {
    for (const allowNetwork of [false, true]) {
      it(`${profile}, allowNetwork=${allowNetwork}: namespaces are unshared and network is cut unless allowed`, () => {
        const args = buildBwrapArgs({
          workspaceRoot: WS,
          homeDir: HOME,
          profile,
          allowNetwork,
          exists: () => false,
          isDir: () => false,
        });
        for (const flag of ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]) {
          assert.ok(args.includes(flag), `${profile} must include ${flag}`);
        }
        assert.equal(args.includes("--unshare-net"), !allowNetwork);
      });
    }
  }

  it("workspace-write binds the workspace writable on top of a read-only root", () => {
    const args = buildBwrapArgs({ workspaceRoot: WS, homeDir: HOME, exists: () => false, isDir: () => false });
    assert.ok(indexOfTriple(args, "--ro-bind", "/", "/") >= 0, "root must be read-only");
    assert.ok(indexOfTriple(args, "--bind", WS, WS) >= 0, "workspace must be bound writable");
    assert.ok(indexOfTriple(args, "--ro-bind", "/", "/") < indexOfTriple(args, "--bind", WS, WS));
  });

  it("read-only has no writable workspace bind", () => {
    const args = buildBwrapArgs({
      workspaceRoot: WS,
      homeDir: HOME,
      profile: "read-only",
      exists: () => false,
      isDir: () => false,
    });
    assert.ok(indexOfTriple(args, "--ro-bind", "/", "/") >= 0);
    assert.equal(indexOfTriple(args, "--bind", WS, WS), -1, "read-only must not bind the workspace");
  });

  it("full binds the root writable and keeps the workspace under it", () => {
    const args = buildBwrapArgs({ workspaceRoot: WS, homeDir: HOME, profile: "full", exists: () => false, isDir: () => false });
    assert.ok(indexOfTriple(args, "--bind", "/", "/") >= 0);
    assert.equal(indexOfTriple(args, "--ro-bind", "/", "/"), -1);
  });

  it("binds the temp dir writable when one is given", () => {
    const args = buildBwrapArgs({
      workspaceRoot: WS,
      homeDir: HOME,
      tempDir: TMP,
      exists: () => false,
      isDir: () => false,
    });
    assert.ok(indexOfTriple(args, "--bind", TMP, TMP) >= 0);
    assert.ok(args.includes("--tmpfs") && args.includes("/tmp"), "/tmp is a private tmpfs");
  });

  it("binds only the cache dirs that exist", () => {
    const present = new Set([path.join(HOME, ".npm")]);
    const args = buildBwrapArgs({
      workspaceRoot: WS,
      homeDir: HOME,
      exists: (p) => present.has(p),
      isDir: () => true,
    });
    assert.ok(indexOfTriple(args, "--bind", path.join(HOME, ".npm"), path.join(HOME, ".npm")) >= 0);
    assert.equal(indexOfTriple(args, "--bind", path.join(HOME, ".cache"), path.join(HOME, ".cache")), -1);
  });

  it("secret overlays come after every bind, so nothing re-exposes them", () => {
    const args = buildBwrapArgs({
      workspaceRoot: WS,
      homeDir: HOME,
      tempDir: TMP,
      exists: () => true,
      isDir: () => true,
    });
    const workspaceBind = indexOfTriple(args, "--bind", WS, WS);
    const tempBind = indexOfTriple(args, "--bind", TMP, TMP);
    assert.ok(workspaceBind >= 0 && tempBind >= 0);
    for (const rel of DENIED_SECRET_REL_PATHS) {
      const overlay = indexOfOverlay(args, path.join(HOME, rel));
      assert.ok(overlay >= 0, `${rel} must have an overlay`);
      assert.ok(overlay > workspaceBind, `${rel} overlay must come after the workspace bind`);
      assert.ok(overlay > tempBind, `${rel} overlay must come after the temp bind`);
    }
  });

  it("hides secret directories as tmpfs and secret files by binding /dev/null over them", () => {
    const args = buildBwrapArgs({
      workspaceRoot: WS,
      homeDir: HOME,
      exists: (p) => p === path.join(HOME, ".ssh") || p === path.join(HOME, ".netrc"),
      isDir: (p) => p === path.join(HOME, ".ssh"),
    });
    const sshAt = indexOfOverlay(args, path.join(HOME, ".ssh"));
    const netrcAt = indexOfOverlay(args, path.join(HOME, ".netrc"));
    assert.notEqual(sshAt, -1, ".ssh directory must be overlaid");
    assert.equal(args[sshAt], "--tmpfs");
    assert.notEqual(netrcAt, -1, ".netrc file must be overlaid");
    assert.equal(args[netrcAt], "--ro-bind");
  });

  it("adds no secret overlay for a secret path that does not exist", () => {
    const args = buildBwrapArgs({ workspaceRoot: WS, homeDir: HOME, exists: () => false, isDir: () => false });
    for (const rel of DENIED_SECRET_REL_PATHS) {
      assert.equal(indexOfOverlay(args, path.join(HOME, rel)), -1, `${rel} must not be overlaid when absent`);
    }
  });
});

describe("resolveSandboxLauncher", () => {
  const present = (...paths: string[]) => {
    const set = new Set(paths);
    return (p: string) => set.has(p);
  };

  it("darwin uses sandbox-exec when it is present, and is unavailable without it", () => {
    assert.deepEqual(resolveSandboxLauncher("darwin", {}, present("/usr/bin/sandbox-exec")), {
      kind: "sandbox-exec",
      path: "/usr/bin/sandbox-exec",
    });
    const missing = resolveSandboxLauncher("darwin", {}, present());
    assert.equal(missing.kind, "unavailable");
  });

  it("linux prefers /usr/bin/bwrap, then falls back to /bin/bwrap", () => {
    assert.deepEqual(resolveSandboxLauncher("linux", {}, present("/usr/bin/bwrap", "/bin/bwrap")), {
      kind: "bwrap",
      path: "/usr/bin/bwrap",
    });
    assert.deepEqual(resolveSandboxLauncher("linux", {}, present("/bin/bwrap")), {
      kind: "bwrap",
      path: "/bin/bwrap",
    });
  });

  it("linux is unavailable when no bwrap binary exists", () => {
    assert.equal(resolveSandboxLauncher("linux", {}, present()).kind, "unavailable");
  });

  it("OPENSAND_BWRAP_PATH overrides the default search", () => {
    const env = { OPENSAND_BWRAP_PATH: "/opt/bwrap" };
    assert.deepEqual(resolveSandboxLauncher("linux", env, present("/opt/bwrap", "/usr/bin/bwrap")), {
      kind: "bwrap",
      path: "/opt/bwrap",
    });
  });

  it("an OPENSAND_BWRAP_PATH that is missing stays unavailable and does not fall back", () => {
    const env = { OPENSAND_BWRAP_PATH: "/opt/bwrap" };
    const result = resolveSandboxLauncher("linux", env, present("/usr/bin/bwrap"));
    assert.equal(result.kind, "unavailable");
    assert.match(result.kind === "unavailable" ? result.reason : "", /\/opt\/bwrap/);
  });

  for (const platform of ["win32", "freebsd"] as const) {
    it(`${platform} is never supported, even if a sandbox binary exists`, () => {
      const result = resolveSandboxLauncher(platform, {}, () => true);
      assert.equal(result.kind, "unavailable");
    });
  }
});
