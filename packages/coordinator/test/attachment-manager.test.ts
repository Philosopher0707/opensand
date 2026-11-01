import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AttachmentManager } from "../src/attachment-manager.js";

test("AttachmentManager - stages files, buffers, computes sha256, and manages lifecycle", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-att-test-"));

  try {
    const manager = new AttachmentManager(path.join(tmpDir, "attachments"));

    // 1. Stage bytes
    const sampleBuffer = Buffer.from("Hello OpenSand Attachment World!");
    const att1 = await manager.stageBytes("sample.txt", sampleBuffer);

    assert.ok(att1.id.startsWith("att_"));
    assert.strictEqual(att1.filename, "sample.txt");
    assert.strictEqual(att1.mimeType, "text/plain");
    assert.strictEqual(att1.sizeBytes, sampleBuffer.length);
    assert.ok(att1.sha256.length === 64);

    // 2. Stage file from disk
    const diskFilePath = path.join(tmpDir, "test.json");
    await fs.writeFile(diskFilePath, JSON.stringify({ key: "value", number: 42 }));
    const att2 = await manager.stageFile(diskFilePath);

    assert.ok(att2.id.startsWith("att_"));
    assert.strictEqual(att2.filename, "test.json");
    assert.strictEqual(att2.mimeType, "application/json");

    // 3. List attachments
    const list = await manager.listAttachments();
    assert.strictEqual(list.length, 2);
    assert.ok(list.some(a => a.id === att1.id));
    assert.ok(list.some(a => a.id === att2.id));

    // 4. Get attachment
    const fetched = await manager.getAttachment(att1.id);
    assert.ok(fetched);
    assert.strictEqual(fetched?.id, att1.id);
    assert.strictEqual(fetched?.filename, "sample.txt");

    // 5. Delete attachment
    const deleted = await manager.deleteAttachment(att1.id);
    assert.strictEqual(deleted, true);

    const afterDelete = await manager.getAttachment(att1.id);
    assert.strictEqual(afterDelete, null);

    const remaining = await manager.listAttachments();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, att2.id);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
