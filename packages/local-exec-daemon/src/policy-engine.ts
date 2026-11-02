/**
 * OpenSand Declarative Boundary Policy Engine
 * Fail-closed CEL-style rule evaluation for tool calls, commands, files, and network access.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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
}

export interface PolicyDecision {
  action: PolicyAction;
  allowed: boolean;
  requiresApproval: boolean;
  matchedRule?: PolicyRule;
  reason: string;
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
    const activeRules = Array.from(this.rules.values()).filter((r) => r.enabled);

    // Phase 1: DENY check
    for (const rule of activeRules) {
      if (rule.action === 'DENY' && this.matchesConditions(rule, context)) {
        const decision: PolicyDecision = {
          action: 'DENY',
          allowed: false,
          requiresApproval: false,
          matchedRule: rule,
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
          reason: `Allowed by policy: ${rule.name}`,
        };
        this.recordAudit(context, decision);
        return decision;
      }
    }

    // Phase 4: Default Fallback Action
    // Read-only tools are safe to allow by default unless specifically restricted
    const isReadOnly = ['read_file', 'list_directory'].includes(context.tool) ||
      context.tool.startsWith('inspect_');

    const fallbackAction = isReadOnly ? 'ALLOW' : this.defaultAction;
    const decision: PolicyDecision = {
      action: fallbackAction,
      allowed: fallbackAction === 'ALLOW',
      requiresApproval: fallbackAction === 'REQUIRE_APPROVAL',
      reason: isReadOnly
        ? `Permitted under default read-only safety policy`
        : `Default boundary rule applied (${fallbackAction})`,
    };

    this.recordAudit(context, decision);
    return decision;
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

    if (c.pathsPrefix && c.pathsPrefix.length > 0) {
      if (!targetPath) return false;
      const prefixMatch = c.pathsPrefix.some((prefix) => targetPath.startsWith(prefix) || targetPath.includes(prefix));
      if (!prefixMatch) return false;
    }

    if (c.pathsRegex && c.pathsRegex.length > 0) {
      if (!targetPath) return false;
      const regexMatch = c.pathsRegex.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(targetPath);
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
