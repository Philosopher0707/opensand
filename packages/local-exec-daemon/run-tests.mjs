#!/usr/bin/env node
// Test runner for @opensand/local-exec-daemon: runs dist/test/*.test.js through
// node --test. Positional arguments are substring filters on file names, so the
// design's `pnpm test -- target-transport` runs just that suite (node --test
// itself only accepts file paths, not suite names).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";

const filters = process.argv.slice(2).filter((a) => a !== "--");
const dir = path.resolve("dist/test");
let files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(dir, f));
for (const filter of filters) {
  files = files.filter((f) => f.includes(filter));
}
if (files.length === 0) {
  console.error(`no test files match: ${filters.join(" ") || "(all)"}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
