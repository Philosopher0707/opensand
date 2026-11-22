import test from "node:test";
import assert from "node:assert";
import {
  createInitialCanvasState,
  openArtifact,
  closeTab,
  selectTab,
  setViewMode,
  closeCanvas,
  resolveLanguageMeta,
  generateLineNumbers,
  type CanvasState,
  type ArtifactItem,
} from "../src/shell/canvas-model.js";

test("canvas model: initial state is closed with no artifacts", () => {
  const state = createInitialCanvasState();
  assert.strictEqual(state.isOpen, false);
  assert.strictEqual(state.activeId, null);
  assert.strictEqual(state.artifacts.length, 0);
});

test("canvas model: resolveLanguageMeta identifies previewable languages", () => {
  const md = resolveLanguageMeta("markdown");
  assert.strictEqual(md.previewable, true);
  assert.strictEqual(md.label, "Markdown");

  const html = resolveLanguageMeta("html");
  assert.strictEqual(html.previewable, true);

  const svg = resolveLanguageMeta("svg");
  assert.strictEqual(svg.previewable, true);

  const ts = resolveLanguageMeta("typescript");
  assert.strictEqual(ts.previewable, false);
  assert.strictEqual(ts.label, "TypeScript");

  const py = resolveLanguageMeta(".py");
  assert.strictEqual(py.previewable, false);
  assert.strictEqual(py.label, "Python");
});

test("canvas model: openArtifact adds artifact and sets active", () => {
  let state = createInitialCanvasState();
  state = openArtifact(state, {
    title: "app.ts",
    filePath: "/src/app.ts",
    language: "typescript",
    content: "console.log('hi');",
  });

  assert.strictEqual(state.isOpen, true);
  assert.strictEqual(state.artifacts.length, 1);
  assert.strictEqual(state.activeId, "/src/app.ts");
  assert.strictEqual(state.artifacts[0].title, "app.ts");
  assert.strictEqual(state.artifacts[0].viewMode, "code");
});

test("canvas model: openArtifact defaults previewable files to preview mode", () => {
  let state = createInitialCanvasState();
  state = openArtifact(state, {
    title: "doc.md",
    filePath: "/docs/doc.md",
    language: "markdown",
    content: "# Hello",
  });

  assert.strictEqual(state.artifacts[0].viewMode, "preview");
});

test("canvas model: openArtifact updates existing artifact in-place without duplicate tab", () => {
  let state = createInitialCanvasState();
  state = openArtifact(state, {
    id: "f1",
    title: "test.js",
    content: "const a = 1;",
  });
  state = openArtifact(state, {
    id: "f2",
    title: "other.js",
    content: "const b = 2;",
  });
  assert.strictEqual(state.artifacts.length, 2);
  assert.strictEqual(state.activeId, "f2");

  // Re-open f1 with updated content
  state = openArtifact(state, {
    id: "f1",
    title: "test.js",
    content: "const a = 2;",
  });
  assert.strictEqual(state.artifacts.length, 2, "must not add duplicate tab");
  assert.strictEqual(state.activeId, "f1", "re-opened tab becomes active");
  assert.strictEqual(state.artifacts[0].content, "const a = 2;");
});

test("canvas model: selectTab switches active tab", () => {
  let state = createInitialCanvasState();
  state = openArtifact(state, { id: "1", title: "a.ts", content: "a" });
  state = openArtifact(state, { id: "2", title: "b.ts", content: "b" });
  assert.strictEqual(state.activeId, "2");

  state = selectTab(state, "1");
  assert.strictEqual(state.activeId, "1");
});

test("canvas model: closeTab removes tab and updates active tab", () => {
  let state = createInitialCanvasState();
  state = openArtifact(state, { id: "1", title: "a.ts", content: "a" });
  state = openArtifact(state, { id: "2", title: "b.ts", content: "b" });
  state = openArtifact(state, { id: "3", title: "c.ts", content: "c" });

  // Close active tab (3) -> active moves to previous tab (2)
  state = closeTab(state, "3");
  assert.strictEqual(state.artifacts.length, 2);
  assert.strictEqual(state.activeId, "2");

  // Close middle tab (2) -> active moves to 1
  state = closeTab(state, "2");
  assert.strictEqual(state.artifacts.length, 1);
  assert.strictEqual(state.activeId, "1");

  // Close last tab (1) -> canvas closes
  state = closeTab(state, "1");
  assert.strictEqual(state.artifacts.length, 0);
  assert.strictEqual(state.activeId, null);
  assert.strictEqual(state.isOpen, false);
});

test("canvas model: setViewMode and closeCanvas", () => {
  let state = createInitialCanvasState();
  state = openArtifact(state, { id: "1", title: "page.html", language: "html", content: "<h1>Hi</h1>" });
  assert.strictEqual(state.artifacts[0].viewMode, "preview");

  state = setViewMode(state, "1", "code");
  assert.strictEqual(state.artifacts[0].viewMode, "code");

  state = closeCanvas(state);
  assert.strictEqual(state.isOpen, false);
  assert.strictEqual(state.artifacts.length, 1, "closing canvas retains tabs for re-opening");
});

test("canvas model: generateLineNumbers creates 1-indexed numbers", () => {
  const nums = generateLineNumbers("a\nb\nc");
  assert.strictEqual(nums, "1\n2\n3");

  const single = generateLineNumbers("single line");
  assert.strictEqual(single, "1");

  const empty = generateLineNumbers("");
  assert.strictEqual(empty, "1");
});
