/**
 * OpenSand Declarative Boundary Policy Engine
 * Fail-closed CEL-style rule evaluation for tool calls, commands, files, and network access.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EFFECTS, NEVER_AUTO, SHELLS } from '@opensand/shared';

/** Known tools mapped to what they DO. Anything absent is an unknown effect and fails closed. */
const TOOL_EFFECTS: Record<string, string> = {
  read_file: 'read', list_directory: 'read', grep: 'read', glob: 'read',
  write_file: 'edit', edit_file: 'edit',
  exec_command: 'shell',
  delegate_to_agent: 'delegate', create_agent: 'delegate',
  web_search: 'network', web_fetch: 'network', http_request: 'network',
  browser_action: 'browser',
  memory_write: 'memory',
};

/** Always-denied egress targets (Invariant 7) unless explicitly allowlisted. */
const DENIED_HOSTS = ['169.254.169.254', 'metadata.google.internal'];
const LOOPBACK_WITH_PORT = /(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i;

export type PolicyAction = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface PolicyRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  action: PolicyAction;
  conditions: {
    tools?: string[];          // Exact tool name or wildcard (e.g. "exec_*", "read_file")
    commandsRegex?: string[];  // Regex patterns matching command line string
    pathsPrefix?: string[];    // Target file path prefix (e.g. "/etc", ".env", "~/.ssh")
    pathsRegex?: string[];     // Target file path regex
    domains?: string[];        // Network hostname / domain
    initiators?: ('user' | 'routine' | 'sentinel' | 'subagent')[];
    actors?: string[];         // Target bot persona ID or user ID
  };
}

export interface PolicyEvaluationContext {
  tool: string;
  args: Record<string, unknown>;
  actor?: string;
  initiator?: 'user' | 'routine' | 'sentinel' | 'subagent';
  /** Declared effect wins over any tool-name inference. */
  declaredEffect?: string;
  tainted?: boolean;
  sandboxed?: boolean;
  cwd?: string;
  workspaceRoot?: string;
  allowlistedHosts?: string[];
}

export interface PolicyDecision {
  action: PolicyAction;
  allowed: boolean;
  requiresApproval: boolean;
  matchedRule?: PolicyRule;
  reason: string;
  effect?: string;
}

export interface PolicyAuditEntry {
  id: string;
  timestamp: number;
  tool: string;
  actor?: string;
  initiator?: string;
  decision: PolicyAction;
  ruleId?: string;
  ruleName?: string;
  reason: string;
}

export interface PolicyEngineOptions {
  storageDir?: string;
  defaultAction?: PolicyAction;
  initialRules?: PolicyRule[];
}

export class PolicyEngine {
  private rules: Map<string, PolicyRule> = new Map();
  private auditLog: PolicyAuditEntry[] = [];
  private maxAuditEntries: number = 500;
  private storageFile: string | null = null;
  private defaultAction: PolicyAction;

  constructor(options: PolicyEngineOptions = {}) {
    this.defaultAction = options.defaultAction || 'REQUIRE_APPROVAL';

    if (options.storageDir) {
      this.storageFile = path.join(options.storageDir, 'boundaries.json');
      this.loadFromDisk();
    }

    if (options.initialRules && this.rules.size === 0) {
      for (const r of options.initialRules) {
        this.rules.set(r.id, r);
      }
      this.persistToDisk();
    }

    if (this.rules.size === 0) {
      this.loadDefaultPresets();
    }
  }

  public getRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  public getRule(id: string): PolicyRule | undefined {
    return this.rules.get(id);
  }

  public setRule(rule: PolicyRule): void {
    this.rules.set(rule.id, rule);
    this.persistToDisk();
  }

  public deleteRule(id: string): boolean {
    const deleted = this.rules.delete(id);
    if (deleted) {
      this.persistToDisk();
    }
    return deleted;
  }

  public getAuditLog(limit: number = 100): PolicyAuditEntry[] {
    return this.auditLog.slice(-limit).reverse();
  }

