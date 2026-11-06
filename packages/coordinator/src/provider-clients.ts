/**
 * Real Slack and Linear clients.
 *
 * These exist for the same reason `github-client.ts` does: the connector store
 * records OAuth *state*, and the tools were reporting success from that state
 * without contacting the provider. `slack_post_message` invented a `ts` from
 * `Date.now()`; `linear_create_issue` invented an identifier from
 * `Math.random()` and a URL by interpolation.
 *
 * Two provider-specific traps are handled here explicitly:
 *
 *  * Slack answers HTTP 200 for application errors (`{"ok": false, "error":
 *    "channel_not_found"}`). Checking the status code alone reports failure as
 *    success, so every Slack call checks the body's `ok` field.
 *  * Linear's GraphQL endpoint answers HTTP 200 with an `errors` array. Same
 *    shape of trap, so a response with `errors` is a failure regardless of
 *    status.
 *
 * Credential resolution never reads a token from a transcript or a config file
 * in plaintext: explicit argument, then the environment, then the connector
 * store via an injected accessor.
 */

export interface ProviderError {
  ok: false;
  status: number;
  message: string;
  /** No credential was available at all, as opposed to one being rejected. */
  unconnected?: boolean;
  /** Provider rejected the credential. */
  unauthorized?: boolean;
  /** Provider understood the credential but refused the operation. */
  refused?: boolean;
  /** Slack's machine-readable error code, when it supplied one. */
  code?: string;
}

const TIMEOUT_MS = 15000;

export function sourceLabelFor(token: string | null | undefined, kind: "slack" | "linear"): string {
  if (!token || !token.trim()) {
    return kind === "slack"
      ? "none — set SLACK_BOT_TOKEN or configure the Slack connector"
      : "none — set LINEAR_API_KEY or configure the Linear connector";
  }
  if (kind === "slack") {
    if (token.startsWith("xoxb-")) return "bot token";
    if (token.startsWith("xoxp-")) return "user token";
    if (token.startsWith("xapp-")) return "app-level token (cannot post as a bot)";
    return "token";
  }
  return token.startsWith("lin_api_") ? "personal API key" : "token";
}

abstract class HttpProvider {
  protected constructor() {
    // No shared state yet; declared so subclasses have a super() to call.
  }

