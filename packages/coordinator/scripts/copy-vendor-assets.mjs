import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const srcDir = path.join(pkgRoot, "src", "engines", "vendor");
const destDir = path.join(pkgRoot, "dist", "src", "engines", "vendor");

fs.mkdirSync(destDir, { recursive: true });

for (const file of ["agent_wrap.mjs", "engine_facts.mjs", "PIN"]) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}