  public clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Fail-Closed Policy Evaluation
   * 1. DENY rules evaluate first (fail-closed immediately if any matches).
   * 2. REQUIRE_APPROVAL rules evaluate second.
   * 3. ALLOW rules evaluate third.
   * 4. Default fallback action applies if no rule matches.
   */
  public evaluate(context: PolicyEvaluationContext): PolicyDecision {
    const effect = this.resolveEffect(context);
    const activeRules = Array.from(this.rules.values()).filter((r) => r.enabled);

    // Egress boundary is unconditional: no rule may permit cloud metadata or loopback ports.
    const egressViolation = this.checkNetworkBoundary(context);
    if (egressViolation) {
      const decision: PolicyDecision = {
        action: 'DENY',
        allowed: false,
        requiresApproval: false,
        reason: `Policy violation: ${egressViolation}`,
        effect,
      };
      this.recordAudit(context, decision);
      return decision;
    }

    // Phase 1: DENY check
    for (const rule of activeRules) {
      if (rule.action === 'DENY' && this.matchesConditions(rule, context)) {
        const decision: PolicyDecision = {
          action: 'DENY',
          allowed: false,
          requiresApproval: false,
          matchedRule: rule,
          effect,
          reason: `Policy violation: ${rule.name} - ${rule.description || 'Access denied'}`,
        };
        this.recordAudit(context, decision);
        return decision;
      }
    }

    // Phase 2: REQUIRE_APPROVAL check
    for (const rule of activeRules) {
      if (rule.action === 'REQUIRE_APPROVAL' && this.matchesConditions(rule, context)) {
        const decision: PolicyDecision = {
          action: 'REQUIRE_APPROVAL',
          allowed: false,
          requiresApproval: true,
          matchedRule: rule,
          effect,
          reason: `Approval required: ${rule.name} - ${rule.description || 'Action requires user confirmation'}`,
        };
        this.recordAudit(context, decision);
        return decision;
      }
    }

    // Phase 3: ALLOW check
    for (const rule of activeRules) {
      if (rule.action === 'ALLOW' && this.matchesConditions(rule, context)) {
        const decision: PolicyDecision = {
          action: 'ALLOW',
          allowed: true,
          requiresApproval: false,
          matchedRule: rule,
          effect,
          reason: `Allowed by policy: ${rule.name}`,
        };
        this.recordAudit(context, decision);
        return decision;
      }
    }

    // Phase 4: effect-first fallback. Only a DECLARED/known effect may be
    // permitted by default; an unknown tool or effect fails closed.
    const knownEffect = Object.prototype.hasOwnProperty.call(EFFECTS, effect);
    const hardStop = effect === 'unknown' || !knownEffect || NEVER_AUTO.has(effect) ||
      effect === 'shell_outside' || (context.tainted === true && SHELLS.has(effect));
    const fallbackAction: PolicyAction = hardStop ? 'REQUIRE_APPROVAL'
      : knownEffect ? 'ALLOW' : this.defaultAction;
    const decision: PolicyDecision = {
      action: fallbackAction,
      allowed: fallbackAction === 'ALLOW',
      requiresApproval: fallbackAction === 'REQUIRE_APPROVAL',
      effect,
      reason: hardStop
        ? `Effect '${effect}' requires interactive approval (fail-closed default)`
        : `Default boundary rule applied for effect '${effect}' (${fallbackAction})`,
    };

    this.recordAudit(context, decision);
    return decision;
  }

  /** Declared effect wins; otherwise infer from the tool name; otherwise unknown (fail closed). */
  private resolveEffect(context: PolicyEvaluationContext): string {
    if (context.args.unsandboxed === true) return 'shell_outside';
    const declared = context.declaredEffect;
    if (typeof declared === 'string') {
      // A declared effect that is not recognised is never silently re-inferred.
      return Object.prototype.hasOwnProperty.call(EFFECTS, declared) ? declared : 'unknown';
    }
    if (context.tool.startsWith('inspect_')) return 'read';
    return TOOL_EFFECTS[context.tool] ?? 'unknown';
  }

  /** Egress targets that are always denied unless the operator allowlisted them. */
  private checkNetworkBoundary(context: PolicyEvaluationContext): string | null {
    const raw = [
      context.args.url, context.args.domain, context.args.host, context.args.endpoint,
      context.args.command, context.args.CommandLine, context.args.cmd,
    ].filter((v): v is string => typeof v === 'string').join(' ').toLowerCase();
    if (!raw.trim()) return null;

    const allowlist = (context.allowlistedHosts ?? [])
      .map((entry) => String(entry).toLowerCase()).filter(Boolean);
    for (const host of DENIED_HOSTS) {
      if (raw.includes(host) && !allowlist.includes(host)) {
        return `Cloud metadata endpoint ${host} is denied`;
      }
    }
    const loopback = raw.match(LOOPBACK_WITH_PORT);
    if (loopback && !allowlist.some((entry) => loopback.some((endpoint) => endpoint.includes(entry)))) {
      return `Local daemon loopback endpoint ${loopback[0]} is denied`;
    }
    return null;
  }

