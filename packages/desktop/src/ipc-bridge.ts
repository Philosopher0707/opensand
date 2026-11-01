import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  AgentCoordinator,
  UniversalLLMClient,
  TurnEvent,
  ApprovalRequest,
  McpManager,
  registerOrchestratorTools,
  AgentStore,
  AgentRecord,
  CreateAgentInput,
  TaskStore,
  AgentTask,
  CreateTaskInput,
  TaskStatus,
  HabitExtractor,
  MemoryStore,
  MemoryFact,
  TeamReviewItem,
  VaultStore,
  VaultSecret,
  VaultCredential,
  SkillStore,
  SkillRecord,
  RoutineEngine,
  AgentRoutine,
  CreateRoutineInput,
  RoutineExecutionLog,
  RoomManager,
  AgentRoom,
  CreateRoomInput,
  RoomDiscussionResult,
  AttachmentManager,
  AttachmentRecord,
  AgentTemplate,
} from '@opensand/coordinator';
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
  private agentStore: AgentStore;
  private taskStore: TaskStore;
  private habitExtractor: HabitExtractor;
  public memoryStore: MemoryStore;
  public vaultStore: VaultStore;
  public skillStore: SkillStore;
  public routineEngine: RoutineEngine;
  public roomManager: RoomManager;
  public attachmentManager: AttachmentManager;
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

    // Initialize Agent Store, Task Store, Habit Extractor & Memory Store
    this.agentStore = new AgentStore(path.join(this.baseDir, 'agents'));
    this.taskStore = new TaskStore(path.join(this.baseDir, 'tasks'));
    this.memoryStore = new MemoryStore({ baseDir: path.join(this.baseDir, 'memories') });
    this.vaultStore = new VaultStore({ baseDir: path.join(this.baseDir, 'vault') });
    this.skillStore = new SkillStore({
      baseDir: path.join(this.baseDir, 'skills'),
      agentStore: this.agentStore,
    });
    this.routineEngine = new RoutineEngine(
      path.join(this.baseDir, 'routines'),
      this.vaultStore
    );
    this.routineEngine.start();

    this.roomManager = new RoomManager(
      path.join(this.baseDir, 'rooms'),
      this.agentStore,
      this.vaultStore
    );
    this.habitExtractor = new HabitExtractor({
      sessionsDir: path.join(this.baseDir, 'sessions'),
      memoryFilePath: path.join(this.baseDir, 'learned_rules.md'),
    });
    this.attachmentManager = new AttachmentManager(path.join(this.baseDir, 'attachments'));

    // Initialize Orchestrator Meta-Tools
    registerOrchestratorTools({
      daemon: this.daemon,
      store: this.agentStore,
      taskStore: this.taskStore,
      habitExtractor: this.habitExtractor,
      memoryStore: this.memoryStore,
      vaultStore: this.vaultStore,
      skillStore: this.skillStore,
      routineEngine: this.routineEngine,
      roomManager: this.roomManager,
      attachmentManager: this.attachmentManager,
      defaultEndpoint: this.settings.endpoint,
      defaultModel: this.settings.model,
      defaultApiKey: this.settings.apiKey,
      sessionsBaseDir: path.join(this.baseDir, 'sessions'),
    });

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

  public async sendQuery(query: string, sessionId?: string, agentId?: string): Promise<{ success: boolean; sessionId: string }> {
    const activeSessionId = sessionId || `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.currentSessionId = activeSessionId;

    let targetModel = this.settings.model;
    let targetEndpoint = this.settings.endpoint;
    let customInstructions: string | undefined;

    if (agentId) {
      const agent = await this.agentStore.getAgent(agentId);
      if (agent) {
        if (agent.model) targetModel = agent.model;
        if (agent.endpoint) targetEndpoint = agent.endpoint;
        customInstructions = agent.systemPrompt;
      }
    }

    const llmClient = new UniversalLLMClient({
      baseUrl: targetEndpoint,
      model: targetModel,
      apiKey: this.settings.apiKey,
    });

    const learnedRules = await this.habitExtractor.getLearnedRulesMarkdown();
    const memoryContext = await this.memoryStore.getPromptMemoryContext(agentId);
    const skillsContext = agentId ? await this.skillStore.formatSkillsPrompt(agentId) : '';

    // Create coordinator with interactive approval callback
    const coordinator = new AgentCoordinator({
      llmClient,
      daemon: this.daemon,
      sessionId: activeSessionId,
      vaultStore: this.vaultStore,
      sessionsBaseDir: path.join(this.baseDir, 'sessions'),
      systemPromptContext: {
        userInstructions: customInstructions,
        learnedRules,
        memoryContext,
        skillsContext,
      },
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
      if (pending.request.toolName === 'exec_command' && typeof pending.request.args.command === 'string') {
        const cmd = pending.request.args.command.trim();
        // Disallow blanket allowlisting of dangerous shell interpreters or high-privilege binaries
        const DANGEROUS_GENERIC_BINARIES = new Set([
          'sh', 'bash', 'zsh', 'node', 'python', 'python3', 'perl', 'ruby',
          'sudo', 'su', 'rm', 'mv', 'chmod', 'chown', 'curl', 'wget', 'cat', 'dd'
        ]);

        const parts = cmd.split(/\s+/);
        const binary = parts[0];

        // If it's a generic interpreter, require exact command match; otherwise allow prefix
        let patternToAllow = cmd;
        if (!DANGEROUS_GENERIC_BINARIES.has(binary)) {
          patternToAllow = binary;
        }

        const gates = await this.stateManager.readPermissionGates();
        const allowlist = gates.standingAllowlist || [];
        if (!allowlist.includes(patternToAllow)) {
          allowlist.push(patternToAllow);
          await this.stateManager.writePermissionGates({ standingAllowlist: allowlist });
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

  // Agent Store API
  public async getAgents(): Promise<AgentRecord[]> {
    return this.agentStore.listAgents();
  }

  public async getAgent(id: string): Promise<AgentRecord | null> {
    return this.agentStore.getAgent(id);
  }

  public async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    return this.agentStore.createAgent(input);
  }

  public async deleteAgent(id: string): Promise<boolean> {
    return this.agentStore.deleteAgent(id);
  }

  // Task Store API
  public async getTasks(filter?: { status?: TaskStatus; agentId?: string }): Promise<AgentTask[]> {
    return this.taskStore.listTasks(filter);
  }

  public async createTask(input: CreateTaskInput): Promise<AgentTask> {
    return this.taskStore.createTask(input);
  }

  public async updateTask(id: string, updates: Partial<Omit<AgentTask, 'id' | 'createdAt'>>): Promise<AgentTask> {
    return this.taskStore.updateTask(id, updates);
  }

  public async deleteTask(id: string): Promise<boolean> {
    return this.taskStore.deleteTask(id);
  }

  // Habit Extractor API
  public async getLearnedRules(): Promise<string> {
    return this.habitExtractor.getLearnedRulesMarkdown();
  }

  public async refreshLearnedRules(maxChats = 50): Promise<any> {
    return this.habitExtractor.analyzeTranscripts(maxChats);
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
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    const sessionDir = path.join(this.baseDir, 'sessions', sessionId);
    const resolvedSessionDir = path.resolve(sessionDir);
    const expectedBase = path.resolve(path.join(this.baseDir, 'sessions'));
    if (!resolvedSessionDir.startsWith(expectedBase)) {
      throw new Error('Path traversal detected');
    }

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

  // Memory Store API (Grok Bot Parity)
  public async listMemories(filter?: {
    scope?: any;
    tier?: any;
    agentId?: string;
    query?: string;
  }): Promise<MemoryFact[]> {
    return this.memoryStore.listMemories(filter);
  }

  public async addMemory(fact: {
    text: string;
    scope?: any;
    tier?: any;
    agentId?: string;
  }): Promise<MemoryFact> {
    return this.memoryStore.addMemory(fact);
  }

  public async forgetMemory(factId: string, scope?: any, agentId?: string): Promise<boolean> {
    return this.memoryStore.forgetMemory(factId, scope, agentId);
  }

  public async promoteMemoriesToTeam(agentId: string, factIds: string[]): Promise<any> {
    return this.memoryStore.promoteMemoriesToTeam(agentId, factIds);
  }

  public async importMemoryText(
    exportedText: string,
    targetScope?: any,
    agentId?: string
  ): Promise<any> {
    return this.memoryStore.importMemoryText(exportedText, targetScope, agentId);
  }

  public async getTeamContextSummary(agentId?: string): Promise<any> {
    return this.memoryStore.getTeamContextSummary(agentId);
  }

  public async listReviewItems(filter?: { status?: any; limit?: number }): Promise<TeamReviewItem[]> {
    return this.memoryStore.listReviewItems(filter);
  }

  public async resolveReviewItem(
    itemId: string,
    decision: 'approve' | 'reject',
    reviewerId?: string
  ): Promise<TeamReviewItem> {
    return this.memoryStore.resolveReviewItem(itemId, decision, reviewerId);
  }

  // Vault API (Grok Bot Parity)
  public async putSecret(input: { name: string; value: string; description?: string }): Promise<VaultSecret> {
    return this.vaultStore.putSecret(input);
  }

  public async listSecrets(): Promise<Array<Omit<VaultSecret, 'value'> & { hasValue: boolean; preview: string }>> {
    return this.vaultStore.listSecrets();
  }

  public async deleteSecret(nameOrId: string): Promise<boolean> {
    return this.vaultStore.deleteSecret(nameOrId);
  }

  public async putCredential(input: any): Promise<VaultCredential> {
    return this.vaultStore.putCredential(input);
  }

  public async listCredentials(filter?: any): Promise<any> {
    return this.vaultStore.listCredentials(filter);
  }

  public async deleteCredential(idOrTitle: string): Promise<boolean> {
    return this.vaultStore.deleteCredential(idOrTitle);
  }

  // Skills API (Grok Bot Parity: AddGrokBotAgentSkill / ListGrokBotAgentSkills)
  public async createSkill(input: any): Promise<SkillRecord> {
    return this.skillStore.createSkill(input);
  }

  public async listSkills(category?: string): Promise<SkillRecord[]> {
    return this.skillStore.listSkills(category);
  }

  public async mountSkill(agentId: string, skillId: string): Promise<any> {
    return this.skillStore.mountSkillToAgent(agentId, skillId);
  }

  public async unmountSkill(agentId: string, skillId: string): Promise<any> {
    return this.skillStore.unmountSkillFromAgent(agentId, skillId);
  }

  public async deleteSkill(skillId: string): Promise<boolean> {
    return this.skillStore.deleteSkill(skillId);
  }

  // Routines API (Grok Bot Parity: ListGrokBotAgentRoutines / SetGrokBotAgentRoutineEnabled / DeleteGrokBotAgentAutomation)
  public async createRoutine(input: CreateRoutineInput): Promise<AgentRoutine> {
    return this.routineEngine.createRoutine(input);
  }

  public async listRoutines(): Promise<AgentRoutine[]> {
    return this.routineEngine.listRoutines();
  }

  public async getRoutine(routineId: string): Promise<AgentRoutine | null> {
    return this.routineEngine.getRoutine(routineId);
  }

  public async setRoutineEnabled(routineId: string, isEnabled: boolean): Promise<AgentRoutine> {
    return this.routineEngine.setRoutineEnabled(routineId, isEnabled);
  }

  public async triggerRoutine(routineId: string): Promise<{ routine: AgentRoutine; result: string; status: 'success' | 'error' }> {
    return this.routineEngine.triggerRoutine(routineId);
  }

  public async deleteRoutine(routineId: string): Promise<boolean> {
    return this.routineEngine.deleteRoutine(routineId);
  }

  public async getRoutineLogs(routineId: string): Promise<RoutineExecutionLog[]> {
    return this.routineEngine.getRoutineLogs(routineId);
  }

  // Rooms API (Grok Bot Parity: CreateGrokBotRoom / SetGrokBotRoomMembers / RequestGrokBotRoomMemberTurn / DeliverGrokBotRoomMemberTurnResult)
  public async createRoom(input: CreateRoomInput): Promise<AgentRoom> {
    return this.roomManager.createRoom(input);
  }

  public async listRooms(): Promise<AgentRoom[]> {
    return this.roomManager.listRooms();
  }

  public async getRoom(roomId: string): Promise<AgentRoom | null> {
    return this.roomManager.getRoom(roomId);
  }

  public async setRoomMembers(roomId: string, memberAgentIds: string[]): Promise<AgentRoom> {
    return this.roomManager.setRoomMembers(roomId, memberAgentIds);
  }

  public async runRoomDiscussion(roomId: string, topic: string): Promise<RoomDiscussionResult> {
    return this.roomManager.runRoomDiscussion(roomId, topic);
  }

  public async deleteRoom(roomId: string): Promise<boolean> {
    return this.roomManager.deleteRoom(roomId);
  }

  // Attachments API (Grok Bot Parity: stageAttachmentFile / stageAttachmentBytes)
  public async listAttachments(): Promise<AttachmentRecord[]> {
    return this.attachmentManager.listAttachments();
  }

  public async stageAttachment(filePath: string): Promise<AttachmentRecord> {
    return this.attachmentManager.stageFile(filePath);
  }

  public async deleteAttachment(id: string): Promise<boolean> {
    return this.attachmentManager.deleteAttachment(id);
  }

  // Templates API (Grok Bot Parity: CreateGrokBotTemplate / export / import)
  public async exportAgentTemplate(idOrName: string): Promise<AgentTemplate> {
    return this.agentStore.exportTemplate(idOrName);
  }

  public async importAgentTemplate(template: AgentTemplate | string): Promise<AgentRecord> {
    return this.agentStore.importTemplate(template);
  }

  // Side Question & Rollback API
  public async askSideQuestion(question: string): Promise<string> {
    if (!this.coordinator) {
      throw new Error('No active conversation coordinator available to answer side question');
    }
    return this.coordinator.askSideQuestion(question);
  }

  public async rollbackTurns(turns = 1): Promise<{ removedMessages: number; remainingMessages: number }> {
    if (!this.coordinator) {
      throw new Error('No active conversation coordinator available to rollback');
    }
    return this.coordinator.rollbackTurns(turns);
  }
}
