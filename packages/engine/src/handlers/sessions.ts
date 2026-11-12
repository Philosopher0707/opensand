import { ErrorCodes, OspError } from "@opensand/protocol";
import type { Handler } from "../types.js";

/**
 * The projection code lives in the coordinator, which the engine must not
 * import in this PR (Phase 3 moves the loop behind the engine). These methods
 * answer MethodNotFound instead of duplicating `projectMessages`.
 */
function notImplemented(): never {
  throw new OspError(
    ErrorCodes.MethodNotFound,
    "session methods need the coordinator projections, which the engine does not import yet",
    { planned: "Phase 3" }
  );
}

export function createSessionHandlers(): Record<string, Handler> {
  return {
    "session.Sessions.create": notImplemented,
    "session.Sessions.get": notImplemented,
    "session.Sessions.list": notImplemented,
    "session.Sessions.rename": notImplemented,
    "session.Sessions.delete": notImplemented,
  };
}