  private matchesConditions(rule: PolicyRule, context: PolicyEvaluationContext): boolean {
    const c = rule.conditions;

    // Check Tools filter
    if (c.tools && c.tools.length > 0) {
      const toolMatch = c.tools.some((pattern) => {
        if (pattern === '*' || pattern === context.tool) return true;
        if (pattern.endsWith('*')) {
          const prefix = pattern.slice(0, -1);
          return context.tool.startsWith(prefix);
        }
        return false;
      });
      if (!toolMatch) return false;
    }

    // Check Initiators filter
    if (c.initiators && c.initiators.length > 0) {
      const init = context.initiator || 'user';
      if (!c.initiators.includes(init)) return false;
    }

    // Check Actors filter
    if (c.actors && c.actors.length > 0) {
      if (!context.actor || !c.actors.includes(context.actor)) return false;
    }

    // Check Command regex filter
    if (c.commandsRegex && c.commandsRegex.length > 0) {
      const cmdStr = (context.args.command || context.args.CommandLine || context.args.cmd || '') as string;
      const cmdMatch = c.commandsRegex.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(cmdStr);
        } catch {
          // If regex is broken, fail closed (matches for DENY, does not match for ALLOW)
          return rule.action === 'DENY';
        }
      });
      if (!cmdMatch) return false;
    }

    // Check Path filters (prefix & regex)
    const targetPath = (context.args.path || context.args.Path || context.args.filePath || '') as string;
    const cmdStr = (context.args.command || context.args.CommandLine || context.args.cmd || '') as string;
    const pathChecked = targetPath || (context.tool === 'exec_command' ? cmdStr : '');

    if (c.pathsPrefix && c.pathsPrefix.length > 0) {
      if (!pathChecked) return false;
      const prefixMatch = c.pathsPrefix.some((prefix) => pathChecked.startsWith(prefix) || pathChecked.includes(prefix));
      if (!prefixMatch) return false;
    }

    if (c.pathsRegex && c.pathsRegex.length > 0) {
      if (!pathChecked) return false;
      const regexMatch = c.pathsRegex.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(pathChecked);
        } catch {
          return rule.action === 'DENY';
        }
      });
      if (!regexMatch) return false;
    }

    // Check Domain filter
    if (c.domains && c.domains.length > 0) {
      const urlStr = (context.args.url || context.args.domain || '') as string;
      if (!urlStr) return false;
      const domainMatch = c.domains.some((d) => urlStr.includes(d));
      if (!domainMatch) return false;
    }

    return true;
  }

  private recordAudit(context: PolicyEvaluationContext, decision: PolicyDecision): void {
    const entry: PolicyAuditEntry = {
      id: `audit_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: Date.now(),
      tool: context.tool,
      actor: context.actor,
      initiator: context.initiator,
      decision: decision.action,
      ruleId: decision.matchedRule?.id,
      ruleName: decision.matchedRule?.name,
      reason: decision.reason,
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.shift();
    }
  }

  private loadDefaultPresets(): void {
    // 1. Strict Deny on sensitive system and credential paths
    this.rules.set('rule_deny_sensitive_paths', {
      id: 'rule_deny_sensitive_paths',
      name: 'Deny Sensitive Credentials & OS Paths',
      description: 'Blocks reading or writing sensitive system paths, ssh keys, aws credentials, and .env secrets',
      enabled: true,
      action: 'DENY',
      conditions: {
        pathsPrefix: ['/etc/', '/var/root', '/var/db', '/System/', '.ssh', '.aws', '.gnupg', '.env'],
      },
    });

    // 2. Deny dangerous destructive commands
    this.rules.set('rule_deny_destructive_cmds', {
      id: 'rule_deny_destructive_cmds',
      name: 'Deny Destructive Shell Commands',
      description: 'Blocks dangerous commands including rm -rf /, fork bombs, disk formatting, and unvetted sudo',
      enabled: true,
      action: 'DENY',
      conditions: {
        tools: ['exec_command'],
        commandsRegex: [
          '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force)\\s+[/~]',
          '\\bmkfs\\b',
          '\\bdd\\s+if=',
          ':\\(\\)\\s*\\{.*\\};\\s*:',
          '\\bsudo\\s+',
        ],
      },
    });

    // 3. Allow standard non-destructive workspace commands
    this.rules.set('rule_allow_safe_dev_tools', {
      id: 'rule_allow_safe_dev_tools',
      name: 'Allow Standard Dev Tools',
      description: 'Permits standard read-only development inspection commands',
      enabled: true,
      action: 'ALLOW',
      conditions: {
        tools: ['exec_command'],
        commandsRegex: [
          '^git\\s+(status|diff|log|branch|show)',
          '^node\\s+(--version|-v)',
          '^pnpm\\s+(test|build|list|--version)',
          '^npm\\s+(test|--version)',
          '^ls(\\s|$)',
          '^pwd$',
        ],
      },
    });

    this.persistToDisk();
  }

  private loadFromDisk(): void {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return;
    try {
      const raw = fs.readFileSync(this.storageFile, 'utf8');
      const parsed: PolicyRule[] = JSON.parse(raw);
      this.rules.clear();
      for (const r of parsed) {
        this.rules.set(r.id, r);
      }
    } catch {
      // Ignore parse failure; keep defaults
    }
  }

  private persistToDisk(): void {
    if (!this.storageFile) return;
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(Array.from(this.rules.values()), null, 2);
      fs.writeFileSync(this.storageFile, data, { mode: 0o600 });
    } catch {
      // Ignore write errors
    }
  }
}
