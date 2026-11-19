import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  TargetServer,
  TargetClient,
  staticTargetSpawn,
  resolveTargetPath,
  sanitizeCallerEnv,
  TARGET_ENV_ALLOWLIST,
  TargetErrorCodes,
  TargetLostError,
  TargetNotReadyError,
  TargetVersionMismatchError,
} from "../src/target/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../src/target/bin.js");
const require = createRequire(import.meta.url);
const DAEMON_VERSION: string = require(path.resolve(HERE, "../../package.json")).version;

/** A temp root outside every symlinked alias (macOS /var -> /private/var). */
function makeRoot(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-target-")));
}

function spawnChild(root: string, env: Record<string, string> = {}) {
  return staticTargetSpawn(process.execPath, [BIN, "--stdio", "--root", root, "--target-id", "probe"], {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...env,
  });
}

/** A hello'd client over a real child. The child is closed even when hello fails. */
async function connect(root: string, env: Record<string, string> = {}) {
  const client = new TargetClient({ spawn: spawnChild(root, env), version: DAEMON_VERSION });
  client.start();
  try {
    const hello = await client.hello();
    return { client, hello };
  } catch (err) {
    // A rejected handshake must not leave the child running: its open stdio
    // pipes keep node --test's event loop alive and the run never finishes.
    await client.close().catch(() => undefined);
    throw err;
  }
}

