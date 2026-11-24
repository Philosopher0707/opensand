import test from "node:test";
import assert from "node:assert";
import {
  GALLERY_CATEGORIES,
  GALLERY_EMPTY_STATE,
  PUBLISH_DEFAULT_AUTHOR,
  PUBLISH_FALLBACK_AUTHOR,
  categoryEmoji,
  galleryCardView,
  parseTags,
  previewView,
  publishDescription,
  templateSlug,
} from "../src/shell/gallery-model.js";

test("gallery-model: category emojis and chip list", () => {
  assert.strictEqual(categoryEmoji("engineering"), "🛠️");
  assert.strictEqual(categoryEmoji("security"), "🛡️");
  assert.strictEqual(categoryEmoji("product"), "📐");
  assert.strictEqual(categoryEmoji("research"), "🔬");
  assert.strictEqual(categoryEmoji("community"), "🌐");
  assert.strictEqual(categoryEmoji("other"), "🤖");
  assert.deepStrictEqual([...GALLERY_CATEGORIES], ["all", "engineering", "security", "product", "research", "community"]);
});

test("gallery-model: card view uses metadata fallbacks", () => {
  const card = galleryCardView({ id: "tpl-1", name: " Test ", tags: ["a", "b", "c", "d", "e"], rating: 4.25, downloads: 1234 });
  assert.strictEqual(card.icon, "🤖");
  assert.strictEqual(card.title, "Test");
  assert.strictEqual(card.role, "General");
  assert.deepStrictEqual(card.tags, ["a", "b", "c", "d"]);
  assert.strictEqual(card.rating, "4.3");
  assert.strictEqual(card.downloads, "1,234");
  assert.strictEqual(card.author, "Official");
  assert.strictEqual(card.badge, "Community");
  assert.strictEqual(card.installed, false);

  const curated = galleryCardView({ id: "tpl-2", metadata: { category: "security", description: "Sec", author: "Team", installed: true }, isCurated: true });
  assert.strictEqual(curated.icon, "🛡️");
  assert.strictEqual(curated.description, "Sec");
  assert.strictEqual(curated.author, "Team");
  assert.strictEqual(curated.badge, "Official");
  assert.strictEqual(curated.badgeClass, "badge-success");
  assert.strictEqual(curated.installed, true);
});

test("gallery-model: preview resolves metadata, tools and tasks", () => {
  const view = previewView({
    id: "tpl-3", name: "Reviewer", role: "Code review", model: "gpt", systemPrompt: "Review code.",
    metadata: { category: "engineering", version: "2.1", rating: 4.5, downloads: 10 },
    allowedTools: ["read", "grep"], suggestedTasks: ["Review a diff"],
  });
  assert.strictEqual(view.icon, "🛠️");
  assert.strictEqual(view.title, "Reviewer");
  assert.deepStrictEqual(view.badges.slice(0, 3), ["engineering", "Model: gpt", "Author: Official"]);
  assert.ok(view.badges.includes("v2.1"));
  assert.deepStrictEqual(view.tools, ["read", "grep"]);
  assert.deepStrictEqual(view.tasks, ["Review a diff"]);
  assert.strictEqual(view.prompt, "Review code.");
  const empty = previewView({ id: "x" });
  assert.deepStrictEqual(empty.tools, []);
  assert.deepStrictEqual(empty.tasks, []);
});

test("gallery-model: publish helpers", () => {
  assert.deepStrictEqual(parseTags(" Testing, FAST-api , , automation "), ["testing", "fast-api", "automation"]);
  assert.strictEqual(templateSlug("My Cool Bot!", "id-1"), "my-cool-bot");
  assert.strictEqual(templateSlug("!!!", "id-2"), "id-2");
  assert.strictEqual(publishDescription("Reviewer", "x".repeat(200)).length, "Reviewer: ".length + 160 + 3);
  assert.ok(PUBLISH_DEFAULT_AUTHOR.length > 0);
  assert.ok(PUBLISH_FALLBACK_AUTHOR.length > 0);
  assert.ok(GALLERY_EMPTY_STATE.includes("No agent templates"));
});
