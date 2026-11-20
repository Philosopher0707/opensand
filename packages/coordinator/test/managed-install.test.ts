import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { installManagedRuntime, resolveInstalled, type ManagedRelease } from "../src/providers/runtime/managed-install.js";

const BINARY = "#!/bin/sh\necho managed-runtime 1.2.3\n";

async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": Buffer.byteLength(BINARY) });
    res.end(BINARY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/runtime`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
  };
}

describe("managed runtime installer", () => {
  it("downloads, verifies, smoke-tests and reuses a pinned runtime", async () => {
    const served = await serve();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-install-"));
    const release: ManagedRelease = {
      provider: "test",
      version: "1.2.3",
      url: served.url,
      sha256: createHash("sha256").update(BINARY).digest("hex"),
      bytes: Buffer.byteLength(BINARY),
      executable: "runtime",
    };
    try {
      const installed = await installManagedRuntime(release, { root, allowHosts: ["127.0.0.1"] });
      assert.equal(installed.source, "managed");
      assert.equal(installed.version, "1.2.3");
      assert.ok((await fs.stat(installed.executablePath)).mode & 0o111, "must be executable");
      assert.deepEqual(resolveInstalled(release, root), installed);

      const again = await installManagedRuntime(release, { root, allowHosts: ["127.0.0.1"] });
      assert.deepEqual(again, installed);
    } finally {
      await served.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a hash mismatch and an unallowlisted host", async () => {
    const served = await serve();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-install-bad-"));
    const release: ManagedRelease = {
      provider: "test",
      version: "1.2.3",
      url: served.url,
      sha256: "0".repeat(64),
      bytes: Buffer.byteLength(BINARY),
      executable: "runtime",
    };
    try {
      await assert.rejects(installManagedRuntime(release, { root, allowHosts: ["127.0.0.1"] }), /hash/);
      await assert.rejects(
        installManagedRuntime({ ...release, sha256: createHash("sha256").update(BINARY).digest("hex") }, { root, allowHosts: ["example.com"] }),
        /not allowlisted/
      );
    } finally {
      await served.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
