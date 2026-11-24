import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const source = fs.readFileSync(path.join(pkgRoot, "test", "navigation-real-window.test.ts"), "utf8");

test("navigation real-window shot settles a disposed frame and bounds capturePage", () => {
  assert.ok(source.includes("requestAnimationFrame(() => requestAnimationFrame(done))"),
    "double-rAF settle is present");
  assert.ok(source.includes("setTimeout(done, 2000)"),
    "rAF has a 2 s fallback so a disposed frame cannot hang the runner");
  assert.ok(source.includes("Promise.race(["), "capturePage is bounded by a race");
  assert.ok(source.includes("capturePage timed out"), "a slow capture is reported, not silently awaited");
});
