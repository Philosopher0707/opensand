/**
 * A local OpenAI-compatible HTTP stub for the mesh tournament tests
 * (docs/design/phase7-mesh-tournament.md §10 S4).
 *
 * Responses are scripted per model and consumed in order, including non-200
 * statuses (402, 429, 5xx) so the runner's retry/park rules are exercised
 * over real HTTP. A scripted response with `hang: true` never answers, for
 * the kill -9 test.
 */

import * as http from "node:http";

export interface StubResponse {
  status: number;
  /** OpenAI-compatible body; `chatResponse()` builds the usual 200 shape. */
  body?: unknown;
  /** Delay before responding, in ms. */
  delayMs?: number;
  /** Never answer at all (the request just hangs). */
  hang?: boolean;
}

export interface StubRequest {
  model: string;
  body: Record<string, unknown>;
}

export class StubProvider {
  readonly requests: StubRequest[] = [];
  private readonly script: Map<string, StubResponse[]>;
  private server?: http.Server;
  private port = 0;

  constructor(script: Record<string, StubResponse[]>) {
    this.script = new Map(Object.entries(script));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server!.address() as { port: number };
    this.port = addr.port;
    return this.baseUrl;
  }

  /** Drop every open connection (hang responses included) and stop listening. */
  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Read the whole request body first: no response work is tied to the
    // request stream's close event (see docs/lessons/2026-11-19-stub-req-close-cancels-paced-response.md).
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { model?: string };
    const model = body.model ?? "";
    this.requests.push({ model, body });

    const queue = this.script.get(model) ?? [];
    const next = queue.shift() ?? { status: 500, body: { error: "stub script exhausted" } };
    if (next.hang) return; // never answers
    const write = () => {
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body ?? {}));
    };
    if (next.delayMs) setTimeout(write, next.delayMs);
    else write();
  }
}

/** The usual 200 shape: one assistant message plus the usage the provider reports. */
export function chatResponse(
  content: string,
  usage: { promptTokens: number; completionTokens: number },
): StubResponse {
  return {
    status: 200,
    body: {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens },
    },
  };
}

/** The S4 agent protocol content: a set of writes into the attempt tree. */
export function writesContent(writes: Record<string, string>): string {
  return JSON.stringify({ writes });
}
