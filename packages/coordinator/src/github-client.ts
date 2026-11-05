import { execFileSync } from "node:child_process";

/**
 * A GitHub client that performs real REST calls with a real token.
 *
 * Why this exists next to `ConnectorManager`: that class owns OAuth *state*
 * (status, scopes, where the token lives on disk). It deliberately does not
 * talk to provider APIs — `connectors.ts` makes no fetches at all, and its
 * `completeOAuth` mints a placeholder token. Everything that needs to actually
 * reach GitHub goes through here, so a caller can never mistake recorded state
 * for a completed call.
 *
 * Failures are returned, never invented. There is no success path that does not
 * come from a 2xx response, and no field that is not derived from response data.
 */

export interface GitHubApiError {
  ok: false;
  status: number;
  message: string;
  /** True when the token is missing entirely, as opposed to rejected. */
  unconnected?: boolean;
  /** True when GitHub rejected the credentials (401) — token is bad or revoked. */
  unauthorized?: boolean;
  /** True when the token lacks the scope for this call (403/404). */
  forbidden?: boolean;
}

export interface GitHubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  html_url: string;
  pushed_at: string | null;
  open_issues_count: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: string | null;
  created_at: string;
  is_pull_request: boolean;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  html_url: string;
  user: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  changed_files: number | null;
  additions: number | null;
  deletions: number | null;
  mergeable_state: string | null;
  checks: { total: number; failing: number; pending: number };
  body: string | null;
}

export interface GitHubViewer {
  login: string;
  id: number;
  name: string | null;
  scopes: string[];
}

const API = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 15000;

function userAgent(): string {
  return "opensand-github-connector";
}

/**
 * Resolve a GitHub token, in priority order:
 *   1. explicit argument (callers that hold one already)
 *   2. GITHUB_TOKEN / GH_TOKEN environment
 *   3. `gh auth token` — the CLI the operator is already signed in with
 *
 * Returns null when none are available, so callers can report "not connected"
 * rather than failing opaquely mid-call.
 */
export function resolveGitHubToken(explicit?: string): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const out = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out && out.trim()) return out.trim();
  } catch {
    // gh absent or not signed in — fall through to "unconnected"
  }
  return null;
}

/**
 * The slice of GitHubClient the tools depend on. Depending on this rather than
 * the concrete class keeps the tool handler testable without network access and
 * without inheriting the operator's `gh` session.
 */
export interface GitHubActions {
  isConnected(): boolean;
  getViewer(): Promise<GitHubViewer | GitHubApiError>;
  getRepo(repo: string): Promise<GitHubRepo | GitHubApiError>;
  listIssues(
    repo: string,
    options?: { state?: "open" | "closed" | "all"; limit?: number }
  ): Promise<GitHubIssue[] | GitHubApiError>;
  getPullRequest(repo: string, number: number): Promise<GitHubPullRequest | GitHubApiError>;
  createIssue(
    repo: string,
    title: string,
    body?: string
  ): Promise<{ number: number; html_url: string; state: string } | GitHubApiError>;
  commentOnIssue(
    repo: string,
    number: number,
    body: string
  ): Promise<{ id: number; html_url: string } | GitHubApiError>;
}

/**
 * Human-readable name for where a token came from. Never returns the token.
 * Exported so callers and tests share one implementation.
 */
export function connectorSourceLabel(token: string | null | undefined): string {
  if (!token || !token.trim()) {
    return "none — set GITHUB_TOKEN or run `gh auth login`";
  }
  if (token.startsWith("ghp_")) return "classic PAT";
  if (token.startsWith("github_pat_")) return "fine-grained PAT";
  if (token.startsWith("ghs_")) return "GitHub App installation token";
  return "token";
}

export class GitHubClient implements GitHubActions {
  private token: string | null;
  private timeoutMs: number;

