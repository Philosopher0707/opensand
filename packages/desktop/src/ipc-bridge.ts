import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { AgentCoordinator, UniversalLLMClient, TurnEvent, ApprovalRequest, McpManager } from '@opensand/coordinator';
import { LocalExecDaemon, StateManager } from '@opensand/local-exec-daemon';
import { registerNativeTools } from '@opensand/native-bridge';
import type { DesktopSettings, ToolApprovalRequest, ApprovalDecision, SessionSummary, DesktopEvent } from './types.js';

export interface IpcBridgeOptions {
  baseDir?: string;
  defaultSettings?: Partial<DesktopSettings>;
}

export class DesktopIpcBridge extends EventEmitter {
  private baseDir: string;
  private configFile: string;
  private settings: DesktopSettings;
  private daemon: LocalExecDaemon;
  private stateManager: StateManager;
  private mcpManager: McpManager;
  private coordinator: AgentCoordinator | null = null;
  private activeApprovals: Map<string, {
    request: ToolApprovalRequest;
    resolve: (approved: boolean) => void;
  }> = new Map();
  private currentSessionId: string | null = null;

  constructor(options: IpcBridgeOptions = {}) {
    super();
    this.baseDir = options.baseDir || path.join(os.homedir(), '.opensand');
    this.configFile = path.join(this.baseDir, 'config.json');

    // Default settings
    this.settings = {
      endpoint: process.env.OPENSAND_ENDPOINT || 'http://localhost:11434/v1/chat/completions',
      model: process.env.OPENSAND_MODEL || 'llama3.1',
      apiKey: process.env.OPENSAND_API_KEY || 'none',
      autoApprove: false,
      provider: 'openai',
      theme: 'dark',
      ...options.defaultSettings,
    };

    this.loadSettings();

    // Setup daemon and native tools
    const stateDir = path.join(this.baseDir, 'state');
    this.daemon = new LocalExecDaemon({ stateDir });
    this.stateManager = new StateManager(stateDir);
    registerNativeTools(this.daemon);

    // Initialize MCP Manager
    this.mcpManager = new McpManager({
      daemon: this.daemon,
      configPath: path.join(this.baseDir, 'mcp.json'),
    });
    this.mcpManager.startAll().catch(() => {});
  }

  public getSettings(): DesktopSettings {
    return { ...this.settings };
  }

  public updateSettings(partial: Partial<DesktopSettings>): DesktopSettings {
    this.settings = { ...this.settings, ...partial };
    this.saveSettings();
    this.emitEvent('status', { settings: this.settings });
    return { ...this.settings };
  }

