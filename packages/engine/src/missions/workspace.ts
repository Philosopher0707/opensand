import {
  runCommandOperation,
  readFileOperation,
  writeFileOperation,
  editFileOperation,
  grepOperation,
  globOperation,
  listDirectoryOperation,
} from "@opensand/local-exec-daemon";
import type {
  ExecCommandInput,
  ExecCommandOutput,
  ReadFileInput,
  ReadFileOutput,
  WriteFileInput,
  WriteFileOutput,
  EditFileInput,
  EditFileOutput,
  GrepInput,
  GrepOutput,
  GlobInput,
  GlobOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
} from "@opensand/local-exec-daemon";

/**
 * The one seam the mission runner uses for everything that touches files or
 * commands (docs/design/phase8-reach.md §5.1). `root` stays the local path:
 * folder trust, the event log, snapshots and the receipt keep working exactly
 * as in Phase 3/6; a target only translates its own paths and commands.
 */
export interface WorkspaceResult {
  /** Pinned tree of the fetched result (an SSH prepare), when one was pinned. */
  tree?: string;
  /** True when an SSH apply wrote the user's workspace. */
  applied?: boolean;
  detail?: string;
}

export interface TargetIdentity {
  name: string;
  kind: "local" | "container" | "ssh";
  platform?: string;
  root?: string;
}

export interface MissionWorkspace {
  readonly kind: "local" | "container" | "ssh";
  readonly root: string;
  /** Identity for mission.target events and the receipt block; local is unnamed. */
  identity(): TargetIdentity | undefined;
  exec(input: ExecCommandInput, opts?: { signal?: AbortSignal }): Promise<ExecCommandOutput>;
  readFile(input: ReadFileInput): Promise<ReadFileOutput>;
  writeFile(input: WriteFileInput): Promise<WriteFileOutput>;
  editFile(input: EditFileInput): Promise<EditFileOutput>;
  grep(input: GrepInput): Promise<GrepOutput>;
  glob(input: GlobInput): Promise<GlobOutput>;
  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryOutput>;
  /** Connect, preflight and (SSH) push. Safe to skip for local. */
  begin(): Promise<void>;
  /** Fetch the remote result and pin its tree; no local write. No-op for local/container. */
  prepare(): Promise<WorkspaceResult>;
  /** Conflict gate, then apply. No-op for local/container. */
  apply(): Promise<WorkspaceResult>;
  /** Close the link, release locks, remove a container. Idempotent. */
  close(): Promise<void>;
}

/** The Phase 3 workspace: the daemon's local operations, nothing else. */
export class LocalWorkspace implements MissionWorkspace {
  readonly kind = "local" as const;
  constructor(readonly root: string) {}

  identity(): TargetIdentity | undefined {
    return undefined;
  }

  exec(input: ExecCommandInput, opts?: { signal?: AbortSignal }): Promise<ExecCommandOutput> {
    return runCommandOperation(
      {
        ...input,
        workspaceRoot: input.workspaceRoot ?? this.root,
      },
      opts
    );
  }

  readFile(input: ReadFileInput): Promise<ReadFileOutput> {
    return readFileOperation({ ...input, workspaceRoot: input.workspaceRoot ?? this.root, allowOutsideWorkspace: false });
  }

  writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
    return writeFileOperation({ ...input, workspaceRoot: input.workspaceRoot ?? this.root, allowOutsideWorkspace: false });
  }

  editFile(input: EditFileInput): Promise<EditFileOutput> {
    return editFileOperation({ ...input, workspaceRoot: input.workspaceRoot ?? this.root, allowOutsideWorkspace: false });
  }

  grep(input: GrepInput): Promise<GrepOutput> {
    return grepOperation({ ...input, workspaceRoot: input.workspaceRoot ?? this.root, allowOutsideWorkspace: false });
  }

  glob(input: GlobInput): Promise<GlobOutput> {
    return globOperation({ ...input, workspaceRoot: input.workspaceRoot ?? this.root, allowOutsideWorkspace: false });
  }

  listDirectory(input: ListDirectoryInput): Promise<ListDirectoryOutput> {
    return listDirectoryOperation({ ...input, workspaceRoot: input.workspaceRoot ?? this.root, allowOutsideWorkspace: false });
  }

  async begin(): Promise<void> {}
  async prepare(): Promise<WorkspaceResult> {
    return {};
  }
  async apply(): Promise<WorkspaceResult> {
    return {};
  }
  async close(): Promise<void> {}
}
