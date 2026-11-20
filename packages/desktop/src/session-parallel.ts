/**
 * Per-session turn state and a bounded parallel-session admission gate.
 *
 * The bridge keeps a "focused" session for the single-session APIs, but turns
 * are owned by these records so two sessions can run at the same time. Every
 * active count is keyed by session, so re-submitting a turn on one session does
 * not steal a slot from another session or double-decrement the counter.
 */

import type { AgentCoordinator } from '@opensand/coordinator';

export interface SessionRuntime {
  key: string;
  sessionId: string;
  agentId?: string;
  coordinator: AgentCoordinator;
  abort: AbortController | null;
  /** Fences a cancelled turn's completion against a newer turn on the same session. */
  generation: number;
  running: boolean;
  lastActive: number;
}

export interface QueuedSend {
  key: string;
  sessionId: string;
  agentId?: string;
  query: string;
}

export interface AdmissionResult {
  admitted: boolean;
  queued: boolean;
  reason?: 'capacity' | 'queue-full';
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Operator-tunable; defaults chosen for a local-first desktop agent. */
export const MAX_PARALLEL_SESSIONS_PER_AGENT = envInt('OPENSAND_MAX_PARALLEL_SESSIONS_PER_AGENT', 3, 1, 16);
export const MAX_QUEUED_SENDS_PER_AGENT = envInt('OPENSAND_MAX_QUEUED_SENDS_PER_AGENT', 20, 1, 100);

export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();

  register(key: string, sessionId: string, agentId: string | undefined, coordinator: AgentCoordinator): SessionRuntime {
    const existing = this.runtimes.get(key);
    if (existing) {
      existing.coordinator = coordinator;
      existing.lastActive = Date.now();
      return existing;
    }
    const runtime: SessionRuntime = {
      key, sessionId, agentId, coordinator,
      abort: null, generation: 0, running: false, lastActive: Date.now(),
    };
    this.runtimes.set(key, runtime);
    return runtime;
  }

  get(key: string | undefined): SessionRuntime | undefined {
    return key ? this.runtimes.get(key) : undefined;
  }

  findBySession(sessionId: string): SessionRuntime | undefined {
    for (const runtime of this.runtimes.values()) {
      if (runtime.sessionId === sessionId) return runtime;
    }
    return undefined;
  }

  remove(key: string): void {
    this.runtimes.delete(key);
  }

  clear(): void {
    this.runtimes.clear();
  }

  values(): IterableIterator<SessionRuntime> {
    return this.runtimes.values();
  }
}

export class SessionAdmission {
  private readonly activeByAgent = new Map<string, Set<string>>();
  private readonly queues = new Map<string, QueuedSend[]>();

  /** Call synchronously, before the first await that spawns work. */
  admit(agent: string, send: QueuedSend): AdmissionResult {
    const active = this.activeByAgent.get(agent) ?? new Set<string>();
    this.activeByAgent.set(agent, active);

    // Re-submit on an already-running session keeps its existing slot.
    if (active.has(send.key)) return { admitted: true, queued: false };

    if (active.size >= MAX_PARALLEL_SESSIONS_PER_AGENT) {
      const queue = this.queues.get(agent) ?? [];
      this.queues.set(agent, queue);
      if (queue.length >= MAX_QUEUED_SENDS_PER_AGENT) {
        return { admitted: false, queued: false, reason: 'queue-full' };
      }
      queue.push(send);
      return { admitted: false, queued: true };
    }

    active.add(send.key);
    return { admitted: true, queued: false };
  }

  /** Release a session's slot and return the next queued send for that agent. */
  finish(agent: string, key: string): QueuedSend | undefined {
    const active = this.activeByAgent.get(agent);
    active?.delete(key);
    const queue = this.queues.get(agent);
    const next = queue?.shift();
    if (next && active) active.add(next.key);
    return next;
  }

  /** Called when a turn is cancelled before its slot was released. */
  release(agent: string, key: string): void {
    this.activeByAgent.get(agent)?.delete(key);
  }

  cancelQueued(key: string): void {
    for (const [agent, queue] of this.queues) {
      const index = queue.findIndex((send) => send.key === key);
      if (index >= 0) {
        queue.splice(index, 1);
        if (queue.length === 0) this.queues.delete(agent);
        return;
      }
    }
  }

  /** Remove queued sends for a session that has no live runtime yet. */
  cancelSession(sessionId: string): boolean {
    let removed = false;
    for (const [agent, queue] of this.queues) {
      const kept = queue.filter((send) => send.sessionId !== sessionId);
      if (kept.length !== queue.length) {
        removed = true;
        if (kept.length) this.queues.set(agent, kept);
        else this.queues.delete(agent);
      }
    }
    return removed;
  }

  clear(): void {
    this.activeByAgent.clear();
    this.queues.clear();
  }
}