  protected async request<T>(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ): Promise<{ ok: true; status: number; data: T } | ProviderError> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      let data: unknown = undefined;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          return {
            ok: false,
            status: res.status,
            message: `Non-JSON response from ${url}: ${text.slice(0, 200)}`,
          };
        }
      }
      return { ok: true, status: res.status, data: data as T };
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        return { ok: false, status: 0, message: `Request to ${url} timed out after ${TIMEOUT_MS}ms.` };
      }
      return { ok: false, status: 0, message: `Request to ${url} failed: ${(err as Error)?.message ?? String(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------- Slack ----

interface SlackResponse {
  ok: boolean;
  error?: string;
  warning?: string;
}

export interface SlackIdentity {
  team: string;
  team_id: string;
  user: string;
  user_id: string;
  bot_id?: string;
  url?: string;
}

export class SlackClient extends HttpProvider {
  private token: string | null;
  private getTokenFn?: () => string | null | undefined;

  constructor(options?: { token?: string; storedToken?: string | null; getToken?: () => string | null | undefined }) {
    super();
    const explicit = options?.token?.trim();
    const env = (process.env.SLACK_BOT_TOKEN || process.env.SLACK_TOKEN || "").trim();
    this.token = explicit || env || options?.storedToken?.trim() || null;
    this.getTokenFn = options?.getToken;
  }

  public getToken(): string | null {
    if (this.getTokenFn) {
      const dynamic = this.getTokenFn();
      if (dynamic && dynamic.trim().length > 0) return dynamic.trim();
    }
    return this.token;
  }

  public isConnected(): boolean {
    const t = this.getToken();
    return t !== null && t.length > 0;
  }

  public describe(): { connected: boolean; source: string } {
    const t = this.getToken();
    return { connected: this.isConnected(), source: sourceLabelFor(t, "slack") };
  }

  private guard(): ProviderError | null {
    return this.isConnected()
      ? null
      : {
          ok: false,
          status: 0,
          unconnected: true,
          message: "Slack is not connected. No bot token in the argument, SLACK_BOT_TOKEN, or the connector store.",
        };
  }

  /** Verify the token and learn which workspace it belongs to. */
  public async authTest(): Promise<SlackIdentity | ProviderError> {
    const blocked = this.guard();
    if (blocked) return blocked;

    const r = await this.request<SlackResponse & Partial<SlackIdentity>>("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    if (!r.ok) return r;

    // HTTP 200 does not mean success on Slack. Check the body.
    if (!r.data.ok) {
      return {
        ok: false,
        status: r.status,
        code: r.data.error,
        unauthorized: r.data.error === "invalid_auth" || r.data.error === "not_authed" || r.data.error === "token_revoked",
        message: `Slack rejected the credential: ${r.data.error ?? "unknown_error"}`,
      };
    }
    return {
      team: r.data.team ?? "",
      team_id: r.data.team_id ?? "",
      user: r.data.user ?? "",
      user_id: r.data.user_id ?? "",
      bot_id: r.data.bot_id,
      url: r.data.url,
    };
  }

  public async postMessage(
    channel: string,
    text: string
  ): Promise<{ ts: string; channel: string; permalink?: string } | ProviderError> {
    const blocked = this.guard();
    if (blocked) return blocked;
    if (!channel.trim()) {
      return { ok: false, status: 0, message: "slack_post_message requires a non-empty channel." };
    }
    if (!text.trim()) {
      return { ok: false, status: 0, message: "slack_post_message requires non-empty text." };
    }

    const r = await this.request<SlackResponse & { ts?: string; channel?: string; message?: { permalink?: string } }>(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.getToken()}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text }),
      }
    );
    if (!r.ok) return r;

    if (!r.data.ok || !r.data.ts) {
      return {
        ok: false,
        status: r.status,
        code: r.data.error,
        refused: true,
        message: `Slack refused the message: ${r.data.error ?? "no ts returned"}`,
      };
    }
    return { ts: r.data.ts, channel: r.data.channel ?? channel, permalink: r.data.message?.permalink };
  }
}

// --------------------------------------------------------------- Linear ----

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export interface LinearIdentity {
  id: string;
  name: string;
  email: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export class LinearClient extends HttpProvider {
  private token: string | null;
  private getTokenFn?: () => string | null | undefined;

  constructor(options?: { token?: string; storedToken?: string | null; getToken?: () => string | null | undefined }) {
    super();
    const explicit = options?.token?.trim();
    const env = (process.env.LINEAR_API_KEY || "").trim();
    this.token = explicit || env || options?.storedToken?.trim() || null;
    this.getTokenFn = options?.getToken;
  }

  public getToken(): string | null {
    if (this.getTokenFn) {
      const dynamic = this.getTokenFn();
      if (dynamic && dynamic.trim().length > 0) return dynamic.trim();
    }
    return this.token;
  }

  public isConnected(): boolean {
    const t = this.getToken();
    return t !== null && t.length > 0;
  }

  public describe(): { connected: boolean; source: string } {
    const t = this.getToken();
    return { connected: this.isConnected(), source: sourceLabelFor(t, "linear") };
  }

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T | ProviderError> {
    if (!this.isConnected()) {
      return {
        ok: false,
        status: 0,
        unconnected: true,
        message: "Linear is not connected. No API key in the argument, LINEAR_API_KEY, or the connector store.",
      };
    }

    const r = await this.request<GraphQLEnvelope<T>>("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        // Linear personal API keys go in Authorization bare, not as a Bearer token.
        Authorization: this.getToken() as string,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    if (!r.ok) return r;

    // GraphQL reports failure in the body with HTTP 200.
    if (r.data.errors && r.data.errors.length > 0) {
      const msg = r.data.errors.map((e) => e.message).join("; ");
      return {
        ok: false,
        status: r.status,
        refused: true,
        unauthorized: /auth|key|token/i.test(msg),
        message: `Linear GraphQL error: ${msg}`,
      };
    }
    if (r.data.data === undefined) {
      return { ok: false, status: r.status, message: "Linear returned no data." };
    }
    return r.data.data;
  }

  public async viewer(): Promise<LinearIdentity | ProviderError> {
    const d = await this.query<{ viewer: LinearIdentity }>(`query { viewer { id name email } }`);
    if ((d as ProviderError).ok === false) return d as ProviderError;
    return (d as { viewer: LinearIdentity }).viewer;
  }

  public async teams(): Promise<LinearTeam[] | ProviderError> {
    const d = await this.query<{ teams: { nodes: LinearTeam[] } }>(
      `query { teams { nodes { id key name } } }`
    );
    if ((d as ProviderError).ok === false) return d as ProviderError;
    return (d as { teams: { nodes: LinearTeam[] } }).teams.nodes;
  }

  /**
   * Resolve a team key (ENG) or name to the UUID that issueCreate requires.
   * Guessing an identifier instead of asking is what the previous code did.
   */
  public async resolveTeam(keyOrName: string): Promise<LinearTeam | ProviderError> {
    const list = await this.teams();
    if ((list as ProviderError).ok === false) return list as ProviderError;
    const teams = list as LinearTeam[];
    const want = keyOrName.trim().toLowerCase();
    const found = teams.find((t) => t.key.toLowerCase() === want || t.name.toLowerCase() === want);
    if (!found) {
      return {
        ok: false,
        status: 0,
        refused: true,
        message: `No Linear team matching ${JSON.stringify(keyOrName)}. Known teams: ${teams
          .map((t) => t.key)
          .join(", ") || "(none visible to this key)"}.`,
      };
    }
    return found;
  }

  public async createIssue(input: {
    title: string;
    teamKey?: string;
    description?: string;
    priority?: number;
  }): Promise<LinearIssue | ProviderError> {
    if (!input.title || !input.title.trim()) {
      return { ok: false, status: 0, message: "linear_create_issue requires a non-empty title." };
    }

    const team = await this.resolveTeam(input.teamKey?.trim() || "");
    if ((team as ProviderError).ok === false) return team as ProviderError;

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title url }
        }
      }`;

    const d = await this.query<{
      issueCreate: { success: boolean; issue?: LinearIssue };
    }>(mutation, {
      input: {
        title: input.title,
        teamId: (team as LinearTeam).id,
        ...(input.description ? { description: input.description } : {}),
        ...(typeof input.priority === "number" ? { priority: input.priority } : {}),
      },
    });
    if ((d as ProviderError).ok === false) return d as ProviderError;

    const payload = (d as { issueCreate: { success: boolean; issue?: LinearIssue } }).issueCreate;
    if (!payload.success || !payload.issue) {
      return { ok: false, status: 0, refused: true, message: "Linear reported issueCreate did not succeed." };
    }
    return payload.issue;
  }
}
