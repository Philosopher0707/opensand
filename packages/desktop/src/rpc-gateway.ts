/**
 * OpenSand Clean-Room Unified RPC Gateway
 * Implements Connect-Web / gRPC-Web wire compatibility over HTTP POST for Grok Bot contracts.
 * Matches: POST /aiserver.v1.<ServiceName>/<MethodName>
 */

import * as http from 'node:http';
import { DesktopIpcBridge } from './ipc-bridge.js';

export type RpcErrorCode = 'not_found' | 'invalid_argument' | 'permission_denied' | 'unauthenticated' | 'internal';

export class RpcError extends Error {
  public code: RpcErrorCode;

  constructor(
    code: RpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface RpcContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  service: string;
  method: string;
  bridge: DesktopIpcBridge;
}

export type RpcHandler = (payload: any, context: RpcContext) => Promise<any> | any;

export class RpcGateway {
  private handlers: Map<string, RpcHandler> = new Map();
  private wildcardHandlers: Map<string, RpcHandler> = new Map();
  private bridge: DesktopIpcBridge;

  constructor(bridge: DesktopIpcBridge) {
    this.bridge = bridge;
  }

  public register(service: string, method: string, handler: RpcHandler): void {
    this.handlers.set(`${service}/${method}`, handler);
  }

  public registerWildcard(service: string, handler: RpcHandler): void {
    this.wildcardHandlers.set(service, handler);
  }

  public has(service: string, method: string): boolean {
    return this.handlers.has(`${service}/${method}`) || this.wildcardHandlers.has(service);
  }

  public listRegisteredRpcMethods(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  public async dispatch(
    service: string,
    method: string,
    payload: any,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<any> {
    const key = `${service}/${method}`;
    const handler = this.handlers.get(key) || this.wildcardHandlers.get(service);

    if (!handler) {
      throw new RpcError('not_found', `Unimplemented RPC method: ${service}/${method}`);
    }

    const context: RpcContext = {
      req,
      res,
      service,
      method,
      bridge: this.bridge,
    };

    return await handler(payload, context);
  }

  public async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: any
  ): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const match = url.pathname.match(/^\/(aiserver\.v1\.[a-zA-Z0-9_]+)\/([a-zA-Z0-9_]+)$/);
    if (!match) return false;

    const [, service, method] = match;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      const result = await this.dispatch(service, method, body || {}, req, res);
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end(JSON.stringify(result ?? {}));
      }
    } catch (err: any) {
      const code: RpcErrorCode = err instanceof RpcError ? err.code : 'internal';
      const statusMap: Record<RpcErrorCode, number> = {
        invalid_argument: 400,
        unauthenticated: 401,
        permission_denied: 403,
        not_found: 404,
        internal: 500,
      };
      const statusCode = statusMap[code] || 500;
      if (!res.writableEnded) {
        res.writeHead(statusCode);
        res.end(
          JSON.stringify({
            code,
            message: err.message || 'Internal RPC Error',
          })
        );
      }
    }
    return true;
  }
}

/**
 * Creates and registers the default Grok Bot parity RPC Gateway
 */
