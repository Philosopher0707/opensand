import * as fs from "node:fs";
import * as path from "node:path";
import type { MissionWorkspace } from "./workspace.js";

export interface MissionAgentContext {
  workspaceRoot: string;
  missionId: string;
  /** The one file/command seam (Phase 8 S4): the agent never writes raw fs. */
  workspace: MissionWorkspace;
  [key: string]: unknown;
}

export interface MissionAgent {
  plan(goal: string, ctx: MissionAgentContext): Promise<string[]>;
  act(
    input: {
      goal: string;
      plan: string[];
      failure?: { exitCode: number; outputTail: string };
    },
    ctx: MissionAgentContext
  ): Promise<{ claim: string }>;
  review(
    input: {
      goal: string;
      diff: string;
      check: { exitCode: number | null; outputTail: string; passed: boolean };
    },
    ctx: MissionAgentContext
  ): Promise<{ accept: boolean; note: string }>;
}

export interface ScriptedRound {
  plan?: string[];
  claim?: string;
  writes?: Record<string, string>;
  edits?: Array<{
    path: string;
    content?: string;
    replaceLine?: { line: number; text: string };
  }>;
  review?: { accept: boolean; note: string };
}

export class ScriptedMissionAgent implements MissionAgent {
  private rounds: ScriptedRound[];
  private planIndex = 0;
  private actIndex = 0;
  private reviewIndex = 0;

  constructor(spec: ScriptedRound[] | { rounds: ScriptedRound[] } | ScriptedRound) {
    if (Array.isArray(spec)) {
      this.rounds = spec;
    } else if ("rounds" in spec && Array.isArray((spec as any).rounds)) {
      this.rounds = (spec as any).rounds;
    } else {
      this.rounds = [spec as ScriptedRound];
    }
    if (this.rounds.length === 0) {
      this.rounds = [{}];
    }
  }

  async plan(goal: string, ctx: MissionAgentContext): Promise<string[]> {
    const round = this.rounds[Math.min(this.planIndex, this.rounds.length - 1)];
    this.planIndex += 1;
    return round.plan ?? ["examine repository", "implement changes", "verify tests"];
  }

  async act(
    input: {
      goal: string;
      plan: string[];
      failure?: { exitCode: number; outputTail: string };
    },
    ctx: MissionAgentContext
  ): Promise<{ claim: string }> {
    const round = this.rounds[Math.min(this.actIndex, this.rounds.length - 1)];
    this.actIndex += 1;

    // Apply any file writes through the workspace seam (target or local).
    if (round.writes) {
      for (const [relPath, fileContent] of Object.entries(round.writes)) {
        await ctx.workspace.writeFile({
          path: path.join(ctx.workspaceRoot, relPath),
          content: fileContent,
          overwrite: true,
        });
      }
    }

    // Apply any edits through the workspace seam.
    if (round.edits) {
      for (const edit of round.edits) {
        const fullPath = path.join(ctx.workspaceRoot, edit.path);
        if (edit.content !== undefined) {
          await ctx.workspace.writeFile({ path: fullPath, content: edit.content, overwrite: true });
        } else if (edit.replaceLine) {
          const file = await ctx.workspace.readFile({ path: fullPath });
          const lines = file.content.split("\n");
          lines[edit.replaceLine.line - 1] = edit.replaceLine.text;
          await ctx.workspace.writeFile({ path: fullPath, content: lines.join("\n"), overwrite: true });
        }
      }
    }

    return { claim: round.claim ?? "all tests pass" };
  }

  async review(
    input: {
      goal: string;
      diff: string;
      check: { exitCode: number | null; outputTail: string; passed: boolean };
    },
    ctx: MissionAgentContext
  ): Promise<{ accept: boolean; note: string }> {
    const round = this.rounds[Math.min(this.reviewIndex, this.rounds.length - 1)];
    this.reviewIndex += 1;

    if (round.review) {
      return {
        accept: round.review.accept,
        note: round.review.note,
      };
    }

    return {
      accept: input.check.passed,
      note: input.check.passed ? "Check passed cleanly" : "Check failed",
    };
  }
}

export function loadScriptedAgent(filePath: string): ScriptedMissionAgent {
  const content = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(content);
  return new ScriptedMissionAgent(data);
}
