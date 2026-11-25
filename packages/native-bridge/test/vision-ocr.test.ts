import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { recognizeScreenText } from "../src/vision-ocr.js";

async function makeProbe(dir: string, script: string): Promise<string> {
  const binDir = path.join(dir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const probe = path.join(binDir, "sand-vision");
  await fs.writeFile(probe, script);
  await fs.chmod(probe, 0o755);
  return binDir;
}

test("oversized image is refused before spawning sand-vision", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-ocr-"));
  try {
    const marker = path.join(dir, "invoked");
    const binDir = await makeProbe(
      dir,
      `#!/bin/sh\nprintf '{"status":"ok","text":"probe ran"}\\n'\ntouch '${marker}'\n`,
    );

    const bigFile = path.join(dir, "big.bin");
    await fs.writeFile(bigFile, Buffer.alloc(21 * 1024 * 1024));

    const result = await recognizeScreenText(bigFile, binDir);
    assert.equal(result.status, "error");
    assert.match(result.message ?? "", /exceeds|too large|size limit|maximum/i);

    let invoked = false;
    try {
      await fs.stat(marker);
      invoked = true;
    } catch {
      // expected: marker must not exist
    }
    assert.equal(invoked, false, "probe must not be invoked for an oversized image");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("unsupported image is refused before spawning sand-vision", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-ocr-"));
  try {
    const marker = path.join(dir, "invoked");
    const binDir = await makeProbe(
      dir,
      `#!/bin/sh\nprintf '{"status":"ok","text":"probe ran"}\\n'\ntouch '${marker}'\n`,
    );

    const badFile = path.join(dir, "bad.txt");
    await fs.writeFile(badFile, "this is not an image");

    const result = await recognizeScreenText(badFile, binDir);
    assert.equal(result.status, "error");
    assert.match(result.message ?? "", /unsupported|decode|invalid/i);

    let invoked = false;
    try {
      await fs.stat(marker);
      invoked = true;
    } catch {
      // expected
    }
    assert.equal(invoked, false, "probe must not be invoked for an unsupported image");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("helper structured stdout rejection is kept on nonzero exit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-ocr-"));
  try {
    const binDir = await makeProbe(
      dir,
      `#!/bin/sh\nprintf '{"status":"error","message":"Failed to decode image data"}\\n'\nexit 1\n`,
    );

    // PNG magic bytes so the pre-spawn type check passes and the probe runs.
    const pngLike = path.join(dir, "looks.png");
    await fs.writeFile(pngLike, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

    const result = await recognizeScreenText(pngLike, binDir);
    assert.equal(result.status, "error");
    assert.equal(result.message, "Failed to decode image data");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
