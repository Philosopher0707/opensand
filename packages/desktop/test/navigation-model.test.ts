import test from "node:test";
import assert from "node:assert";
import {
  NAV_GROUPS,
  VIEW_IDS,
  VIEW_TITLES,
  groupForView,
  isFooterNavActive,
  isViewId,
  parseViewFromLocation,
  viewHash,
  viewPanelId,
} from "../src/shell/navigation-model.js";

test("navigation-model: every view has a title and a unique panel id", () => {
  const ids = new Set<string>();
  for (const view of VIEW_IDS) {
    assert.ok(VIEW_TITLES[view], `missing title for ${view}`);
    const panelId = viewPanelId(view);
    assert.ok(!ids.has(panelId), `duplicate panel id ${panelId}`);
    ids.add(panelId);
  }
  assert.strictEqual(viewPanelId("chat"), "viewChat");
  assert.strictEqual(viewPanelId("graphs"), "viewGraphs");
  assert.strictEqual(viewPanelId("webhooks"), "viewWebhooks");
});

test("navigation-model: footer groups match the legacy view mapping", () => {
  const byId = Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g]));
  assert.deepStrictEqual(
    byId.templates.tabs.map((t) => t.view),
    ["templates", "gallery"]
  );
  assert.deepStrictEqual(
    byId.capabilities.tabs.map((t) => t.view),
    ["skills", "memories", "routines", "vault"]
  );
  assert.deepStrictEqual(
    byId.connections.tabs.map((t) => t.view),
    ["boundaries", "webhooks", "connectors", "attachments", "graphs", "rooms"]
  );
  assert.strictEqual(byId.templates.buttonId, "navBtnBots");
  assert.strictEqual(byId.capabilities.buttonId, "navBtnCapabilities");
  assert.strictEqual(byId.connections.buttonId, "navBtnConnections");
  assert.strictEqual(byId.capabilities.view, "skills");
  assert.strictEqual(byId.connections.view, "boundaries");
  assert.strictEqual(byId.templates.view, "templates");
});

test("navigation-model: grouped views belong to exactly one group; sentinel, settings and welcome are deep-link only", () => {
  assert.strictEqual(groupForView("chat"), null, "chat has no subnav group");
  // Legacy app.js has no footer button or subnav tab for sentinel; it is reachable by deep link.
  assert.strictEqual(groupForView("sentinel"), null, "sentinel is not in a footer group");
  assert.strictEqual(groupForView("settings"), null, "settings is opened from the account popup");
  assert.strictEqual(groupForView("welcome"), null, "welcome is only shown on first run");
  for (const group of NAV_GROUPS) {
    for (const tab of group.tabs) {
      assert.strictEqual(groupForView(tab.view), group, `${tab.view} belongs to ${group.id}`);
    }
  }
  for (const view of VIEW_IDS) {
    if (view === "chat" || view === "sentinel" || view === "settings" || view === "welcome") continue;
    assert.ok(groupForView(view), `${view} should belong to a group`);
  }
});

test("navigation-model: footer active state follows the group, not the exact view", () => {
  assert.strictEqual(isFooterNavActive("gallery", "templates"), true);
  assert.strictEqual(isFooterNavActive("skills", "templates"), false);
  assert.strictEqual(isFooterNavActive("rooms", "connections"), true);
  assert.strictEqual(isFooterNavActive("vault", "capabilities"), true);
  assert.strictEqual(isFooterNavActive("chat", "capabilities"), false);
});

test("navigation-model: isViewId rejects unknown and empty values", () => {
  assert.strictEqual(isViewId("graphs"), true);
  assert.strictEqual(isViewId("nope"), false);
  assert.strictEqual(isViewId(""), false);
  assert.strictEqual(isViewId(null), false);
  assert.strictEqual(isViewId(undefined), false);
});

test("navigation-model: deep links prefer hash, then query, then chat", () => {
  assert.strictEqual(parseViewFromLocation("", "#graphs"), "graphs");
  assert.strictEqual(parseViewFromLocation("?view=sentinel", ""), "sentinel");
  assert.strictEqual(parseViewFromLocation("?view=sentinel", "#graphs"), "graphs");
  assert.strictEqual(parseViewFromLocation("?view=webhooks", "#bogus"), "webhooks");
  assert.strictEqual(parseViewFromLocation("", "#bogus"), "chat");
  assert.strictEqual(parseViewFromLocation("", ""), "chat");
  assert.strictEqual(parseViewFromLocation("?view=bogus", "#also-bogus"), "chat");
  assert.strictEqual(viewHash("graphs"), "#graphs");
});

test("navigation-model: /welcome is a view, but an explicit hash or query still wins", () => {
  assert.strictEqual(isViewId("welcome"), true);
  assert.ok(VIEW_TITLES.welcome, "welcome has a title");
  assert.strictEqual(parseViewFromLocation("", "", "/welcome"), "welcome");
  assert.strictEqual(parseViewFromLocation("", "", "/welcome/"), "welcome");
  assert.strictEqual(parseViewFromLocation("", "", "/chat"), "chat");
  assert.strictEqual(parseViewFromLocation("", "#settings", "/welcome"), "settings");
  assert.strictEqual(parseViewFromLocation("?view=rooms", "", "/welcome"), "rooms");
  assert.strictEqual(parseViewFromLocation("", "#chat", "/welcome"), "chat");
});
