import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runDoctorProbes } from "../src/doctor.js";
import { getFleetStatus } from "../src/status.js";

test("Doctor - runs system environment and diagnostic preflight probes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-doctor-test-"));

  try {
    const { probes, allCriticalPassed } = await runDoctorProbes({
      baseDir: tmpDir,
      endpoint: "http://127.0.0.1:11434/v1",
      apiKey: "none",
    });

    assert.ok(probes.length >= 7);
    const nodeProbe = probes.find((p) => p.name === "Node.js Environment");
    assert.ok(nodeProbe);
    assert.strictEqual(nodeProbe?.passed, true);

    const dirProbe = probes.find((p) => p.name === "OpenSand Storage Directory");
    assert.ok(dirProbe);
    assert.strictEqual(dirProbe?.passed, true);

    const toolsProbe = probes.find((p) => p.name === "Active Tool Catalog Integrity");
    assert.ok(toolsProbe);
    assert.strictEqual(toolsProbe?.passed, true);

    assert.strictEqual(allCriticalPassed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Status - aggregates complete agent fleet counts", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensand-status-test-"));

  try {
    const fleet = await getFleetStatus(tmpDir);
    assert.strictEqual(fleet.agents.length, 0);
    assert.strictEqual(fleet.rooms.length, 0);
    assert.strictEqual(fleet.routines.length, 0);
    assert.strictEqual(fleet.skills.length, 0);
    assert.strictEqual(fleet.secrets.length, 0);
    assert.strictEqual(fleet.attachments.length, 0);
    assert.strictEqual(fleet.tasks.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
