#!/usr/bin/env node
/**
 * Synchronize package versions across the OpenSand monorepo.
 *
 * Usage:
 *   node scripts/sync-versions.js            # Sync all workspace packages to root package.json version
 *   node scripts/sync-versions.js <version>  # Set root and all workspace packages to <version>
 *   node scripts/sync-versions.js --check    # Check version consistency without modifying files (exit 1 on mismatch)
 *   node scripts/sync-versions.js --check <version> # Check that all packages match <version>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function getWorkspacePackageJsonPaths(baseDir = rootDir) {
  const packagesDir = path.join(baseDir, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        paths.push(pkgJsonPath);
      }
    }
  }
  return paths;
}

export function checkVersions({ targetVersion, baseDir = rootDir } = {}) {
  const rootPkgPath = path.join(baseDir, 'package.json');
  if (!fs.existsSync(rootPkgPath)) {
    throw new Error(`Root package.json not found at ${rootPkgPath}`);
  }

  const rootPkg = readJson(rootPkgPath);
  const expectedVersion = targetVersion ? targetVersion.replace(/^v/, '') : rootPkg.version;

  if (!expectedVersion) {
    throw new Error('No target version provided and root package.json has no version');
  }

  const mismatches = [];

  if (targetVersion && rootPkg.version !== expectedVersion) {
    mismatches.push({
      file: path.relative(baseDir, rootPkgPath),
      name: rootPkg.name || 'root',
      current: rootPkg.version,
      expected: expectedVersion,
    });
  }

  const pkgPaths = getWorkspacePackageJsonPaths(baseDir);
  for (const pkgPath of pkgPaths) {
    const pkg = readJson(pkgPath);
    if (pkg.version !== expectedVersion) {
      mismatches.push({
        file: path.relative(baseDir, pkgPath),
        name: pkg.name || path.basename(path.dirname(pkgPath)),
        current: pkg.version,
        expected: expectedVersion,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    expectedVersion,
    mismatches,
    checkedPackages: pkgPaths.length + (targetVersion ? 1 : 0),
  };
}

export function syncVersions({ targetVersion, baseDir = rootDir } = {}) {
  const rootPkgPath = path.join(baseDir, 'package.json');
  if (!fs.existsSync(rootPkgPath)) {
    throw new Error(`Root package.json not found at ${rootPkgPath}`);
  }

  const rootPkg = readJson(rootPkgPath);
  const resolvedVersion = targetVersion ? targetVersion.replace(/^v/, '') : rootPkg.version;

  if (!resolvedVersion) {
    throw new Error('No target version specified and root package.json has no version');
  }

  if (!SEMVER_REGEX.test(resolvedVersion)) {
    throw new Error(`Invalid semver version format: "${resolvedVersion}". Expected format like "0.1.0" or "1.0.0-rc.1".`);
  }

  const updated = [];

  // Update root package.json if needed
  if (rootPkg.version !== resolvedVersion) {
    const old = rootPkg.version;
    rootPkg.version = resolvedVersion;
    writeJson(rootPkgPath, rootPkg);
    updated.push({
      file: path.relative(baseDir, rootPkgPath),
      name: rootPkg.name || 'root',
      from: old,
      to: resolvedVersion,
    });
  }

  // Update all workspace packages
  const pkgPaths = getWorkspacePackageJsonPaths(baseDir);
  for (const pkgPath of pkgPaths) {
    const pkg = readJson(pkgPath);
    const old = pkg.version;
    if (old !== resolvedVersion) {
      pkg.version = resolvedVersion;
      writeJson(pkgPath, pkg);
      updated.push({
        file: path.relative(baseDir, pkgPath),
        name: pkg.name || path.basename(path.dirname(pkgPath)),
        from: old,
        to: resolvedVersion,
      });
    }
  }

  return {
    version: resolvedVersion,
    updated,
    totalChecked: pkgPaths.length + 1,
  };
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const nonFlagArgs = args.filter((a) => !a.startsWith('--'));
  const versionArg = nonFlagArgs[0];

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
OpenSand Monorepo Version Synchronizer

Usage:
  node scripts/sync-versions.js            Sync all workspace packages to root package.json version
  node scripts/sync-versions.js <version>  Set root and all workspace packages to <version>
  node scripts/sync-versions.js --check    Check that all workspace packages match root version
  node scripts/sync-versions.js --check <version> Check that all packages match <version>
`);
    process.exit(0);
  }

  try {
    if (isCheck) {
      const result = checkVersions({ targetVersion: versionArg });
      if (!result.valid) {
        console.error(`\x1b[31mVersion consistency check FAILED:\x1b[0m`);
        for (const m of result.mismatches) {
          console.error(`  - ${m.file} (${m.name}): found "${m.current}", expected "${m.expected}"`);
        }
        console.error(`\nRun 'node scripts/sync-versions.js' to synchronize versions across packages.`);
        process.exit(1);
      }
      console.log(`\x1b[32m✔ Version consistency check passed:\x1b[0m all packages match version ${result.expectedVersion}`);
      process.exit(0);
    } else {
      const result = syncVersions({ targetVersion: versionArg });
      if (result.updated.length === 0) {
        console.log(`All packages are already at version ${result.version}. No changes needed.`);
      } else {
        console.log(`\x1b[32m✔ Synchronized ${result.updated.length} package(s) to version ${result.version}:\x1b[0m`);
        for (const u of result.updated) {
          console.log(`  - ${u.file} (${u.name}): ${u.from} -> ${u.to}`);
        }
      }
      process.exit(0);
    }
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
    process.exit(1);
  }
}
