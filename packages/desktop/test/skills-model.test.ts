import test from "node:test";
import assert from "node:assert";
import {
  SKILL_EMPTY_STATE,
  SKILL_VALIDATION_MESSAGE,
  closeCreateSkillModal,
  closeSkillPreview,
  createInitialModalState,
  openCreateSkillModal,
  openSkillPreview,
  skillCardView,
  validateCreateSkillInput,
  type Skill,
} from "../src/shell/skills-model.js";

const valid = { name: "postgresql-tuning", description: "Query tuning", content: "---\nname: postgresql-tuning\n---\n# Recipe" };

test("skills-model: validation requires all three fields", () => {
  assert.strictEqual(validateCreateSkillInput(valid), null);
  assert.strictEqual(validateCreateSkillInput({ ...valid, name: "" }), SKILL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateSkillInput({ ...valid, description: "" }), SKILL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateSkillInput({ ...valid, content: "" }), SKILL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateSkillInput({ name: "", description: "", content: "" }), SKILL_VALIDATION_MESSAGE);
});

test("skills-model: whitespace-only fields are rejected", () => {
  assert.strictEqual(validateCreateSkillInput({ ...valid, name: "   " }), SKILL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateSkillInput({ ...valid, description: "\n\t" }), SKILL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateSkillInput({ ...valid, content: "  \n  " }), SKILL_VALIDATION_MESSAGE);
  assert.strictEqual(validateCreateSkillInput({ name: " a ", description: " b ", content: " c " }), null);
});

test("skills-model: card view applies defaults", () => {
  assert.deepStrictEqual(skillCardView({ id: "skill-1" }), {
    title: "skill-1",
    category: "general",
    description: "No description.",
    origin: "custom",
    bytesLabel: "0 bytes",
  });
});

test("skills-model: card view uses supplied fields and trimmed values", () => {
  const skill: Skill = {
    id: "skill-2",
    name: "  Tuning  ",
    category: " database ",
    description: "  Index guidance  ",
    origin: " bundled ",
    content: "12345",
  };
  assert.deepStrictEqual(skillCardView(skill), {
    title: "Tuning",
    category: "database",
    description: "Index guidance",
    origin: "bundled",
    bytesLabel: "5 bytes",
  });
  assert.strictEqual(skillCardView({ id: "s", name: "   ", content: "ab" }).title, "s");
});

test("skills-model: modal open/close and preview helpers", () => {
  const initial = createInitialModalState();
  assert.deepStrictEqual(initial, { createSkillModalOpen: false, previewSkill: null });

  const created = openCreateSkillModal(initial);
  assert.strictEqual(created.createSkillModalOpen, true);
  assert.deepStrictEqual(closeCreateSkillModal(created), initial);

  const skill = { id: "skill-3", name: "Recipe" };
  const preview = openSkillPreview(created, skill);
  assert.strictEqual(preview.createSkillModalOpen, true, "opening a preview preserves create-modal state");
  assert.strictEqual(preview.previewSkill, skill);
  assert.deepStrictEqual(closeSkillPreview(preview), created);
});

test("skills-model: empty state mentions the create button", () => {
  assert.ok(SKILL_EMPTY_STATE.includes('+ New Skill'));
  assert.ok(SKILL_EMPTY_STATE.includes('No modular recipe skills in library.'));
});
