import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../renderer/modules/canvas-layout.js",
);
const layout = await import(pathToFileURL(modulePath).href);

test("canvas layout keeps every window reachable", () => {
  const window = layout.clampWindow({ x: 900, y: 700, w: 120, h: 100 }, { w: 1000, h: 600 });
  assert.strictEqual(window.w, layout.MIN_WINDOW_WIDTH);
  assert.strictEqual(window.h, layout.MIN_WINDOW_HEIGHT);
  assert.strictEqual(window.x, 1000 - layout.MIN_WINDOW_WIDTH);
  assert.strictEqual(window.y, 600 - layout.MIN_WINDOW_HEIGHT);
});

test("canvas layout cascades without exact stacking", () => {
  const existing = [{ x: 48, y: 48 }];
  const next = layout.cascadePosition(existing, { x: 48, y: 48 }, { w: 1200, h: 800 });
  assert.ok(next.x !== existing[0].x || next.y !== existing[0].y);
});

test("canvas layout fits all windows inside the viewport", () => {
  const windows = [
    { x: 0, y: 0, w: 500, h: 400 },
    { x: 900, y: 700, w: 500, h: 400 },
  ];
  const view = layout.fitAll(windows, { w: 800, h: 600 });
  assert.ok(view.zoom >= 0.5 && view.zoom <= 1);
  const right = (900 + 500) * view.zoom + view.panX;
  const bottom = (700 + 400) * view.zoom + view.panY;
  assert.ok(right <= 800 && bottom <= 600, `fit must keep windows inside: ${JSON.stringify(view)}`);
});

test("canvas layout rejects malformed and unknown sessions on restore", () => {
  const restored = layout.normalizePersisted(
    {
      windows: [
        { sessionId: "known", x: -50, y: 10, w: 380, h: 360, z: 2 },
        { sessionId: "gone", x: 10, y: 10, w: 380, h: 360 },
        null,
        { x: 1, y: 1 },
      ],
      viewport: { panX: 5, panY: 6, zoom: 9 },
      mode: "follow",
    },
    ["known"],
    { w: 1000, h: 600 },
  );
  assert.strictEqual(restored.windows.length, 1);
  assert.strictEqual(restored.windows[0].sessionId, "known");
  assert.strictEqual(restored.windows[0].x, 0);
  assert.deepStrictEqual(restored.orphans, ["gone"]);
  assert.strictEqual(restored.viewport.zoom, 2);
  assert.strictEqual(restored.mode, "follow");
});
