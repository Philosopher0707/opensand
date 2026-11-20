/**
 * Managed single-file runtime installer. No archive tooling and no new deps.
 * Pins (URL + SHA-256 + byte size) live in config, never in fetched metadata;
 * downloads are host-allowlisted, size-capped and hash-verified before publish.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export interface ManagedRelease {
  provider: string;
  version: string;
  url: string;
  sha256: string;
  bytes: number;
  executable: string;
}

export interface ManagedInstallResult {
  executablePath: string;
  version: string;
  source: "managed";
}

const RECORD = "install-complete.json";

function rootFor(release: ManagedRelease, root?: string): string {
  return root ?? process.env.OPENSAND_RUNTIMES_ROOT
    ?? path.join(os.homedir(), ".opensand", "runtimes", `${process.platform}-${process.arch}`, release.provider);
}

/** Return the already-installed executable when its record and hash still match. */
export function resolveInstalled(release: ManagedRelease, root?: string): ManagedInstallResult | null {
  const dir = path.join(rootFor(release, root), "versions", release.sha256);
  const executablePath = path.join(dir, release.executable);
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), "utf8")) as { sha256?: string; version?: string };
    const stat = fs.statSync(executablePath);
    if (record.sha256 === release.sha256 && stat.size === release.bytes && stat.isFile()) {
      return { executablePath, version: record.version ?? release.version, source: "managed" };
    }
  } catch {
    // Missing or corrupt record: treat as not installed.
  }
  return null;
}

function checkHost(url: string, allowHosts: readonly string[]): void {
  const parsed = new URL(url);
  if (!allowHosts.length) throw new Error("No install hosts are allowlisted");
  if (parsed.protocol !== "https:" && !parsed.hostname.startsWith("127.0.0.1") && parsed.hostname !== "localhost") {
    throw new Error("Only https install URLs are allowed");
  }
  if (!allowHosts.includes(parsed.hostname)) {
    throw new Error(`Install host ${parsed.hostname} is not allowlisted`);
  }
}

/** Install a pinned single-file runtime atomically, verifying size and hash. */
export async function installManagedRuntime(
  release: ManagedRelease,
  options: { root?: string; allowHosts?: readonly string[]; timeoutMs?: number } = {}
): Promise<ManagedInstallResult> {
  const existing = resolveInstalled(release, options.root);
  if (existing) return existing;

  const root = rootFor(release, options.root);
  checkHost(release.url, options.allowHosts ?? []);
  const versionsDir = path.join(root, "versions");
  fs.mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(versionsDir, ".install-"));

  try {
    const target = path.join(staging, release.executable);
    const file = fs.openSync(target, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    try {
      const response = await fetch(release.url, {
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 45 * 60_000),
      });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared && declared !== release.bytes) throw new Error("Download size does not match the pin");

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > release.bytes) throw new Error("Download exceeded the pinned size");
        hash.update(chunk);
        fs.writeSync(file, chunk);
      }
    } finally {
      fs.closeSync(file);
    }

    if (total !== release.bytes) throw new Error(`Download size ${total} != pinned ${release.bytes}`);
    const digest = hash.digest("hex");
    if (digest !== release.sha256) throw new Error("Download hash does not match the pin");

    fs.chmodSync(target, 0o755);
    const probe = spawnSync(target, ["--version"], { encoding: "utf8", timeout: 15_000 });
    if (probe.status !== 0) throw new Error("Installed runtime failed its version smoke test");

    fs.writeFileSync(path.join(staging, RECORD), JSON.stringify({ sha256: release.sha256, version: release.version }), { mode: 0o600 });
    const destination = path.join(versionsDir, release.sha256);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      fs.cpSync(staging, destination, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return resolveInstalled(release, options.root) ?? { executablePath: path.join(destination, release.executable), version: release.version, source: "managed" };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* already renamed */ }
  }
}