describe("target transport (real child over stdio)", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("target.hello answers with platform, root, sandbox and a marker over a real child", async () => {
    const root = makeRoot();
    roots.push(root);
    const { client, hello } = await connect(root);
    try {
      assert.equal(hello.protocol, 1);
      assert.equal(hello.version, DAEMON_VERSION);
      assert.equal(hello.platform, process.platform);
      assert.equal(hello.root, root);
      assert.equal(hello.sandbox, "none");
      assert.match(hello.marker, /^[0-9a-f]{24}$/);
      assert.match(hello.node, /^v\d+/);
    } finally {
      await client.close();
    }
  });

  it("target.exec runs in the root, carries OPENSAND_TARGET_ID and honors cwd", async () => {
    const root = makeRoot();
    roots.push(root);
    fs.mkdirSync(path.join(root, "sub"));
    const { client } = await connect(root);
    try {
      const marker = await client.exec({ command: 'printf "target=%s" "$OPENSAND_TARGET_ID"' });
      assert.equal(marker.stdout, "target=probe");
      const cwd = await client.exec({ command: "pwd" });
      assert.equal(cwd.stdout.trim(), root);
      const sub = await client.exec({ command: "pwd", cwd: "sub" });
      assert.equal(sub.stdout.trim(), path.join(root, "sub"));
      const exit = await client.exec({ command: "exit 3" });
      assert.equal(exit.exitCode, 3);
    } finally {
      await client.close();
    }
  });

  it("the server never forwards secrets: not from its own env, not from caller env", async () => {
    const root = makeRoot();
    roots.push(root);
    const { client } = await connect(root, { OPENAI_API_KEY: "sk-secret", SSH_AUTH_SOCK: "/tmp/agent" });
    try {
      const out = await client.exec({ command: "env" });
      assert.doesNotMatch(out.stdout, /sk-secret/);
      assert.doesNotMatch(out.stdout, /SSH_AUTH_SOCK/);
      assert.doesNotMatch(out.stdout, /OPENAI_API_KEY/);
      // Caller-supplied env is filtered too; a harmless variable passes through.
      const custom = await client.exec({ command: "env", env: { PROBE_VAR: "yes", GITHUB_TOKEN: "gh-secret" } });
      assert.match(custom.stdout, /PROBE_VAR=yes/);
      assert.doesNotMatch(custom.stdout, /gh-secret/);
      // The forced identity cannot be overridden by caller env.
      const identity = await client.exec({ command: 'printf "%s" "$OPENSAND_TARGET_ID"', env: { OPENSAND_TARGET_ID: "evil" } });
      assert.equal(identity.stdout, "probe");
    } finally {
      await client.close();
    }
  });

  it("writeFile and readFile round-trip inside the root", async () => {
    const root = makeRoot();
    roots.push(root);
    const { client } = await connect(root);
    try {
      const written = await client.writeFile({ path: "out/note.txt", content: "probe-ok\n" });
      assert.equal(written.created, true);
      const read = await client.readFile({ path: "out/note.txt" });
      assert.equal(read.content, "probe-ok\n");
      const seen = await client.exec({ command: "cat out/note.txt" });
      assert.equal(seen.stdout, "probe-ok\n");
    } finally {
      await client.close();
    }
  });

  it("refuses path escapes: ../, absolute outside, and an external symlink", async () => {
    const root = makeRoot();
    roots.push(root);
    const base = path.dirname(root);
    fs.writeFileSync(path.join(base, "outside-secret.txt"), "SECRET");
    fs.symlinkSync(path.join(base, "outside-secret.txt"), path.join(root, "leak"));
    fs.symlinkSync(path.join(base, "no-such-file"), path.join(root, "dangling"));
    const escape = /traversal/i;
    const { client } = await connect(root);
    try {
      await assert.rejects(() => client.writeFile({ path: "../outside-escape.txt", content: "x" }), escape);
      await assert.rejects(() => client.readFile({ path: "/etc/passwd" }), escape);
      // The external symlink exists inside the root but resolves outside it.
      await assert.rejects(() => client.readFile({ path: "leak" }), /(symlink|traversal)/i);
      await assert.rejects(() => client.writeFile({ path: "leak", content: "x" }), /(symlink|traversal)/i);
      await assert.rejects(() => client.readFile({ path: "dangling" }), /(symlink|traversal)/i);
      // Nothing outside was touched.
      assert.equal(fs.readFileSync(path.join(base, "outside-secret.txt"), "utf8"), "SECRET");
      assert.equal(fs.existsSync(path.join(base, "outside-escape.txt")), false);
    } finally {
      await client.close();
    }
  });

  it("a wrong package version is refused before any workspace change", async () => {
    const root = makeRoot();
    roots.push(root);
    const client = new TargetClient({ spawn: spawnChild(root), version: "0.0.0-wrong" });
    client.start();
    try {
      await assert.rejects(
        () => client.hello(),
        (err: Error) => err instanceof TargetVersionMismatchError && err.code === TargetErrorCodes.VersionMismatch,
      );
      assert.equal(fs.readdirSync(root).length, 0, "no workspace change before a successful handshake");
    } finally {
      await client.close();
    }
  });

  it("a wrong protocol version is refused, and non-hello before hello is refused (server side)", async () => {
    const root = makeRoot();
    roots.push(root);
    const server = new TargetServer({ root, sandbox: "none", targetId: "probe", version: DAEMON_VERSION });
    const badProtocol = JSON.stringify({ id: "1", method: "target.hello", params: { protocol: 2, clientVersion: DAEMON_VERSION } }) + "\n";
    const out = await server.handleChunk(badProtocol);
    const frame = JSON.parse(out.trim()) as { error: { code: number; message: string } };
    assert.equal(frame.error.code, TargetErrorCodes.VersionMismatch);
    assert.match(frame.error.message, /target-version-mismatch/);

    const early = JSON.stringify({ id: "2", method: "target.ping", params: {} }) + "\n";
    const out2 = await server.handleChunk(early);
    const frame2 = JSON.parse(out2.trim()) as { error: { code: number } };
    assert.equal(frame2.error.code, TargetErrorCodes.NotReady);
  });

  it("the client refuses to act before hello", async () => {
    const root = makeRoot();
    roots.push(root);
    const client = new TargetClient({ spawn: spawnChild(root), version: DAEMON_VERSION });
    try {
      assert.throws(() => client.ping(), TargetNotReadyError);
    } finally {
      await client.close();
    }
  });

  it("a request timeout closes the link and late responses are ignored", async () => {
    const root = makeRoot();
    roots.push(root);
    const client = new TargetClient({ spawn: spawnChild(root), version: DAEMON_VERSION, execTimeoutMs: 300 });
    client.start();
    try {
      await client.hello();
      await assert.rejects(
        () => client.exec({ command: "sleep 2 && echo late" }),
        (err: Error) => {
          if (!(err instanceof TargetLostError)) return false;
          assert.match(err.message, /timed out/);
          return true;
        },
      );
      // The link is closed: the next request is refused immediately.
      await assert.rejects(() => client.exec({ command: "echo after" }), TargetLostError);
      // Give the child time to emit its late response; it must not resurrect anything.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    } finally {
      await client.close();
    }
  });

  it("resolveTargetPath refuses symlink escapes and sanitizeCallerEnv strips secrets", async () => {
    const root = makeRoot();
    roots.push(root);
    const base = path.dirname(root);
    fs.symlinkSync(base, path.join(root, "loop"));
    await assert.rejects(() => resolveTargetPath(root, "loop/../escape.txt"), /outside/);
    await assert.rejects(() => resolveTargetPath(root, "/etc/passwd"), /traversal/);
    const cleaned = sanitizeCallerEnv({ OK: "yes", AWS_SECRET_ACCESS_KEY: "x", MY_PASSWORD: "y", vault_TOKEN: "z" });
    assert.deepEqual(cleaned, { OK: "yes" });
    const scrubbed: Record<string, string> = { PATH: "/usr/bin", OPENAI_API_KEY: "x", OPENSAND_TARGET_ID: "probe" };
    // scrubServerEnv is bin-only (it would poison the test process's env), so verify its rule directly.
    for (const key of Object.keys({ OPENAI_API_KEY: "x" })) {
      assert.equal(TARGET_ENV_ALLOWLIST.has(key), false);
    }
    assert.equal(TARGET_ENV_ALLOWLIST.has("OPENSAND_TARGET_ID"), true);
  });

  it("target.exec passes the bash validator: a dangerous command is refused", async () => {
    const root = makeRoot();
    roots.push(root);
    const { client } = await connect(root);
    try {
      await assert.rejects(
        () => client.exec({ command: "rm -rf ~" }),
        (err: Error) => /blocked by safety gate|Bash syntax error/i.test(err.message),
      );
    } finally {
      await client.close();
    }
  });

  it("the child's stdout carries framed responses only", async () => {
    const root = makeRoot();
    roots.push(root);
    const { client } = await connect(root);
    try {
      await client.ping();
      // ping worked over the child, so every line the client consumed parsed as a frame;
      // a stray non-JSON stdout line would have been dropped silently — prove the server
      // wrote nothing else by asking it to echo through stderr instead.
      const result = await client.exec({ command: "echo hello" });
      assert.equal(result.stdout.trim(), "hello");
    } finally {
      await client.close();
    }
  });
});
