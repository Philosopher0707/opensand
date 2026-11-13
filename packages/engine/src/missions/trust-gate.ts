import { FolderTrustStore, StaleEpochError, type GrantsStore, type TrustLevel } from "@opensand/shared";
import { ErrorCodes, OspError } from "@opensand/protocol";

export interface TrustQuestion {
  question: "folder-trust";
  folder: string;
  epoch: number;
}

export interface TrustDecision {
  level: "trusted" | "untrusted";
  folder: string;
}

interface Parked {
  folder: string;
  resolve: (level: "trusted" | "untrusted") => void;
}

/**
 * Holds a mission until its workspace folder has an answered trust level.
 * A folder with no record is unanswered ("prompt"): it parks and asks. Nothing here runs a command.
 */
export class FolderTrustGate {
  private readonly parked = new Map<string, Parked>();

  constructor(
    private readonly store: FolderTrustStore,
    private readonly grants: GrantsStore,
  ) {}

  async resolve(
    missionId: string,
    workspaceRoot: string,
    signal: AbortSignal,
    onQuestion: (question: TrustQuestion) => Promise<void>,
    onAnswered: (answer: { question: "folder-trust"; level: "trusted" | "untrusted"; folder: string }) => Promise<void>,
  ): Promise<TrustDecision> {
    let folder: string;
    try {
      folder = FolderTrustStore.canonicalFolder(workspaceRoot);
    } catch {
      // A folder we cannot canonicalise is never trusted.
      return { level: "untrusted", folder: workspaceRoot };
    }
    const level: TrustLevel = await this.store.getLevel(folder);
    if (level === "trusted") return { level, folder };
    if (level === "untrusted") return { level, folder };

    if (signal.aborted) throw abortError();
    const answered = new Promise<"trusted" | "untrusted">((resolve, reject) => {
      this.parked.set(missionId, { folder, resolve });
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    answered.catch(() => undefined);
    try {
      await onQuestion({ question: "folder-trust", folder, epoch: (await this.grants.read()).epoch });
      const answer = await answered;
      await onAnswered({ question: "folder-trust", level: answer, folder });
      return { level: answer, folder };
    } finally {
      this.parked.delete(missionId);
    }
  }

  /** Epoch-checked answer. A stale or missing epoch throws OspError 4001 and leaves the mission parked. */
  async answer(missionId: string, input: { level: unknown; epoch: unknown }): Promise<void> {
    const parked = this.parked.get(missionId);
    if (!parked) throw new OspError(ErrorCodes.InvalidParams, `mission ${missionId} is not waiting for an answer`);
    if (input.level !== "trusted" && input.level !== "untrusted") {
      throw new OspError(ErrorCodes.InvalidParams, "level must be trusted or untrusted");
    }
    try {
      await this.grants.assertEpoch(input.epoch);
      await this.store.setLevel(parked.folder, input.level, { updatedBy: "engine:inbox.Approvals.answer" });
    } catch (err) {
      if (err instanceof StaleEpochError) {
        throw new OspError(err.code, err.message, { currentEpoch: err.currentEpoch });
      }
      throw err;
    }
    parked.resolve(input.level);
  }
}

function abortError(): Error {
  const err = new Error("mission cancelled while waiting for folder trust");
  err.name = "AbortError";
  return err;
}
