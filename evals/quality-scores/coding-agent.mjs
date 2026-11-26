// Turn providers for the quality-scores harness. Each turn writes into the task's
// temp workspace only and returns the final assistant text as an untrusted claim.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, writeFiles } from "./runner.mjs";

// File tool names differ across engines (Codex emits "edit", OpenSand emits "write_file").
const FILE_TOOLS = new Set([
  "read", "view", "ls", "list", "write", "edit", "create", "apply_patch", "str_replace_editor",
  "read_file", "list_files", "write_file", "edit_file", "create_file",
]);
const SHELL_TOOLS = /shell|bash|exec|command|terminal/i;

/** Fail-closed approver: file tools may touch paths inside this task's temp repo only. */
export function approveWithinWorkspace(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  return async ({ toolName, arguments: input }) => {
    if (SHELL_TOOLS.test(toolName) || !FILE_TOOLS.has(toolName)) return false;
    const values = [];
    const walk = (v) => {
      if (typeof v === "string") values.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(input);
    if (values.some((v) => v.includes("hidden.test.mjs"))) return false;
    for (const v of values) {
      if (!v.includes("/") && !v.includes("\\")) continue;
      const resolved = path.resolve(root, v);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;
    }
    return true;
  };
}

export function scriptedTurn(writes = {}, claim = "") {
  return async (_prompt, workspaceRoot) => {
    writeFiles(workspaceRoot, writes);
    return claim;
  };
}

async function nativeProvider({ model, baseUrl }) {
  const coord = await import(pathToFileURL(path.join(ROOT, "packages/coordinator/dist/src/index.js")).href);
  const daemonModule = await import(pathToFileURL(path.join(ROOT, "packages/local-exec-daemon/dist/src/index.js")).href);
  const client = new coord.UniversalLLMClient({ model, baseUrl, apiKey: "quality-scores", timeoutMs: 55_000, maxRetries: 0 });
  return {
    async turn(prompt, workspaceRoot) {
      const stateDir = path.join(workspaceRoot, ".opensand-state");
      fs.mkdirSync(stateDir, { recursive: true });
      const daemon = new daemonModule.LocalExecDaemon({ stateDir });
      await daemon.ensureStarted();
      try {
        const coordinator = new coord.AgentCoordinator({
          llmClient: client,
          daemon,
          sessionId: `qs-${path.basename(workspaceRoot)}`,
          sessionsBaseDir: path.join(stateDir, "sessions"),
          workspaceDir: workspaceRoot,
          workspaceRoot,
          sandboxProfile: "workspace-write",
          onApprovalRequired: approveWithinWorkspace(workspaceRoot),
          maxTurnIterations: 12,
          allowedTools: ["read_file", "list_files", "write_file", "edit_file"],
          toolScopeMode: "core",
          systemPromptContext: {
            userInstructions: "Solve one small coding task in this workspace. Edit only solution.mjs and run no shell commands; the harness runs its own hidden check.",
          },
        });
        return await coordinator.runTurn(prompt, AbortSignal.timeout(60_000));
      } finally {
        await daemon.stop().catch(() => undefined);
      }
    },
  };
}

async function externalProvider({ engine, model, baseUrl }) {
  const engineId = engine.slice("external:".length);
  const coord = await import(pathToFileURL(path.join(ROOT, "packages/coordinator/dist/src/index.js")).href);
  const vendor = await import(pathToFileURL(path.join(ROOT, "packages/coordinator/src/engines/vendor/agent_wrap.mjs")).href);
  const bin = vendor.findBinary(engineId);
  if (!bin) throw new Error(`external engine '${engineId}' is not installed (findBinary returned nothing)`);
  const version = await vendor.engineVersion(bin).catch(() => null);
  const systemPrompt = "Solve one small coding task in the current directory. Edit only solution.mjs; the harness runs its own hidden check.";
  return {
    binary: bin,
    version,
    baseUrl,
    async turn(prompt, workspaceRoot) {
      const sessionId = `qs-${path.basename(workspaceRoot)}`;
      const transcript = new coord.TranscriptManager(sessionId, path.join(workspaceRoot, ".opensand-state"));
      const runner = new coord.ExternalEngineTurnRunner({
        config: { type: "external", engine: engineId, model, timeoutMs: 55_000, idleMs: 25_000, mode: "agent" },
        sessionId,
        workspaceDir: workspaceRoot,
        transcript,
        sandboxProfile: "workspace-write",
        onApprovalRequired: approveWithinWorkspace(workspaceRoot),
        systemPrompt,
      });
      return runner.runTurn(prompt, AbortSignal.timeout(60_000));
    },
  };
}

export async function makeTurnProvider({ engine, model, baseUrl }) {
  if (engine === "native") return nativeProvider({ model, baseUrl });
  if (engine.startsWith("external:")) return externalProvider({ engine, model, baseUrl });
  throw new Error(`unsupported engine '${engine}'`);
}
