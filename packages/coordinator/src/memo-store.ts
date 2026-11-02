/**
 * MemoStore — read-only bridge to the `memo` memory database (~/.memory/memo.db).
 *
 * The desktop/CLI previously injected only the JSON memory store, which held a
 * handful of facts. This reads the real store so every session starts with the
 * profile tier plus the project's episodic facts.
 *
 * Read-only by design: writes go through the `memo` CLI, which owns validation,
 * dedup and the review queue. Reading is a plain SQLite query.
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface MemoFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  tier: string;
  confidence: number;
  cwd: string | null;
}

const DEFAULT_DB = path.join(os.homedir(), ".memory", "memo.db");

export class MemoStore {
  private dbPath: string;

  constructor(dbPath: string = DEFAULT_DB) {
    this.dbPath = dbPath;
  }

  available(): boolean {
    return existsSync(this.dbPath);
  }

  private query(sql: string, params: (string | number)[] = []): MemoFact[] {
    if (!this.available()) return [];
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.map((r) => ({
        id: Number(r.id),
        subject: String(r.subject),
        predicate: String(r.predicate),
        object: String(r.object),
        scope: String(r.scope),
        tier: String(r.tier),
        confidence: Number(r.confidence ?? 1),
        cwd: r.cwd === null || r.cwd === undefined ? null : String(r.cwd),
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  /** Always-injected tier: identity, standing rules, machine conventions. */
  profileFacts(): MemoFact[] {
    return this.query(
      `SELECT id,subject,predicate,object,scope,tier,confidence,cwd FROM facts
       WHERE tier='profile' AND status='active'
       ORDER BY scope, subject, id`,
    );
  }

  /** Episodic facts whose recorded cwd is an ancestor of (or equal to) cwd. */
  projectFacts(cwd: string, limit = 20): MemoFact[] {
    return this.query(
      `SELECT id,subject,predicate,object,scope,tier,confidence,cwd FROM facts
       WHERE status='active' AND tier IN ('episodic','reference')
         AND cwd IS NOT NULL AND ? LIKE cwd || '%'
       ORDER BY verified_at DESC LIMIT ?`,
      [cwd, limit],
    );
  }

  /** Top facts matching a query, using the FTS index. */
  search(queryText: string, limit = 10): MemoFact[] {
    const toks = queryText
      .toLowerCase()
      .split(/[^\p{L}\p{N}_']+/u)
      .filter((t) => t.length > 1);
    if (toks.length === 0) return [];
    const match = toks.map((t) => `"${t}"*`).join(" OR ");
    return this.query(
      `SELECT f.id,f.subject,f.predicate,f.object,f.scope,f.tier,f.confidence,f.cwd
       FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
       WHERE facts_fts MATCH ? AND f.status='active'
       ORDER BY bm25(facts_fts,3.0,1.5,1.0) LIMIT ?`,
      [match, limit],
    );
  }

  private render(title: string, facts: MemoFact[]): string[] {
    if (facts.length === 0) return [];
    const lines = [`### ${title}`];
    for (const f of facts) {
      lines.push(`- ${f.subject} — ${f.predicate}: ${f.object}`);
    }
    return lines;
  }

  /**
   * The prompt block. Bounded on purpose: profile always, project-scoped
   * episodic only, never the whole store.
   */
  /**
   * Lessons that outgrew their project. Captured lessons usually have no cwd
   * (they were mined from archives spanning many repos), so project scoping
   * alone would silently exclude the most valuable facts in the store.
   */
  recentLessons(limit = 25): MemoFact[] {
    return this.query(
      `SELECT id,subject,predicate,object,scope,tier,confidence,cwd FROM facts
       WHERE status='active' AND tier IN ('episodic','reference')
         AND cwd IS NULL
       ORDER BY confidence DESC, verified_at DESC LIMIT ?`,
      [limit],
    );
  }

  formatForPrompt(cwd: string = process.cwd()): string {
    if (!this.available()) return "";
    const sections: string[] = [];
    sections.push(...this.render("Profile & Standing Rules", this.profileFacts()));
    sections.push(...this.render("This Project", this.projectFacts(cwd)));
    sections.push(...this.render("Lessons Learned", this.recentLessons()));
    return sections.join("\n\n");
  }
}