  private loadSettings(): void {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw);
        this.settings = { ...this.settings, ...parsed };
      }
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  private saveSettings(): void {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch {
      // Ignore write errors
    }
  }

  public emitEvent(type: DesktopEvent['type'], data: unknown): void {
    const event: DesktopEvent = {
      type,
      sessionId: this.currentSessionId || 'default',
      data,
    };
    this.emit('event', event);
  }

  public async sendQuery(query: string, sessionId?: string): Promise<{ success: boolean; sessionId: string }> {
    const activeSessionId = sessionId || `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.currentSessionId = activeSessionId;

    const llmClient = new UniversalLLMClient({
      baseUrl: this.settings.endpoint,
      model: this.settings.model,
      apiKey: this.settings.apiKey,
    });

    // Create coordinator with interactive approval callback
    const coordinator = new AgentCoordinator({
      llmClient,
      daemon: this.daemon,
      sessionId: activeSessionId,
      sessionsBaseDir: path.join(this.baseDir, 'sessions'),
      onApprovalRequired: async (req: ApprovalRequest) => {
        if (this.settings.autoApprove) {
          return true;
        }
        return this.requestUserApproval(req.toolName, req.arguments);
      },
      onEvent: (event: TurnEvent) => {
        if (event.type === 'text_delta') {
          this.emitEvent('token', { token: event.text });
        } else if (event.type === 'tool_call_started') {
          this.emitEvent('tool_call', { name: event.toolCall.function.name, args: JSON.parse(event.toolCall.function.arguments || '{}') });
        } else if (event.type === 'tool_call_completed') {
          this.emitEvent('tool_result', { name: event.toolCall.function.name, result: event.result.output });
        } else if (event.type === 'turn_completed') {
          this.emitEvent('turn_complete', { response: event.finalContent });
        } else if (event.type === 'error') {
          this.emitEvent('error', { message: event.error.message });
        }
      },
    });

    this.coordinator = coordinator;

    // Run query asynchronously
    coordinator.runTurn(query)
      .then((finalResponse) => {
        this.emitEvent('turn_complete', { response: finalResponse });
      })
      .catch((err) => {
        this.emitEvent('error', { message: err instanceof Error ? err.message : String(err) });
      });

    return { success: true, sessionId: activeSessionId };
  }

  public async requestUserApproval(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    if (this.settings.autoApprove) {
      return true;
    }

    const approvalId = `appr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const request: ToolApprovalRequest = {
      approvalId,
      toolName,
      args,
      timestamp: Date.now(),
    };

    return new Promise<boolean>((resolve) => {
      this.activeApprovals.set(approvalId, { request, resolve });
      this.emitEvent('approval_required', request);
    });
  }

  public async approveTool(approvalId: string, decision: ApprovalDecision): Promise<{ success: boolean }> {
    const pending = this.activeApprovals.get(approvalId);
    if (!pending) {
      return { success: false };
    }

    this.activeApprovals.delete(approvalId);

    if (decision.action === 'always_allow') {
      // Add command prefix to standing allowlist if exec_command
      if (pending.request.toolName === 'exec_command' && typeof pending.request.args.command === 'string') {
        const cmd = pending.request.args.command.trim();
        const prefix = cmd.split(/\s+/)[0];
        if (prefix) {
          const gates = await this.stateManager.readPermissionGates();
          const allowlist = gates.standingAllowlist || [];
          if (!allowlist.includes(prefix)) {
            allowlist.push(prefix);
            await this.stateManager.writePermissionGates({ standingAllowlist: allowlist });
          }
        }
      }
      pending.resolve(true);
      return { success: true };
    }

    if (decision.action === 'approve_once') {
      pending.resolve(true);
      return { success: true };
    }

    // Reject
    pending.resolve(false);
    return { success: true };
  }

  public async getSessions(): Promise<SessionSummary[]> {
    const sessionsDir = path.join(this.baseDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const summaries: SessionSummary[] = [];

    for (const ent of entries) {
      if (ent.isDirectory()) {
        const sessDir = path.join(sessionsDir, ent.name);
        const jsonlPath = path.join(sessDir, 'transcript.jsonl');
        let messageCount = 0;
        let title = ent.name;

        if (fs.existsSync(jsonlPath)) {
          try {
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
            messageCount = lines.length;
            if (lines.length > 0) {
              const first = JSON.parse(lines[0]);
              if (first.content && typeof first.content === 'string') {
                title = first.content.slice(0, 40);
              }
            }
          } catch {
            // Keep default title
          }
        }

        const stat = fs.statSync(sessDir);
        summaries.push({
          id: ent.name,
          title,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          messageCount,
        });
      }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async loadSession(sessionId: string): Promise<{ events: unknown[]; transcript: string }> {
    const sessionDir = path.join(this.baseDir, 'sessions', sessionId);
    const jsonlPath = path.join(sessionDir, 'transcript.jsonl');
    const txtPath = path.join(sessionDir, 'transcript.txt');

    const events: unknown[] = [];
    let transcript = '';

    if (fs.existsSync(jsonlPath)) {
      const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Skip invalid lines
        }
      }
    }

    if (fs.existsSync(txtPath)) {
      transcript = fs.readFileSync(txtPath, 'utf8');
    }

    return { events, transcript };
  }
}
