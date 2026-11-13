export type GrantLifetime = "once" | "mission" | "folder" | "always";

export interface CapabilityGrant {
  id: string;
  tool: string;
  /** Path prefix, command prefix ("git *"), or domain (e.g. "api.github.com"). */
  scope: string;
  lifetime: GrantLifetime;
  epoch: number;
  createdAt: number;
  expiresAt?: number;
  missionId?: string;
  folderPath?: string;
}

export interface GrantsFileContent {
  version: 1;
  epoch: number;
  grants: CapabilityGrant[];
  updatedAt: number;
  updatedBy: string;
}
