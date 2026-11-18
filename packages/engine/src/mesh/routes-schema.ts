/**
 * Phase 7 routes.json schema validation (docs/design/phase7-mesh-tournament.md §2.2).
 *
 * An invalid file makes the engine refuse tournaments and say which key is
 * wrong; it never falls back to a default ladder, because a silent fallback
 * would route work to a model the user never chose.
 */
import { DEFAULT_THRESHOLDS, type RungThresholds } from "./routing.js";

export interface RoleRouting {
  ladder: string[];
  minSamples: number;
  minPassRate: number;
}

export interface RoutesConfig {
  version: 1;
  roles: Record<string, RoleRouting>;
}

export function parseRoutesConfig(input: unknown): RoutesConfig {
  if (typeof input !== "object" || input === null) {
    throw new Error("mesh/routes.json: top level must be an object");
  }
  const root = input as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error(`mesh/routes.json: version must be 1, got ${JSON.stringify(root.version)}`);
  }
  const rolesRaw = root.roles;
  if (typeof rolesRaw !== "object" || rolesRaw === null || Array.isArray(rolesRaw)) {
    throw new Error("mesh/routes.json: roles must be an object keyed by role name");
  }
  const roles: Record<string, RoleRouting> = {};
  for (const [role, raw] of Object.entries(rolesRaw as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`mesh/routes.json: roles.${role} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const ladder = entry.ladder;
    if (!Array.isArray(ladder) || ladder.length === 0) {
      throw new Error(`mesh/routes.json: roles.${role}.ladder must be a non-empty array`);
    }
    for (const model of ladder) {
      if (typeof model !== "string" || !model.includes(":")) {
        throw new Error(
          `mesh/routes.json: roles.${role}.ladder entries must be "provider:model", got ${JSON.stringify(model)}`,
        );
      }
    }
    roles[role] = {
      ladder: ladder as string[],
      minSamples: numberField(entry.minSamples, "minSamples", role, DEFAULT_THRESHOLDS.minSamples),
      minPassRate: numberField(entry.minPassRate, "minPassRate", role, DEFAULT_THRESHOLDS.minPassRate),
    };
  }
  if (Object.keys(roles).length === 0) {
    throw new Error("mesh/routes.json: roles must define at least one role");
  }
  return { version: 1, roles };
}

function numberField(value: unknown, name: string, role: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`mesh/routes.json: roles.${role}.${name} must be a number`);
  }
  if (name === "minSamples" && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`mesh/routes.json: roles.${role}.minSamples must be an integer >= 1`);
  }
  if (name === "minPassRate" && (value <= 0 || value > 1)) {
    throw new Error(`mesh/routes.json: roles.${role}.minPassRate must be in (0, 1]`);
  }
  return value;
}
