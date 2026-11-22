// Pure model for the Recipe Skills view and its create/preview modals (Phase 5 Row 15).
// Mirrors the legacy renderer/app.js skill controller without any DOM or bridge code.

export interface Skill {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  origin?: string;
  content?: string;
  [key: string]: unknown;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface SkillCardView {
  title: string;
  category: string;
  description: string;
  origin: string;
  bytesLabel: string;
}

export interface SkillsModalState {
  createSkillModalOpen: boolean;
  previewSkill: Skill | null;
}

export const SKILL_VALIDATION_MESSAGE = "Please provide skill name, description and recipe content.";
export const SKILL_EMPTY_STATE = 'No modular recipe skills in library. Click "+ New Skill" to add one.';

/** Matches the server's `if (!body.name || !body.description || !body.content)` guard. */
export function validateCreateSkillInput(input: CreateSkillInput): string | null {
  if (!input.name?.trim() || !input.description?.trim() || !input.content?.trim()) {
    return SKILL_VALIDATION_MESSAGE;
  }
  return null;
}

export function skillCardView(skill: Skill): SkillCardView {
  return {
    title: skill.name?.trim() || skill.id || "Untitled skill",
    category: skill.category?.trim() || "general",
    description: skill.description?.trim() || "No description.",
    origin: skill.origin?.trim() || "custom",
    bytesLabel: `${(skill.content || "").length} bytes`,
  };
}

export function createInitialModalState(): SkillsModalState {
  return { createSkillModalOpen: false, previewSkill: null };
}

export function openCreateSkillModal(state: SkillsModalState): SkillsModalState {
  return { ...state, createSkillModalOpen: true };
}

export function closeCreateSkillModal(state: SkillsModalState): SkillsModalState {
  return { ...state, createSkillModalOpen: false };
}

export function openSkillPreview(state: SkillsModalState, skill: Skill): SkillsModalState {
  return { ...state, previewSkill: skill };
}

export function closeSkillPreview(state: SkillsModalState): SkillsModalState {
  return { ...state, previewSkill: null };
}
