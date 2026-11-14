export type TrustLevel = "untrusted" | "prompt" | "trusted";

export interface FolderTrustRecord {
  level: TrustLevel;
  updatedAt: number;
  updatedBy: string;
}

/** Key = realpath of the folder. */
export interface FolderTrustFileContent {
  version: 1;
  folders: Record<string, FolderTrustRecord>;
}

export const TRUST_RANK: Record<TrustLevel, number> = { untrusted: 0, prompt: 1, trusted: 2 };
