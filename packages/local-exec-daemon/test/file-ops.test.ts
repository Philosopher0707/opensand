import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readFileOperation, writeFileOperation, listDirectoryOperation } from "../src/file-ops.js";

describe("FileOps", () => {
  let testDir: string;

  before(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-fileops-test-"));
  });

  after(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("writes and reads a file atomically", () => {
    return (async () => {
      const filePath = path.join(testDir, "sub", "test.txt");
      const writeResult = await writeFileOperation({
        path: filePath,
        content: "hello world\nsecond line\nthird line\n",
        overwrite: true,
      });

      assert.equal(writeResult.created, true);
      assert.ok(writeResult.bytesWritten > 0);
      assert.ok(writeResult.sha256);

      const readResult = await readFileOperation({ path: filePath });
      assert.equal(readResult.content, "hello world\nsecond line\nthird line\n");
      assert.equal(readResult.totalLines, 4);
      assert.equal(readResult.sha256, writeResult.sha256);
    })();
  });

  it("slices file content by line numbers", async () => {
    const filePath = path.join(testDir, "lines.txt");
    await writeFileOperation({
      path: filePath,
      content: "line 1\nline 2\nline 3\nline 4\nline 5",
    });

    const slice = await readFileOperation({
      path: filePath,
      start_line: 2,
      end_line: 4,
    });

    assert.equal(slice.content, "line 2\nline 3\nline 4");
    assert.equal(slice.totalLines, 5);
  });

  it("prevents overwrite when overwrite: false", async () => {
    const filePath = path.join(testDir, "existing.txt");
    await writeFileOperation({ path: filePath, content: "original" });

    await assert.rejects(
      async () => {
        await writeFileOperation({ path: filePath, content: "new content", overwrite: false });
      },
      /File already exists and overwrite is set to false/
    );
  });

  it("lists directory entries accurately", async () => {
    const nestedDir = path.join(testDir, "list-dir-test");
    await fs.mkdir(path.join(nestedDir, "child"), { recursive: true });
    await fs.writeFile(path.join(nestedDir, "file1.txt"), "f1");
    await fs.writeFile(path.join(nestedDir, "child", "file2.txt"), "f2");

    const listing = await listDirectoryOperation({
      path: nestedDir,
      recursive: true,
      max_depth: 2,
    });

    assert.equal(listing.path, nestedDir);
    const names = listing.entries.map((e) => e.name);
    assert.ok(names.includes("file1.txt"));
    assert.ok(names.some((n) => n.includes("child")));
  });

  it("rejects reading files that exceed 25MB safety ceiling", async () => {
    const hugeFilePath = path.join(testDir, "huge.bin");
    const handle = await fs.open(hugeFilePath, "w");
    await handle.truncate(26 * 1024 * 1024);
    await handle.close();

    await assert.rejects(
      async () => {
        await readFileOperation({ path: hugeFilePath });
      },
      /File size .* exceeds maximum safe read limit/
    );
  });

  it("enforces workspace confinement and blocks path traversal outside workspaceRoot", async () => {
    const projectRoot = path.join(testDir, "my-project");
    const secretOutside = path.join(testDir, "outside-secret.txt");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(secretOutside, "SUPER_SECRET_PAYLOAD");

    // 1. Path traversal via ../ blocked in readFileOperation
    await assert.rejects(
      async () => {
        await readFileOperation({
          path: "../outside-secret.txt",
          workspaceRoot: projectRoot,
        });
      },
      /Path traversal blocked: target path .* resolves outside workspace root/
    );

    // 2. Absolute path outside workspaceRoot blocked
    await assert.rejects(
      async () => {
        await readFileOperation({
          path: secretOutside,
          workspaceRoot: projectRoot,
        });
      },
      /Path traversal blocked: target path .* resolves outside workspace root/
    );

    // 3. Traversal blocked in writeFileOperation
    await assert.rejects(
      async () => {
        await writeFileOperation({
          path: "../escaped.txt",
          content: "malicious write",
          workspaceRoot: projectRoot,
        });
      },
      /Path traversal blocked/
    );

    // 4. Traversal blocked in listDirectoryOperation
    await assert.rejects(
      async () => {
        await listDirectoryOperation({
          path: "..",
          workspaceRoot: projectRoot,
        });
      },
      /Path traversal blocked/
    );

    // 5. allowOutsideWorkspace explicitly allows authorized outside access
    const allowed = await readFileOperation({
      path: secretOutside,
      workspaceRoot: projectRoot,
      allowOutsideWorkspace: true,
    });
    assert.equal(allowed.content, "SUPER_SECRET_PAYLOAD");
  });
});
