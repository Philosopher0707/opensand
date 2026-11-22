import test from "node:test";
import assert from "node:assert";
import { navigateToView } from "./helpers/navigate-view.js";

test("navigateToView re-dispatches until the view is visible", async () => {
  const codes: string[] = [];
  let checks = 0;
  const page = {
    async js(code: string) {
      codes.push(code);
      if (code.startsWith("Boolean(")) return ++checks === 3;
      return true;
    },
    async sleep() {},
  };
  await navigateToView(page, "#skills", "#viewSkills", 500);
  assert.strictEqual(checks, 3);
  assert.strictEqual(codes.filter((c) => c.includes("hashchange")).length, 2);
  assert.ok(codes.some((c) => c.includes('"#skills"')));
  assert.ok(codes.some((c) => c.includes('"#viewSkills"')));
});

test("navigateToView fails closed instead of waiting forever", async () => {
  const page = { async js() { return false; }, async sleep() {} };
  await assert.rejects(navigateToView(page, "#skills", "#viewSkills", 20), /timed out/);
});
