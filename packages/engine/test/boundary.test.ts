import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** packages/engine/src - the compiled test lives in packages/engine/dist/test. */
const srcDir = path.resolve(here, "..", "..", "src");

function sourcesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourcesUnder(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
}

describe("engine package boundary", () => {
  it("never imports the coordinator or the desktop package", () => {
    const files = sourcesUnder(srcDir).filter((file) => path.basename(file) !== "bin.ts");
    assert.ok(files.length > 0, `found engine sources to scan under ${srcDir}`);

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      assert.equal(
        source.includes("@opensand/coordinator"),
        false,
        `${file} must not import @opensand/coordinator`
      );
      assert.equal(
        source.includes("@opensand/desktop"),
        false,
        `${file} must not import @opensand/desktop`
      );
    }
  });
});