export function createDefaultRpcGateway(bridge: DesktopIpcBridge): RpcGateway {
  const gateway = new RpcGateway(bridge);

  // 1. aiserver.v1.GrokBotService
  gateway.register('aiserver.v1.GrokBotService', 'RollBackGrokBotConversation', async (req) => {
    return await bridge.rollbackTurns(typeof req.turns === 'number' ? req.turns : 1);
  });

  gateway.register('aiserver.v1.GrokBotService', 'AskSideQuestion', async (req) => {
    if (!req.question) throw new RpcError('invalid_argument', 'Missing question in AskSideQuestionRequest');
    const answer = await bridge.askSideQuestion(req.question);
    return { answer };
  });

  gateway.register('aiserver.v1.GrokBotService', 'CompactHistory', async (req) => {
    const keep = typeof req.keepRecentTurns === 'number' ? req.keepRecentTurns : 2;
    return await bridge.compactHistory(keep);
  });

  gateway.register('aiserver.v1.GrokBotService', 'GetTokenTelemetry', async (req) => {
    return await bridge.getTokenTelemetry(req?.agentId, req?.sessionId);
  });

  gateway.register('aiserver.v1.GrokBotService', 'SubmitQuery', async (req) => {
    if (!req.query) throw new RpcError('invalid_argument', 'Missing query in SubmitQueryRequest');
    return await bridge.sendQuery(req.query, req.sessionId, req.agentId);
  });

  gateway.register('aiserver.v1.GrokBotService', 'EnsureSandBox', async () => {
    return { ready: true, status: 'healthy', sandboxId: 'default' };
  });

  gateway.register('aiserver.v1.GrokBotService', 'EnsureSandBoxWindow', async () => {
    return { ready: true, windowId: 'main_window' };
  });

  gateway.register('aiserver.v1.GrokBotService', 'RecreateSandBox', async () => {
    return { recreated: true, timestamp: Date.now() };
  });

  // 2. aiserver.v1.AgentStoreService
  gateway.register('aiserver.v1.AgentStoreService', 'ListAgents', async () => {
    const agents = await bridge.getAgents();
    return { agents };
  });

  gateway.register('aiserver.v1.AgentStoreService', 'ListAgentStores', async () => {
    const agents = await bridge.getAgents();
    return { agentStores: agents };
  });

  gateway.register('aiserver.v1.AgentStoreService', 'GetAgent', async (req) => {
    if (!req.id) throw new RpcError('invalid_argument', 'Missing id in GetAgentRequest');
    const agent = await bridge.getAgent(req.id);
    if (!agent) throw new RpcError('not_found', `Agent not found: ${req.id}`);
    return { agent };
  });

  gateway.register('aiserver.v1.AgentStoreService', 'CreateAgent', async (req) => {
    if (!req.name || !req.role) throw new RpcError('invalid_argument', 'Missing name or role in CreateAgentRequest');
    const agent = await bridge.createAgent(req);
    return { agent };
  });

  gateway.register('aiserver.v1.AgentStoreService', 'DeleteAgent', async (req) => {
    if (!req.id) throw new RpcError('invalid_argument', 'Missing id in DeleteAgentRequest');
    const deleted = await bridge.deleteAgent(req.id);
    return { success: deleted };
  });

  gateway.register('aiserver.v1.AgentStoreService', 'ExportAgentTemplate', async (req) => {
    const target = req.id || req.name || req.idOrName;
    if (!target) throw new RpcError('invalid_argument', 'Missing id or name in ExportAgentTemplateRequest');
    const template = await bridge.exportAgentTemplate(target);
    return { template };
  });

  gateway.register('aiserver.v1.AgentStoreService', 'ImportAgentTemplate', async (req) => {
    const tpl = req.template || req.raw;
    if (!tpl) throw new RpcError('invalid_argument', 'Missing template in ImportAgentTemplateRequest');
    const agent = await bridge.importAgentTemplate(tpl);
    return { agent };
  });

  // 3. aiserver.v1.SandBoxService (Execution & File Operations)
  // Security: Command execution and direct filesystem tools are strictly disabled over HTTP RPC.
  gateway.register('aiserver.v1.SandBoxService', 'ExecCommand', async () => {
    throw new RpcError('permission_denied', 'SandBoxService command execution is disabled over HTTP');
  });

  gateway.register('aiserver.v1.SandBoxService', 'ReadFile', async () => {
    throw new RpcError('permission_denied', 'SandBoxService file operations are disabled over HTTP');
  });

  gateway.register('aiserver.v1.SandBoxService', 'WriteFile', async () => {
    throw new RpcError('permission_denied', 'SandBoxService file operations are disabled over HTTP');
  });

  gateway.register('aiserver.v1.SandBoxService', 'ListDirectory', async () => {
    throw new RpcError('permission_denied', 'SandBoxService directory listing is disabled over HTTP');
  });

  // 4. aiserver.v1.DashboardService
  gateway.register('aiserver.v1.DashboardService', 'GetTeams', async () => {
    return {
      teams: [{ id: 'team_local', name: 'OpenSand Workspace', role: 'owner' }],
    };
  });

  gateway.register('aiserver.v1.DashboardService', 'GetMe', async () => {
    return {
      user: {
        id: 'user_operator',
        name: 'OpenSand Operator',
        email: 'operator@local',
        tier: 'unlimited',
      },
    };
  });

  gateway.register('aiserver.v1.DashboardService', 'GetFleetStatus', async () => {
    const agents = await bridge.getAgents();
    const rooms = await bridge.listRooms();
    const routines = await bridge.listRoutines();
    const tasks = await bridge.getTasks();
    const secrets = await bridge.listSecrets();
    const telemetry = await bridge.getTokenTelemetry();
    return {
      fleet: {
        agentsCount: agents.length,
        roomsCount: rooms.length,
        routinesCount: routines.length,
        tasksCount: tasks.length,
        secretsCount: secrets.length,
        contextTokens: telemetry.estimatedTokens,
        status: 'operational',
      },
    };
  });

  gateway.register('aiserver.v1.DashboardService', 'ListTasks', async (req) => {
    const tasks = await bridge.getTasks(req);
    return { tasks };
  });

  gateway.register('aiserver.v1.DashboardService', 'CreateTask', async (req) => {
    const task = await bridge.createTask(req);
    return { task };
  });

  gateway.register('aiserver.v1.DashboardService', 'ListRooms', async () => {
    const rooms = await bridge.listRooms();
    return { rooms };
  });

  gateway.register('aiserver.v1.DashboardService', 'CreateRoom', async (req) => {
    const room = await bridge.createRoom(req);
    return { room };
  });

  gateway.register('aiserver.v1.DashboardService', 'RunRoomDiscussion', async (req) => {
    if (!req.roomId || !req.topic) {
      throw new RpcError('invalid_argument', 'Missing roomId or topic in RunRoomDiscussionRequest');
    }
    return await bridge.runRoomDiscussion(req.roomId, req.topic);
  });

  gateway.register('aiserver.v1.DashboardService', 'ListRoutines', async () => {
    const routines = await bridge.listRoutines();
    return { routines };
  });

  gateway.register('aiserver.v1.DashboardService', 'TriggerRoutine', async (req) => {
    if (!req.routineId) throw new RpcError('invalid_argument', 'Missing routineId in TriggerRoutineRequest');
    return await bridge.triggerRoutine(req.routineId);
  });

  gateway.register('aiserver.v1.DashboardService', 'ListSecrets', async () => {
    const secrets = await bridge.listSecrets();
    return { secrets };
  });

  gateway.register('aiserver.v1.DashboardService', 'ListMemories', async (req) => {
    const memories = await bridge.listMemories(req);
    return { memories };
  });

  gateway.register('aiserver.v1.DashboardService', 'ListAttachments', async () => {
    const attachments = await bridge.listAttachments();
    return { attachments };
  });

  // 5. aiserver.v1.AnalyticsService (Zero-Leakage Telemetry Sink)
  gateway.registerWildcard('aiserver.v1.AnalyticsService', async () => {
    // Sinks all tracking/batch/statsig calls locally with 200 OK to guarantee privacy
    return { recorded: true, anonymized: true };
  });

  // 6. aiserver.v1.BackgroundComposerService
  gateway.registerWildcard('aiserver.v1.BackgroundComposerService', async () => {
    return { status: 'idle', activeWorkers: [] };
  });

  return gateway;
}
