import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  while (cur !== path.dirname(cur)) {
    const pkgJson = path.join(cur, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const data = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        if (data.name === 'opensand') return cur;
      } catch {}
    }
    cur = path.dirname(cur);
  }
  throw new Error(`Repo root not found starting from ${startDir}`);
}

const repoRoot = findRepoRoot(__dirname);
const syncScriptPath = path.join(repoRoot, 'scripts/sync-versions.js');
const syncScriptUrl = pathToFileURL(syncScriptPath).href;

function createTempMonorepo(initialVersion: string = '0.1.0') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensand-version-test-'));
  const rootPkg = {
    name: 'opensand',
    version: initialVersion,
    private: true,
  };
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');

  const packagesDir = path.join(tmpDir, 'packages');
  fs.mkdirSync(packagesDir, { recursive: true });

  const pkgNames = ['cli', 'coordinator', 'desktop', 'local-exec-daemon', 'native-bridge', 'shared'];
  for (const name of pkgNames) {
    const pkgDir = path.join(packagesDir, name);
    fs.mkdirSync(pkgDir, { recursive: true });
    const pkgJson = {
      name: `@opensand/${name}`,
      version: initialVersion,
    };
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
  }

  return {
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

test('live repo: all core workspace packages match root package.json version', async () => {
  const { checkVersions } = await import(syncScriptUrl);
  const result = checkVersions({ baseDir: repoRoot });
  assert.equal(result.valid, true, `Mismatches found in repo: ${JSON.stringify(result.mismatches)}`);
  assert.equal(result.mismatches.length, 0);
  assert.ok(result.checkedPackages >= 7);
});

test('checkVersions: detects package version drift in monorepo fixture', async () => {
  const { tmpDir, cleanup } = createTempMonorepo('0.1.0');
  try {
    const { checkVersions } = await import(syncScriptUrl);

    // Initial check should be clean
    let result = checkVersions({ baseDir: tmpDir });
    assert.equal(result.valid, true);
    assert.equal(result.mismatches.length, 0);

    // Cause drift in desktop package
    const desktopPkgPath = path.join(tmpDir, 'packages/desktop/package.json');
    const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, 'utf8'));
    desktopPkg.version = '0.2.0';
    fs.writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n');

    // Verification must now fail and report the desktop mismatch
    result = checkVersions({ baseDir: tmpDir });
    assert.equal(result.valid, false);
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].name, '@opensand/desktop');
    assert.equal(result.mismatches[0].current, '0.2.0');
    assert.equal(result.mismatches[0].expected, '0.1.0');
  } finally {
    cleanup();
  }
});

test('checkVersions: detects mismatch when release target version differs from package.json', async () => {
  const { tmpDir, cleanup } = createTempMonorepo('0.1.0');
  try {
    const { checkVersions } = await import(syncScriptUrl);

    // Target version v0.1.1 should fail because packages are at 0.1.0
    const result = checkVersions({ baseDir: tmpDir, targetVersion: 'v0.1.1' });
    assert.equal(result.valid, false);
    assert.ok(result.mismatches.length > 0);
    const rootMismatch = result.mismatches.find((m: any) => m.name === 'opensand');
    assert.ok(rootMismatch);
    assert.equal(rootMismatch?.current, '0.1.0');
    assert.equal(rootMismatch?.expected, '0.1.1');
  } finally {
    cleanup();
  }
});

test('syncVersions: updates root and all workspace packages and rejects invalid semver', async () => {
  const { tmpDir, cleanup } = createTempMonorepo('0.1.0');
  try {
    const { syncVersions, checkVersions } = await import(syncScriptUrl);

    // Rejects invalid semver
    assert.throws(
      () => syncVersions({ baseDir: tmpDir, targetVersion: 'not-a-version' }),
      /Invalid semver version format/,
    );

    // Sync to 0.1.1 with leading 'v'
    const syncResult = syncVersions({ baseDir: tmpDir, targetVersion: 'v0.1.1' });
    assert.equal(syncResult.version, '0.1.1');
    assert.ok(syncResult.updated.length >= 7);

    // All packages must now be 0.1.1
    const checkResult = checkVersions({ baseDir: tmpDir });
    assert.equal(checkResult.valid, true);
    assert.equal(checkResult.expectedVersion, '0.1.1');
  } finally {
    cleanup();
  }
});

test('scripts/verify.sh: release tag guard prevents execution when tag mismatches package version', () => {
  const verifyScript = path.join(repoRoot, 'scripts/verify.sh');

  // Mismatched tag should fail with non-zero exit code and explicit error message
  assert.throws(
    () => {
      execFileSync('bash', [verifyScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          RELEASE_TAG: 'v9.9.9',
          SKIP_INSTALL: '1',
        },
        stdio: 'pipe',
      });
    },
    (err: any) => {
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      const combined = stdout + stderr;
      assert.ok(
        combined.includes("Release tag 'v9.9.9' (version '9.9.9') does not match root package.json version"),
        `Expected error message not found in output: ${combined}`,
      );
      assert.equal(err.status, 1);
      return true;
    },
  );
});
