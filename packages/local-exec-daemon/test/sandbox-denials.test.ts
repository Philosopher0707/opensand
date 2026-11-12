import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSandboxDenials } from "../src/sandbox/denials.js";
import { runCommandOperation } from "../src/command-runner.js";
import { ToolRegistry } from "../src/tool-registry.js";

const isDarwin = process.platform === "darwin";

describe("parseSandboxDenials", () => {
  // Lines captured from real sandbox-exec runs on macOS 26 (bash, touch, mkdir, cp, python3, git, node, curl).
  const stderr = [
    "/bin/bash: /private/tmp/out/a.txt: Operation not permitted",
    "touch: ../out/b: Operation not permitted",
    "mkdir: ../out/c: Operation not permitted",
    "PermissionError: [Errno 1] Operation not permitted: '/private/tmp/out/e'",
    "fatal: cannot mkdir ../out/g: Operation not permitted",
    "Error: EPERM: operation not permitted, open '/private/tmp/out/n'",
    "curl: (6) Could not resolve host: example.com",
    "touch: ../out/b: Operation not permitted",
    "ordinary error output",
  ].join("\n");

  it("reads each tool's format, resolves paths against cwd and dedupes", () => {
    const denials = parseSandboxDenials(stderr, { cwd: "/private/tmp/ws", networkDenied: true });
    assert.deepEqual(
      denials.map((d) => d.path ?? d.kind),
      [
        "/private/tmp/out/a.txt",
        "/private/tmp/out/b",
        "/private/tmp/out/c",
        "/private/tmp/out/e",
        "/private/tmp/out/g",
        "/private/tmp/out/n",
        "network",
      ]
    );
    assert.equal(denials[1].detail, "touch: ../out/b: Operation not permitted");
  });

  it("reads bubblewrap's read-only file system errors", () => {
    const denials = parseSandboxDenials(
      [
        "/bin/bash: /etc/x: Read-only file system",
        "PermissionError: [Errno 30] Read-only file system: '/usr/y'",
        "Error: EROFS: read-only file system, open '/opt/z'",
      ].join("\n"),
      { cwd: "/w", networkDenied: false }
    );
    assert.deepEqual(denials.map((d) => d.path), ["/etc/x", "/usr/y", "/opt/z"]);
  });

  it("does not call a DNS failure a sandbox denial when network was allowed", () => {
    const denials = parseSandboxDenials("curl: (6) Could not resolve host: example.com", {
      cwd: "/",
      networkDenied: false,
    });
    assert.deepEqual(denials, []);
  });

  it("caps the list at 20", () => {
    const many = Array.from({ length: 50 }, (_, i) => `touch: f${i}: Operation not permitted`).join("\n");
    assert.equal(parseSandboxDenials(many, { cwd: "/w", networkDenied: false }).length, 20);
  });
});

describe("sandboxed exec_command reports denials", { skip: !isDarwin ? "needs sandbox-exec" : false }, () => {
  it("names the path a write outside the workspace was refused at", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-deny-")));
    const ws = path.join(base, "ws");
    fs.mkdirSync(ws);
    try {
      const out = await runCommandOperation({
        command: "echo ok > inside.txt; echo no > ../outside.txt",
        cwd: ws,
        workspaceRoot: ws,
        sandboxProfile: "workspace-write",
        homeDir: path.join(base, "home"),
        // Narrow the allowed temp dir so `base` itself is outside every writable root.
        tempDir: path.join(base, "tmp"),
      });
      assert.equal(fs.readFileSync(path.join(ws, "inside.txt"), "utf-8"), "ok\n");
      assert.equal(fs.existsSync(path.join(base, "outside.txt")), false);
      assert.deepEqual(
        out.sandboxDenials?.map((d) => [d.kind, d.path]),
        [["file", path.join(base, "outside.txt")]]
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("leaves sandboxDenials unset for an unsandboxed command with the same stderr", async () => {
    const out = await runCommandOperation({
      command: "echo 'touch: x: Operation not permitted' >&2; exit 1",
    });
    assert.equal(out.sandboxDenials, undefined);
  });
});

describe("denial reasons on daemon tool results", () => {
  it("a workspace escape is PATH_OUTSIDE_WORKSPACE / workspace_escape", async () => {
    const res = await new ToolRegistry().dispatch(
      "read_file",
      { path: "../../etc/hosts" },
      { workspaceRoot: os.tmpdir() } as any
    );
    assert.equal(res.status, "error");
    assert.equal(res.error?.code, "PATH_OUTSIDE_WORKSPACE");
    assert.equal(res.error?.reason, "workspace_escape");
    assert.match(res.error?.message ?? "", /Path traversal blocked/);
  });

  it("a dangerous command is SAFETY_GATE_BLOCKED / safety_gate", async () => {
    const res = await new ToolRegistry().dispatch("exec_command", { command: "rm -rf /" });
    assert.equal(res.error?.code, "SAFETY_GATE_BLOCKED");
    assert.equal(res.error?.reason, "safety_gate");
  });

  it("a pending approval carries approval_required", async () => {
    const res = await new ToolRegistry().dispatch(
      "exec_command",
      { command: "ls" },
      { permissionGates: { computerUseAllowed: false, deviceToolsAllowed: false, standingAllowlist: [] } } as any
    );
    assert.equal(res.status, "permission_pending");
    assert.equal(res.error?.reason, "approval_required");
  });
});
