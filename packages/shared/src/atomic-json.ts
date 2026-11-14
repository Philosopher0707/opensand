import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Write `content` as JSON to dir/fileName: tmp file (0o600) then rename, dir created 0o700. */
export async function atomicWriteJson(dir: string, fileName: string, content: unknown): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${fileName}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fsp.writeFile(tmp, JSON.stringify(content, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tmp, path.join(dir, fileName));
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}
