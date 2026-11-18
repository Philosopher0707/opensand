import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../src/tool-registry.js";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/tool-registry.ts");

/** A turn workspace and a sibling directory outside it. Both hold a `note.txt` with different text. */
function makeDirs() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-scope-")));
  const ws = path.join(base, "turn");
  const outside = path.join(base, "elsewhere");
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, "note.txt"), "IN-WORKSPACE");
  fs.writeFileSync(path.join(outside, "note.txt"), "OUTSIDE-SECRET");
  return { base, ws, outside };
}

/** Dispatch and keep both outcomes: a returned result or a thrown error, as text. */
async function attempt(registry: ToolRegistry, name: string, args: Record<string, unknown>, ws: string): Promise<string> {
  try {
    const res = await registry.dispatch(name, args, { workspaceRoot: ws });
    return JSON.stringify(res);
  } catch (err) {
    return String(err);
  }
}

describe("file tools take their workspace only from the turn context", () => {
  it("static: tool-registry.ts never reads workspaceRoot or allowOutsideWorkspace from model input", () => {
    const source = fs.readFileSync(SOURCE, "utf8");
    assert.doesNotMatch(source, /input\.workspaceRoot\s*\?\?/);
    assert.doesNotMatch(source, /input\.allowOutsideWorkspace\s*\?\?/);
  });

  it("read_file ignores a model-supplied workspaceRoot", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      const out = await attempt(new ToolRegistry(), "read_file", { path: "note.txt", workspaceRoot: outside }, ws);
      assert.match(out, /IN-WORKSPACE/);
      assert.doesNotMatch(out, /OUTSIDE-SECRET/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("write_file ignores a model-supplied workspaceRoot and creates nothing outside", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      await attempt(new ToolRegistry(), "write_file", { path: "created.txt", content: "x", workspaceRoot: outside }, ws);
      assert.equal(fs.existsSync(path.join(outside, "created.txt")), false);
      assert.equal(fs.readFileSync(path.join(ws, "created.txt"), "utf8"), "x");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("edit_file ignores a model-supplied workspaceRoot and leaves the outside file untouched", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      await attempt(
        new ToolRegistry(),
        "edit_file",
        { path: "note.txt", old_string: "OUTSIDE-SECRET", new_string: "EDITED", workspaceRoot: outside },
        ws,
      );
      assert.equal(fs.readFileSync(path.join(outside, "note.txt"), "utf8"), "OUTSIDE-SECRET");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("grep ignores a model-supplied workspaceRoot", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      const out = await attempt(new ToolRegistry(), "grep", { pattern: "SECRET|WORKSPACE", workspaceRoot: outside }, ws);
      assert.doesNotMatch(out, /OUTSIDE-SECRET/);
      assert.doesNotMatch(out, new RegExp(path.basename(outside)));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("glob ignores a model-supplied workspaceRoot", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      fs.writeFileSync(path.join(outside, "only-outside.txt"), "y");
      const out = await attempt(new ToolRegistry(), "glob", { pattern: "*.txt", workspaceRoot: outside }, ws);
      assert.doesNotMatch(out, /only-outside\.txt/);
      assert.match(out, /note\.txt/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("list_directory ignores a model-supplied workspaceRoot", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      fs.writeFileSync(path.join(outside, "only-outside.txt"), "y");
      const out = await attempt(new ToolRegistry(), "list_directory", { path: ".", workspaceRoot: outside }, ws);
      assert.doesNotMatch(out, /only-outside\.txt/);
      assert.match(out, /note\.txt/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("no file tool lifts the workspace check because the model set allowOutsideWorkspace", async () => {
    const { base, ws, outside } = makeDirs();
    try {
      const registry = new ToolRegistry();
      const target = path.join(outside, "note.txt");
      for (const [name, args] of [
        ["read_file", { path: target, allowOutsideWorkspace: true }],
        ["list_directory", { path: outside, allowOutsideWorkspace: true }],
      ] as const) {
        const out = await attempt(registry, name, args as Record<string, unknown>, ws);
        assert.doesNotMatch(out, /OUTSIDE-SECRET/, name);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
