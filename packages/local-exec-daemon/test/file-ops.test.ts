import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { readFileOperation, writeFileOperation, editFileOperation, grepOperation, globOperation, listDirectoryOperation } from "../src/file-ops.js";

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

  describe("editFileOperation", () => {
    it("performs exact string replacement atomically and returns new SHA-256", async () => {
      const filePath = path.join(testDir, "edit-test.txt");
      await writeFileOperation({
        path: filePath,
        content: "const foo = 1;\nconst bar = 2;\n",
      });

      const res = await editFileOperation({
        path: filePath,
        old_string: "const bar = 2;",
        new_string: "const bar = 42;",
      });

      assert.equal(res.replacementCount, 1);
      assert.ok(res.sha256);

      const read = await readFileOperation({ path: filePath });
      assert.equal(read.content, "const foo = 1;\nconst bar = 42;\n");
      assert.equal(read.sha256, res.sha256);
    });

    it("errors when old_string is absent", async () => {
      const filePath = path.join(testDir, "edit-absent.txt");
      await writeFileOperation({ path: filePath, content: "alpha beta gamma" });

      await assert.rejects(
        async () => {
          await editFileOperation({
            path: filePath,
            old_string: "delta",
            new_string: "epsilon",
          });
        },
        /String to replace was not found in file/
      );
    });

    it("errors when old_string matches multiple times and replace_all is not true", async () => {
      const filePath = path.join(testDir, "edit-multi.txt");
      await writeFileOperation({ path: filePath, content: "repeat repeat repeat" });

      await assert.rejects(
        async () => {
          await editFileOperation({
            path: filePath,
            old_string: "repeat",
            new_string: "once",
          });
        },
        /old_string matches 3 times/
      );
    });

    it("replaces all occurrences when replace_all: true", async () => {
      const filePath = path.join(testDir, "edit-replace-all.txt");
      await writeFileOperation({ path: filePath, content: "item item item" });

      const res = await editFileOperation({
        path: filePath,
        old_string: "item",
        new_string: "replaced",
        replace_all: true,
      });

      assert.equal(res.replacementCount, 3);
      const read = await readFileOperation({ path: filePath });
      assert.equal(read.content, "replaced replaced replaced");
    });

    it("errors when old_string === new_string", async () => {
      const filePath = path.join(testDir, "edit-identical.txt");
      await writeFileOperation({ path: filePath, content: "same" });

      await assert.rejects(
        async () => {
          await editFileOperation({
            path: filePath,
            old_string: "same",
            new_string: "same",
          });
        },
        /old_string and new_string must be different/
      );
    });

    it("rejects path traversal outside workspaceRoot", async () => {
      const projectRoot = path.join(testDir, "proj-edit");
      await fs.mkdir(projectRoot, { recursive: true });

      await assert.rejects(
        async () => {
          await editFileOperation({
            path: "../outside.txt",
            old_string: "a",
            new_string: "b",
            workspaceRoot: projectRoot,
          });
        },
        /Path traversal blocked/
      );
    });
  });

  describe("grepOperation", () => {
    it("searches regex under workspace and returns file:line:text matches", async () => {
      const grepDir = path.join(testDir, "grep-tree");
      await fs.mkdir(path.join(grepDir, "src"), { recursive: true });
      await fs.mkdir(path.join(grepDir, "node_modules", "pkg"), { recursive: true });
      await fs.mkdir(path.join(grepDir, ".git"), { recursive: true });
      await fs.mkdir(path.join(grepDir, "dist"), { recursive: true });

      await fs.writeFile(path.join(grepDir, "src", "index.ts"), "export const ALPHA = 100;\nexport const BETA = 200;\n");
      await fs.writeFile(path.join(grepDir, "src", "util.ts"), "const ALPHA = 999;\n");
      // Ignored dirs
      await fs.writeFile(path.join(grepDir, "node_modules", "pkg", "index.js"), "const ALPHA = 0;");
      await fs.writeFile(path.join(grepDir, ".git", "config"), "ALPHA");
      await fs.writeFile(path.join(grepDir, "dist", "bundle.js"), "ALPHA");

      const res = await grepOperation({
        pattern: "ALPHA",
        path: grepDir,
        workspaceRoot: grepDir,
      });

      assert.equal(res.matches.length, 2);
      assert.equal(res.truncated, false);
      const files = res.matches.map((m) => m.file);
      assert.ok(files.some((f) => f.includes("src/index.ts") || f.includes("src/util.ts")));
      assert.ok(!files.some((f) => f.includes("node_modules") || f.includes(".git") || f.includes("dist")));
      assert.ok(res.lines.some((l) => l.includes(":export const ALPHA = 100;")));
    });

    it("supports case_insensitive search and glob file filtering", async () => {
      const grepDir = path.join(testDir, "grep-opts");
      await fs.mkdir(path.join(grepDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(grepDir, "sub", "test.ts"), "HelloWorld\n");
      await fs.writeFile(path.join(grepDir, "sub", "test.js"), "helloworld\n");

      // glob *.ts filter
      const res = await grepOperation({
        pattern: "helloworld",
        path: grepDir,
        glob: "**/*.ts",
        case_insensitive: true,
        workspaceRoot: grepDir,
      });

      assert.equal(res.matches.length, 1);
      assert.ok(res.matches[0].file.endsWith(".ts"));
    });

    it("caps results and sets truncated flag when max_results exceeded", async () => {
      const grepDir = path.join(testDir, "grep-cap");
      await fs.mkdir(grepDir, { recursive: true });
      const lines = Array.from({ length: 20 }, (_, i) => `target match ${i}`).join("\n");
      await fs.writeFile(path.join(grepDir, "many.txt"), lines);

      const res = await grepOperation({
        pattern: "target match",
        path: grepDir,
        max_results: 5,
        workspaceRoot: grepDir,
      });

      assert.equal(res.matches.length, 5);
      assert.equal(res.truncated, true);
    });

    it("gives a clear error for invalid regex", async () => {
      await assert.rejects(
        async () => {
          await grepOperation({
            pattern: "[unclosed",
            path: testDir,
            workspaceRoot: testDir,
          });
        },
        /Invalid regex pattern/
      );
    });

    it("rejects path traversal outside workspaceRoot", async () => {
      const projectRoot = path.join(testDir, "proj-grep");
      await fs.mkdir(projectRoot, { recursive: true });

      await assert.rejects(
        async () => {
          await grepOperation({
            pattern: "test",
            path: "../outside",
            workspaceRoot: projectRoot,
          });
        },
        /Path traversal blocked/
      );
    });
  });

  describe("globOperation", () => {
    it("matches files with glob patterns while skipping ignored dirs", async () => {
      const globDir = path.join(testDir, "glob-tree");
      await fs.mkdir(path.join(globDir, "src", "components"), { recursive: true });
      await fs.mkdir(path.join(globDir, "node_modules", "foo"), { recursive: true });
      await fs.mkdir(path.join(globDir, ".git"), { recursive: true });

      await fs.writeFile(path.join(globDir, "src", "index.ts"), "");
      await fs.writeFile(path.join(globDir, "src", "components", "button.ts"), "");
      await fs.writeFile(path.join(globDir, "src", "components", "style.css"), "");
      await fs.writeFile(path.join(globDir, "node_modules", "foo", "index.ts"), "");

      const res = await globOperation({
        pattern: "**/*.ts",
        path: globDir,
        workspaceRoot: globDir,
      });

      assert.equal(res.matches.length, 2);
      assert.ok(!res.matches.some((m) => m.includes("node_modules")));
      assert.ok(res.matches.some((m) => m.includes("index.ts")));
      assert.ok(res.matches.some((m) => m.includes("button.ts")));
    });

    it("caps glob results when max_results exceeded", async () => {
      const globDir = path.join(testDir, "glob-cap");
      await fs.mkdir(globDir, { recursive: true });
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(path.join(globDir, `file${i}.txt`), "");
      }

      const res = await globOperation({
        pattern: "*.txt",
        path: globDir,
        max_results: 3,
        workspaceRoot: globDir,
      });

      assert.equal(res.matches.length, 3);
      assert.equal(res.truncated, true);
    });

    it("rejects path traversal outside workspaceRoot", async () => {
      const projectRoot = path.join(testDir, "proj-glob");
      await fs.mkdir(projectRoot, { recursive: true });

      await assert.rejects(
        async () => {
          await globOperation({
            pattern: "*",
            path: "..",
            workspaceRoot: projectRoot,
          });
        },
        /Path traversal blocked/
      );
    });
  });

});
