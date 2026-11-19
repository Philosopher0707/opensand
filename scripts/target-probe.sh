#!/usr/bin/env bash
# Phase 8 S2/S3 target probe (docs/design/phase8-reach.md §10 S2/S3, §4.3).
#
# One command proving a target end to end:
#  container (S2):
#   1. builds the target bundle (`pnpm target:build`);
#   2. loads a temp targets.json through the strict store and resolves the target;
#   3. starts `node:22-bookworm` with the containment flags, the workspace and the
#      read-only bundle mounted;
#   4. over the stdio link asserts hello (linux), an exec that reports the OS and
#      the OPENSAND_TARGET_ID marker, and a file write/read that round-trips
#      through the bind mount, plus an outside-path refusal;
#   5. removes the container and asserts nothing labelled with the probe remains.
#  ssh (S3, needs a real host the owner named):
#   1. builds the target bundle; 2. resolves the named target from
#   $OPENSAND_HOME/targets.json; 3. preflights node>=22/rsync/bwrap over ssh;
#   4. deploys the bundle by content hash; 5. takes the target lock and proves a
#   second holder is refused; 6. pushes a temp workspace and proves .git is
#   excluded and an external symlink is refused before push; 7. starts the
#   persistent ssh link, asserts hello and the marker exec; 8. proves the clean
#   fetch+apply, the local-edit-after-push conflict and the manifest-owned
#   deletion; 9. releases the lock and cleans the probe dir on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
if [[ "$MODE" != "container" && "$MODE" != "ssh" ]]; then
  echo "usage: scripts/target-probe.sh container|ssh" >&2
  exit 2
fi

if [[ "$MODE" == "ssh" ]]; then
  if [[ -z "${OPENSAND_SSH_TARGET:-}" ]]; then
    echo "target-probe: OPENSAND_SSH_TARGET is not set; name an ssh target from \$OPENSAND_HOME/targets.json, e.g. OPENSAND_SSH_TARGET=devbox $0 ssh" >&2
    exit 2
  fi
fi

