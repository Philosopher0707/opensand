/**
 * OpenSand Inbound Webhook & Event Trigger Gateway
 * Enables proactive automation triggers from external systems (GitHub, CI/CD, Slack, webhooks)
 * into OpenSand routines, agent graphs, or autonomous coordinator turn loops.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RoutineEngine } from './routine-engine.js';
import { CompiledGraph } from './agent-graph.js';
import { AgentCoordinator } from './coordinator.js';

export type WebhookTargetType = 'routine' | 'graph' | 'agent';

export interface WebhookRegistration {
  id: string;
  name: string;
  description?: string;
  secret?: string;
  targetType: WebhookTargetType;
  targetId: string;
  filterEvent?: string; // e.g. "push", "pull_request", "build_failed"
  enabled: boolean;
  createdAt: number;
  triggerCount: number;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  webhookName: string;
  timestamp: number;
  event?: string;
  status: 'success' | 'rejected' | 'error';
  reason?: string;
  resultPayload?: unknown;
}

export interface WebhookGatewayOptions {
  storageDir?: string;
  routineEngine?: RoutineEngine;
  graphs?: Map<string, CompiledGraph<any>>;
  coordinator?: AgentCoordinator;
}

export interface WebhookDispatchResult {
  success: boolean;
  webhookId?: string;
  status: 'dispatched' | 'rejected' | 'error';
  reason?: string;
  output?: unknown;
}

export function safeTimingCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = crypto.createHash('sha256').update(a).digest();
  const bufB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

export class WebhookGateway {
  private webhooks: Map<string, WebhookRegistration> = new Map();
  private deliveries: WebhookDeliveryLog[] = [];
  private maxDeliveryLogs: number = 200;
  private storageFile: string | null = null;
  private routineEngine?: RoutineEngine;
  private graphs: Map<string, CompiledGraph<any>>;
  private coordinator?: AgentCoordinator;

  constructor(options: WebhookGatewayOptions = {}) {
    this.routineEngine = options.routineEngine;
    this.graphs = options.graphs || new Map();
    this.coordinator = options.coordinator;

    if (options.storageDir) {
      this.storageFile = path.join(options.storageDir, 'webhooks.json');
      this.loadFromDisk();
    }
  }

  public registerGraph(name: string, graph: CompiledGraph<any>): void {
    this.graphs.set(name, graph);
  }

  public registerWebhook(webhook: Omit<WebhookRegistration, 'createdAt' | 'triggerCount'>): WebhookRegistration {
    const reg: WebhookRegistration = {
      ...webhook,
      createdAt: Date.now(),
      triggerCount: 0,
    };
    this.webhooks.set(webhook.name, reg);
    this.persistToDisk();
    return reg;
  }

  public getWebhooks(): WebhookRegistration[] {
    return Array.from(this.webhooks.values());
  }

  public getWebhook(name: string): WebhookRegistration | undefined {
    return this.webhooks.get(name);
  }

  public deleteWebhook(name: string): boolean {
    const deleted = this.webhooks.delete(name);
    if (deleted) {
      this.persistToDisk();
    }
    return deleted;
  }

  public getDeliveryLogs(limit: number = 50): WebhookDeliveryLog[] {
    return this.deliveries.slice(-limit).reverse();
  }

  /**
   * Handle incoming HTTP webhook delivery
   */
  public async handleWebhook(
    name: string,
    payload: any,
    headers: Record<string, string> = {}
  ): Promise<WebhookDispatchResult> {
    const webhook = this.webhooks.get(name);
    if (!webhook) {
      this.recordDelivery('unknown', name, 'rejected', 'Webhook endpoint not found');
      return { success: false, status: 'rejected', reason: `No webhook registered with name "${name}"` };
    }

    if (!webhook.enabled) {
      this.recordDelivery(webhook.id, webhook.name, 'rejected', 'Webhook is disabled');
      return { success: false, webhookId: webhook.id, status: 'rejected', reason: `Webhook "${name}" is disabled` };
    }

    // Verify Secret if configured
    if (webhook.secret) {
      const isValid = this.verifySignature(webhook.secret, payload, headers);
      if (!isValid) {
        this.recordDelivery(webhook.id, webhook.name, 'rejected', 'Invalid webhook signature or token');
        return { success: false, webhookId: webhook.id, status: 'rejected', reason: 'Invalid signature or authorization token' };
      }
    }

    // Verify filter event (e.g. GitHub X-GitHub-Event header)
    const githubEvent = headers['x-github-event'] || headers['X-GitHub-Event'] || payload?.event;
    if (webhook.filterEvent && githubEvent && webhook.filterEvent !== githubEvent) {
      this.recordDelivery(webhook.id, webhook.name, 'rejected', `Ignored event: "${githubEvent}" does not match filter "${webhook.filterEvent}"`);
      return { success: true, webhookId: webhook.id, status: 'dispatched', reason: `Event filtered out (${githubEvent})` };
    }

    // Dispatch target
    try {
      let output: unknown;

      if (webhook.targetType === 'routine') {
        if (!this.routineEngine) {
          throw new Error('RoutineEngine is not wired to WebhookGateway');
        }
        const runLog = await this.routineEngine.triggerRoutine(webhook.targetId);
        output = runLog;
      } else if (webhook.targetType === 'graph') {
        const graph = this.graphs.get(webhook.targetId);
        if (!graph) {
          throw new Error(`Agent graph "${webhook.targetId}" not found in WebhookGateway`);
        }
        const graphResult = await graph.invoke({
          webhookPayload: payload,
          eventSource: name,
          timestamp: Date.now(),
        });
        output = graphResult;
      } else if (webhook.targetType === 'agent') {
        if (!this.coordinator) {
          throw new Error('AgentCoordinator is not wired to WebhookGateway');
        }
        const queryText = typeof payload === 'string'
          ? payload
          : `[Webhook Trigger: ${name}] Event: ${githubEvent || 'generic'}\nPayload:\n${JSON.stringify(payload, null, 2)}`;
        const agentResponse = await this.coordinator.runTurn(queryText);
        output = { response: agentResponse };
      }

      webhook.triggerCount = (webhook.triggerCount || 0) + 1;
      this.persistToDisk();
      this.recordDelivery(webhook.id, webhook.name, 'success', undefined, output);

      return {
        success: true,
        webhookId: webhook.id,
        status: 'dispatched',
        output,
      };
    } catch (err: any) {
      const errMsg = err.message || String(err);
      this.recordDelivery(webhook.id, webhook.name, 'error', errMsg);
      return {
        success: false,
        webhookId: webhook.id,
        status: 'error',
        reason: errMsg,
      };
    }
  }

  public safeCompare(a: unknown, b: unknown): boolean {
    return safeTimingCompare(a, b);
  }

  private verifySignature(secret: string, payload: any, headers: Record<string, string>): boolean {
    // 1. Check Bearer token or custom token header with timing-safe comparison
    const authHeader = headers['authorization'] || headers['Authorization'] || '';
    if (authHeader.startsWith('Bearer ') && this.safeCompare(authHeader.slice(7).trim(), secret)) {
      return true;
    }

    const customToken = headers['x-opensand-secret'] || headers['X-OpenSand-Secret'] || headers['x-webhook-token'];
    if (customToken && this.safeCompare(customToken, secret)) {
      return true;
    }

    // 2. Check GitHub HMAC-SHA256 signature (X-Hub-Signature-256)
    const hubSig = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'];
    if (hubSig && hubSig.startsWith('sha256=')) {
      const rawPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const computed = 'sha256=' + crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
      try {
        return this.safeCompare(hubSig, computed);
      } catch {
        return false;
      }
    }

    return false;
  }

  private recordDelivery(
    webhookId: string,
    webhookName: string,
    status: 'success' | 'rejected' | 'error',
    reason?: string,
    resultPayload?: unknown
  ): void {
    const log: WebhookDeliveryLog = {
      id: `delivery_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      webhookId,
      webhookName,
      timestamp: Date.now(),
      status,
      reason,
      resultPayload,
    };
    this.deliveries.push(log);
    if (this.deliveries.length > this.maxDeliveryLogs) {
      this.deliveries.shift();
    }
  }

  private loadFromDisk(): void {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return;
    try {
      const raw = fs.readFileSync(this.storageFile, 'utf8');
      const parsed: WebhookRegistration[] = JSON.parse(raw);
      this.webhooks.clear();
      for (const w of parsed) {
        this.webhooks.set(w.name, w);
      }
    } catch {
      // Ignore
    }
  }

  private persistToDisk(): void {
    if (!this.storageFile) return;
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(Array.from(this.webhooks.values()), null, 2);
      fs.writeFileSync(this.storageFile, data, { mode: 0o600 });
    } catch {
      // Ignore
    }
  }
}
