// Pure model for the Continuous Learned Guidelines modal (Phase 5 Row 27).
// Mirrors the legacy renderer/app.js learned-rules controller without DOM or bridge code.

export interface LearnedRules {
  content?: string;
  [key: string]: unknown;
}

export interface LearnedRulesReport {
  markdownSummary?: string;
  summary?: string;
  [key: string]: unknown;
}

export const LEARNED_RULES_EMPTY = "No learned rules yet.";
export const LEARNED_RULES_LOADING = "Loading learned rules...";
export const LEARNED_RULES_REFRESHING = "Re-analyzing past conversation transcripts according to Grok Bot standards...";
export const LEARNED_RULES_DONE = "Analysis complete.";

export function rulesContent(rules: LearnedRules | null | undefined): string {
  return rules?.content?.trim() || LEARNED_RULES_EMPTY;
}

export function reportSummary(report: LearnedRulesReport | null | undefined): string {
  return report?.markdownSummary?.trim() || report?.summary?.trim() || LEARNED_RULES_DONE;
}
