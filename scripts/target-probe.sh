#!/usr/bin/env bash
# Phase 8 S2 target probe (docs/design/phase8-reach.md §10 S2, §4.3).
#
# One command proving the container target end to end:
#  1. builds the target bundle (`pnpm target:build`);
#  2. loads a temp targets.json through the strict store and resolves the target;
#  3. starts `node:22-bookworm` with the containment flags, the workspace and the
#     read-only bundle mounted;
#  4. over the stdio link asserts hello (linux), an exec that reports the OS and
#     the OPENSAND_TARGET_ID marker, and a file write/read that round-trips
#     through the bind mount, plus an outside-path refusal;
#  5. removes the container and asserts nothing labelled with the probe remains.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
if [[ "$MODE" != "container" ]]; then
  echo "usage: scripts/target-probe.sh container" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "target-probe: docker is not available" >&2
  exit 3
fi

echo "==> building the target bundle"
pnpm target:build >/dev/null

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/opensand-target-probe.XXXXXX")"
WS="$STAGE/ws"
mkdir -p "$WS"
CONTAINER="opensand-probe-s2"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

cat > "$STAGE/targets.json" <<'EOF'
{
  "version": 1,
  "targets": {
    "probe22": {
      "kind": "container",
      "runtime": "docker",
      "image": "node:22-bookworm",
      "network": "none",
      "memory": "2g",
      "cpus": 2
    }
  }
}
EOF

cat > "$STAGE/driver.mjs" <<'DRIVER'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const [bundleDir, workspaceRoot, targetsPath] = process.argv.slice(2);
const targetIndex = pathToFileURL(path.join(bundleDir, "dist/src/target/index.js")).href;
const sharedIndex = pathToFileURL(path.join(bundleDir, "node_modules/@opensand/shared/dist/src/index.js")).href;
const { ContainerTargetLauncher, TargetClient, staticTargetSpawn } = await import(targetIndex);
const { loadTargetsFile, resolveTargetConfig } = await import(sharedIndex);

const fail = (message) => {
  console.error(`target-probe: FAIL ${message}`);
  process.exit(1);
};

// 1. targets.json loads through the strict store and the target resolves.
const file = await loadTargetsFile(targetsPath);
const config = resolveTargetConfig(file, "probe22");
if (config.kind !== "container" || config.image !== "node:22-bookworm") {
  fail(`targets.json resolved the wrong target: ${JSON.stringify(config)}`);
}

// 2. preflight: the image provides node >= 22.
const spec = {
  runtime: "docker",
  image: config.image,
  network: config.network ?? "none",
  memory: config.memory,
  cpus: config.cpus,
  missionId: "probe-s2",
  targetId: "probe22",
  bundleDir,
  workspaceRoot,
};
const launcher = new ContainerTargetLauncher(spec);
const nodeVersion = await launcher.preflight();
if (!/^v(2[2-9]|[3-9]\d)\./.test(nodeVersion)) fail(`image node version ${nodeVersion} is not >= 22`);

// 3. start the container and the stdio link. The client and server versions come
// from the same bundle, so the exact hello check passes.
const bundleVersion = createRequire(pathToFileURL(path.join(bundleDir, "package.json")))(path.join(bundleDir, "package.json")).version;
const { client, hello } = await launcher.start(() => new TargetClient({
  spawn: staticTargetSpawn("docker", [
    "exec", "-i", "-e", "OPENSAND_TARGET_ID=probe22",
    "opensand-probe-s2",
    "node", "/opt/opensand-target/dist/src/target/bin.js",
    "--stdio", "--root", "/workspace", "--sandbox", "none",
  ]),
  version: bundleVersion,
}));

try {
  // hello: platform and root must say container/linux, not local.
  if (hello.platform !== "linux") fail(`hello.platform = ${hello.platform}, expected linux`);
  if (hello.root !== "/workspace") fail(`hello.root = ${hello.root}, expected /workspace`);
  if (hello.sandbox !== "none") fail(`hello.sandbox = ${hello.sandbox}`);
  if (hello.version !== bundleVersion) fail(`hello.version = ${hello.version}, expected ${bundleVersion}`);
  console.log(`==> hello ok: node ${hello.node} on ${hello.platform}/${hello.arch}, marker ${hello.marker.slice(0, 8)}`);

  // exec: the OS and the target identity marker.
  const os = await client.exec({ command: 'printf "%s" "$(uname -s)"' });
  if (os.stdout !== "Linux") fail(`exec uname -s = ${os.stdout}, expected Linux`);
  const marker = await client.exec({ command: 'printf "%s" "$OPENSAND_TARGET_ID"' });
  if (marker.stdout !== "probe22") fail(`OPENSAND_TARGET_ID = ${marker.stdout}, expected probe22`);
  console.log("==> exec ok: Linux + OPENSAND_TARGET_ID=probe22");

  // write + read through the file tools: the bind mount round-trips.
  const written = await client.writeFile({ path: "probe/out.txt", content: "probe-ok\n" });
  if (!written.created) fail(`writeFile did not create probe/out.txt (${JSON.stringify(written)})`);
  const read = await client.readFile({ path: "probe/out.txt" });
  if (read.content !== "probe-ok\n") fail(`readFile content = ${JSON.stringify(read.content)}`);
  const host = await exec("cat", [path.join(workspaceRoot, "probe/out.txt")]);
  if (host.stdout !== "probe-ok\n") fail("the bind mount did not carry the write back to the host workspace");
  console.log("==> write/read ok through the bind mount");

  // containment via the file tools: outside paths are refused.
  let refused = false;
  try {
    await client.readFile({ path: "/etc/passwd" });
  } catch {
    refused = true;
  }
  if (!refused) fail("readFile(/etc/passwd) was not refused");
  console.log("==> containment ok: an outside path is refused");
} finally {
  await client.close().catch(() => undefined);
  await launcher.stop().catch(() => undefined);
}

// 4. cleanup: nothing labelled with the probe remains.
const { stdout: remaining } = await exec("docker", ["ps", "-a", "--filter", "name=opensand-probe-s2", "--format", "{{.ID}}"]);
if (remaining.trim() !== "") fail(`container still present after stop: ${remaining.trim()}`);
console.log("target-probe: container ok");
process.exit(0);
DRIVER

echo "==> running the container probe"
node "$STAGE/driver.mjs" "$ROOT/dist/target" "$WS" "$STAGE/targets.json"
echo "target-probe: container done"