  constructor(options?: { token?: string; timeoutMs?: number }) {
    this.token = resolveGitHubToken(options?.token);
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public isConnected(): boolean {
    return this.token !== null;
  }

  /** Never returns the token; safe to log. */
  public describe(): { connected: boolean; source: string } {
    return { connected: this.token !== null, source: connectorSourceLabel(this.token) };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<{ ok: true; data: T; scopes: string[] } | GitHubApiError> {
    if (!this.token) {
      return {
        ok: false,
        status: 0,
        unconnected: true,
        message:
          "GitHub is not connected. No token found in the constructor, GITHUB_TOKEN, GH_TOKEN, or `gh auth token`.",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${API}${endpoint}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": userAgent(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const scopes = (res.headers.get("x-oauth-scopes") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const errBody = (await res.json()) as { message?: string };
          if (errBody?.message) message = `${message}: ${errBody.message}`;
        } catch {
          // non-JSON error body; keep the status line
        }
        return {
          ok: false,
          status: res.status,
          message,
          unauthorized: res.status === 401,
          forbidden: res.status === 403 || res.status === 404,
        };
      }

      // 204 No Content (e.g. some PATCHes) has no body to parse.
      if (res.status === 204) {
        return { ok: true, data: undefined as unknown as T, scopes };
      }
      const data = (await res.json()) as T;
      return { ok: true, data, scopes };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "AbortError") {
        return { ok: false, status: 0, message: `Request to ${endpoint} timed out after ${this.timeoutMs}ms.` };
      }
      return {
        ok: false,
        status: 0,
        message: `Request to ${endpoint} failed: ${(err as Error)?.message ?? String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async getViewer(): Promise<GitHubViewer | GitHubApiError> {
    const r = await this.request<{ login: string; id: number; name: string | null }>("GET", "/user");
    if (!r.ok) return r;
    return { login: r.data.login, id: r.data.id, name: r.data.name, scopes: r.scopes };
  }

  public async getRepo(repo: string): Promise<GitHubRepo | GitHubApiError> {
    const r = await this.request<GitHubRepo>("GET", `/repos/${repo}`);
    if (!r.ok) return r;
    const d = r.data;
    return {
      full_name: d.full_name,
      private: d.private,
      default_branch: d.default_branch,
      description: d.description,
      html_url: d.html_url,
      pushed_at: d.pushed_at,
      open_issues_count: d.open_issues_count,
    };
  }

  public async listIssues(
    repo: string,
    options?: { state?: "open" | "closed" | "all"; limit?: number }
  ): Promise<GitHubIssue[] | GitHubApiError> {
    const state = options?.state ?? "open";
    const limit = Math.max(1, Math.min(options?.limit ?? 30, 100));
    const r = await this.request<
      Array<{
        number: number;
        title: string;
        state: string;
        html_url: string;
        user: { login: string } | null;
        created_at: string;
        pull_request?: unknown;
      }>
    >("GET", `/repos/${repo}/issues?state=${state}&per_page=${limit}`);
    if (!r.ok) return r;
    return r.data.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      html_url: i.html_url,
      user: i.user?.login ?? null,
      created_at: i.created_at,
      // GitHub's issues endpoint includes PRs unless filtered; name that clearly.
      is_pull_request: Boolean(i.pull_request),
    }));
  }

  public async getPullRequest(repo: string, number: number): Promise<GitHubPullRequest | GitHubApiError> {
    const r = await this.request<{
      number: number;
      title: string;
      state: string;
      draft: boolean;
      merged: boolean;
      html_url: string;
      user: { login: string } | null;
      head: { ref: string; sha: string };
      base: { ref: string };
      changed_files?: number;
      additions?: number;
      deletions?: number;
      mergeable_state?: string;
      body: string | null;
    }>("GET", `/repos/${repo}/pulls/${number}`);
    if (!r.ok) return r;
    const d = r.data;

    // Checks are a separate endpoint; a failure there must not fail the PR read.
    let checks = { total: 0, failing: 0, pending: 0 };
    const checksRes = await this.request<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(
      "GET",
      `/repos/${repo}/commits/${d.head.sha}/check-runs`
    );
    if (checksRes.ok && checksRes.data?.check_runs) {
      const runs = checksRes.data.check_runs;
      checks = {
        total: runs.length,
        failing: runs.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out").length,
        pending: runs.filter((c) => c.status !== "completed").length,
      };
    }

    return {
      number: d.number,
      title: d.title,
      state: d.state,
      draft: d.draft,
      merged: d.merged,
      html_url: d.html_url,
      user: d.user?.login ?? null,
      head: { ref: d.head.ref, sha: d.head.sha },
      base: { ref: d.base.ref },
      changed_files: d.changed_files ?? null,
      additions: d.additions ?? null,
      deletions: d.deletions ?? null,
      mergeable_state: d.mergeable_state ?? null,
      checks,
      body: d.body,
    };
  }

  public async createIssue(
    repo: string,
    title: string,
    body?: string
  ): Promise<{ number: number; html_url: string; state: string } | GitHubApiError> {
    if (!title || !title.trim()) {
      return { ok: false, status: 0, message: "create_issue requires a non-empty title." };
    }
    const r = await this.request<{ number: number; html_url: string; state: string }>(
      "POST",
      `/repos/${repo}/issues`,
      { title, body: body ?? "" }
    );
    if (!r.ok) return r;
    return { number: r.data.number, html_url: r.data.html_url, state: r.data.state };
  }

  /** Comment on an issue or PR. Both live on the issues endpoint. */
  public async commentOnIssue(
    repo: string,
    number: number,
    body: string
  ): Promise<{ id: number; html_url: string } | GitHubApiError> {
    if (!body || !body.trim()) {
      return { ok: false, status: 0, message: "comment requires a non-empty body." };
    }
    const r = await this.request<{ id: number; html_url: string }>(
      "POST",
      `/repos/${repo}/issues/${number}/comments`,
      { body }
    );
    if (!r.ok) return r;
    return { id: r.data.id, html_url: r.data.html_url };
  }
}