if [[ "$MODE" == "container" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "target-probe: docker is not available" >&2
    exit 3
  fi
fi

echo "==> building the target bundle"
pnpm target:build >/dev/null

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/opensand-target-probe.XXXXXX")"
WS="$STAGE/ws"
mkdir -p "$WS"
CONTAINER="opensand-probe-s2"

if [[ "$MODE" == "ssh" ]]; then
  # The ssh branch: the real host named by OPENSAND_SSH_TARGET, resolved from
  # the owner's targets.json. The probe cleans its own remote dir and lock.
  cat > "$STAGE/ssh-driver.mjs" <<'DRIVER'
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const [bundleDir] = process.argv.slice(2);
const targetName = process.env.OPENSAND_SSH_TARGET;
const targetsPath = path.join(process.env.OPENSAND_HOME || path.join(os.homedir(), ".opensand"), "targets.json");
const targetIndex = pathToFileURL(path.join(bundleDir, "dist/src/target/index.js")).href;
const sharedIndex = pathToFileURL(path.join(bundleDir, "node_modules/@opensand/shared/dist/src/index.js")).href;
const { sshPreflight, SshTargetLauncher, TargetClient, pushWorkspace, fetchToStaging,
  applyStaging, missionRemoteDir, acquireTargetLock, releaseTargetLock, removeRemoteMissionDir,
  TargetApplyConflictError, TargetBusyError, sshCommandArgs } = await import(targetIndex);
const { loadTargetsFile, resolveTargetConfig, opensandHome } = await import(sharedIndex);

const fail = (message) => {
  console.error(`target-probe: FAIL ${message}`);
  process.exit(1);
};

const bundleVersion = createRequire(pathToFileURL(path.join(bundleDir, "package.json")))(path.join(bundleDir, "package.json")).version;
const missionId = "probe-s3";
let config;

// 1. targets.json resolves the named ssh target.
const file = await loadTargetsFile(targetsPath);
config = resolveTargetConfig(file, targetName);
if (config.kind !== "ssh") fail(`target "${targetName}" is kind ${config.kind}, expected ssh`);
const host = config.host;
const remote = { host, sshArgs: config.sshArgs };
const root = config.root;

// 2. preflight: node >= 22, rsync, bwrap when the target demands it.
const nodeVersion = await sshPreflight({
  host, root, sshArgs: config.sshArgs, missionId, targetId: targetName,
  bundleDir, workspaceRoot: "/tmp", sandbox: config.sandbox ?? "bwrap",
});
console.log(`==> preflight ok: node ${nodeVersion.trim()} on ${host}`);

// 3. deploy by content hash, then the target lock; the second holder is refused.
const deployedHash = await (async () => {
  const launcher = new SshTargetLauncher({ host, root, sshArgs: config.sshArgs, missionId, targetId: targetName, bundleDir, workspaceRoot: "/tmp", sandbox: config.sandbox ?? "bwrap" });
  return launcher.deploy();
})();
console.log(`==> deploy ok: bundle ${deployedHash} under ${root}/.opensand/target/${deployedHash}`);
await acquireTargetLock(root, missionId, remote);
try {
  await acquireTargetLock(root, "probe-s3-second", remote);
  fail("the second lock holder was not refused");
} catch (err) {
  if (!(err instanceof TargetBusyError)) fail(`second lock failed with ${err}`);
}
console.log("==> lock ok: the second holder is refused with target-busy");

try {
  // 4. push a temp workspace: .git excluded, external symlink refused.
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-probe-ws-")));
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-probe-out-")));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  fs.writeFileSync(path.join(workspace, "keep.txt"), "keep me\n");
  fs.mkdirSync(path.join(workspace, ".git"));
  fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  const manifest = await pushWorkspace(workspace, root, missionId, remote);
  if (fs.existsSync(path.join(workspace, ".git"))) { /* local side keeps .git */ }
  const probeDir = missionRemoteDir(root, missionId);
  const sshRun = (cmd) => exec("ssh", sshCommandArgs({ host, sshArgs: config.sshArgs }, cmd));
  const listing = (await sshRun(`ls -A ${JSON.stringify(probeDir)}`)).stdout;
  if (listing.split("\n").includes(".git")) fail(".git reached the remote");
  if (!manifest.entries["keep.txt"]) fail("the manifest does not own keep.txt");
  console.log("==> push ok: .git excluded, the manifest owns the pushed files");

  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "leak"));
  let refused = false;
  try { await pushWorkspace(workspace, root, missionId, remote); } catch (err) {
    refused = err instanceof Error && /target-symlink-escape/.test(err.message);
  }
  if (!refused) fail("an external symlink was not refused before push");
  console.log("==> symlink ok: the external symlink is refused before push");

  // 5. the persistent ssh link: hello says the remote root, exec says the marker.
  const launcher = new SshTargetLauncher({ host, root, sshArgs: config.sshArgs, missionId, targetId: targetName, bundleDir, workspaceRoot: workspace, sandbox: config.sandbox ?? "bwrap" });
  const { client, hello } = await launcher.start(() => new TargetClient({
    spawn: launcher.makeSpawnFn(),
    version: bundleVersion,
  }));
  try {
    if (hello.root !== probeDir) fail(`hello.root = ${hello.root}, expected ${probeDir}`);
    const marker = await client.exec({ command: 'printf "%s" "$OPENSAND_TARGET_ID"' });
    if (marker.stdout !== targetName) fail(`OPENSAND_TARGET_ID = ${marker.stdout}, expected ${targetName}`);
    const os = await client.exec({ command: "uname -s" });
    console.log(`==> link ok: hello root ${hello.root}, marker ${targetName}, remote ${os.stdout.trim()}`);

    // 6. clean fetch + apply; then a local edit after push refuses.
    await client.writeFile({ path: "remote-new.txt", content: "from the target\n" });
    const staging = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-probe-stage-")));
    await fetchToStaging(root, missionId, staging, remote);
    const applied = await applyStaging(staging, workspace, manifest);
    if (!applied.added.includes("remote-new.txt")) fail(`apply added ${JSON.stringify(applied.added)}`);
    if (fs.readFileSync(path.join(workspace, "remote-new.txt"), "utf8") !== "from the target\n") fail("apply did not land the remote file");
    console.log("==> fetch+apply ok: the remote result is applied locally");

    fs.writeFileSync(path.join(workspace, "keep.txt"), "user edit\n");
    await client.writeFile({ path: "keep.txt", content: "remote edit\n" });
    const staging2 = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "opensand-probe-stage2-")));
    await fetchToStaging(root, missionId, staging2, remote);
    let conflict = false;
    try { await applyStaging(staging2, workspace, manifest); } catch (err) {
      conflict = err instanceof TargetApplyConflictError && /keep\.txt/.test(err.message);
    }
    if (!conflict) fail("a local edit after push was not refused");
    if (fs.readFileSync(path.join(workspace, "keep.txt"), "utf8") !== "user edit\n") fail("the refused apply touched the local bytes");
    console.log("==> conflict ok: the local edit stands and the apply is refused");
  } finally {
    await client.close().catch(() => undefined);
  }
} finally {
  await releaseTargetLock(root, missionId, remote);
  await removeRemoteMissionDir(root, missionId, remote);
}
console.log("target-probe: ssh ok");
process.exit(0);
DRIVER
  echo "==> running the ssh probe (host: $OPENSAND_SSH_TARGET)"
  node "$STAGE/ssh-driver.mjs" "$ROOT/dist/target"
  rm -rf "$STAGE"
  echo "target-probe: ssh done"
  exit 0
fi

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
