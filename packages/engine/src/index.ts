export { EngineServer } from "./server.js";
export type { EngineServerOptions } from "./server.js";
export { eventNameForKind, logDirFor, replayFrom } from "./reconnect.js";
export type { LogScope, ReplayResult } from "./reconnect.js";
export type { EngineConnection, Handler, HandlerContext } from "./types.js";
export { MissionRunnerManager } from "./missions/manager.js";
export { createMissionHandlers } from "./handlers/missions.js";
export { createTimelineHandlers } from "./handlers/timeline.js";

// Phase 7 mesh tournament surface (S5): the CLI's mission verbs drive the
// tournament through this package's public exports.
export {
  startTournament,
  reconcileTournament,
  settleMeshDecision,
  openAiCompatProvider,
  TournamentStartRefused,
  type AttemptProvider,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ProviderCallResult,
  type TournamentRun,
  type TournamentStartOptions,
} from "./mesh/tournament.js";
export { loadRoutesConfig, loadMeshStats, RoutesConfigError, opensandHomeDir, routesPath } from "./mesh/route-config.js";
export { foldMeshStats, type MeshStats, type StatsKey, statsKey } from "./mesh/stats.js";
export { buildTournamentSection, renderTournamentSection, type TournamentSection } from "./mesh/receipt-section.js";
export { parseRoutesConfig, type RoutesConfig, type RoleRouting } from "./mesh/routes-schema.js";
export { restoreSnapshot } from "./missions/workspace-diff.js";
