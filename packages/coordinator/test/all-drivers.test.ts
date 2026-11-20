import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_DRIVERS } from "../src/built-in-drivers.js";
import { providerRegistry } from "../src/provider-registry.js";

describe("all built-in drivers (OpenMausBot parity)", () => {
  it("registers 26 unique driver kinds", () => {
    const kinds = BUILT_IN_DRIVERS.map((d) => d.driverKind);
    assert.equal(kinds.length, 26);
    assert.equal(new Set(kinds).size, 26);
    for (const driver of BUILT_IN_DRIVERS) {
      assert.equal(providerRegistry.getDriver(driver.driverKind), driver);
    }
  });

  it("every driver validates config and exposes a usable catalog", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const config = driver.decodeConfig({});
      assert.ok(config && typeof config === "object", `${driver.driverKind}: config`);
      assert.deepEqual(driver.defaultConfig(), config, `${driver.driverKind}: defaultConfig`);
      assert.ok(driver.metadata.displayName.length > 0, `${driver.driverKind}: displayName`);
      assert.equal(typeof driver.models.default, "string", `${driver.driverKind}: catalog default`);
      assert.ok(Array.isArray(driver.models.options), `${driver.driverKind}: catalog options`);
      assert.throws(
        () => driver.decodeConfig({ url: 42, cli: 42, apiKeyEnv: 42, fullAuto: "yes" }),
        /must (be a string|be a boolean)/,
        `${driver.driverKind}: rejects invalid config`
      );
    }
  });

  it("every driver creates a disposable instance with a matching snapshot", async () => {
    for (const driver of BUILT_IN_DRIVERS) {
      const instance = await driver.create({
        instanceId: `all-${driver.driverKind}`,
        displayName: driver.metadata.displayName,
        environment: {},
        enabled: true,
        config: driver.defaultConfig(),
      });
      assert.equal(instance.instanceId, `all-${driver.driverKind}`);
      assert.equal(instance.driverKind, driver.driverKind);
      assert.equal(instance.adapter.provider, driver.driverKind);
      assert.equal(instance.enabled, true);
      const snapshot = await instance.snapshot();
      assert.equal(snapshot.instanceId, instance.instanceId);
      assert.equal(snapshot.driverKind, driver.driverKind);
      await instance.adapter.stopAll();
      await instance.dispose();
    }
  });
});
