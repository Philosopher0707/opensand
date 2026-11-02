/**
 * OpenSand Universal AG-UI Protocol Gateway
 * Full wire-level compatibility with the AG-UI (Agent-to-User Interaction) protocol.
 * Enables OpenSand to both serve AG-UI clients and orchestrate external AG-UI agents
 * (LangGraph, CrewAI, Mastra, Pydantic AI, Claude SDK).
 */

import { EventEmitter } from 'node:events';
import { AgentCoordinator } from './coordinator.js';
import { TurnEvent } from './types.js';

export type AgUiEventType =
  | 'RUN_STARTED'
  | 'TEXT_MESSAGE_CHUNK'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_RESULT'
  | 'STATE_UPDATE'
  | 'RUN_FINISHED'
  | 'RUN_ERROR';

export interface AgUiMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface AgUiRunRequest {
  threadId?: string;
  runId?: string;
  agentId?: string;
  messages: AgUiMessage[];
  state?: Record<string, unknown>;
  tools?: any[];
  context?: Record<string, unknown>;
}

export interface AgUiEventPayload {
  event: AgUiEventType;
  threadId: string;
  runId: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface AgUiServerSink {
  writeEvent: (event: AgUiEventPayload) => void;
  close: () => void;
}

/**
 * Handles incoming AG-UI protocol requests and forwards them to the AgentCoordinator
 */
export async function handleAgUiRunRequest(
  request: AgUiRunRequest,
  coordinator: AgentCoordinator,
  sink: AgUiServerSink
): Promise<{ finalResponse: string; runId: string }> {
  const threadId = request.threadId || `thread_${Date.now()}`;
  const runId = request.runId || `run_${Date.now()}`;

  // Emit RUN_STARTED
  sink.writeEvent({
    event: 'RUN_STARTED',
    threadId,
    runId,
    data: { agentId: request.agentId, state: request.state },
    timestamp: Date.now(),
  });

  // Extract latest user message
  const userMessages = request.messages.filter((m) => m.role === 'user');
  const latestMessage = userMessages[userMessages.length - 1];
  const query = latestMessage ? latestMessage.content : '';

  if (!query) {
    sink.writeEvent({
      event: 'RUN_FINISHED',
      threadId,
      runId,
      data: { status: 'completed', message: 'No user query provided.' },
      timestamp: Date.now(),
    });
    sink.close();
    return { finalResponse: '', runId };
  }

  // Hook coordinator event listener for AG-UI event translation
  const unsubscribe = coordinator.addEventListener((event: TurnEvent) => {
    if (event.type === 'text_delta') {
      sink.writeEvent({
        event: 'TEXT_MESSAGE_CHUNK',
        threadId,
        runId,
        data: { delta: event.text },
        timestamp: Date.now(),
      });
    } else if (event.type === 'tool_call_started') {
      sink.writeEvent({
        event: 'TOOL_CALL_START',
        threadId,
        runId,
        data: {
          toolCallId: event.toolCall.id,
          name: event.toolCall.function.name,
          arguments: event.toolCall.function.arguments,
        },
        timestamp: Date.now(),
      });
    } else if (event.type === 'tool_call_completed') {
      sink.writeEvent({
        event: 'TOOL_CALL_RESULT',
        threadId,
        runId,
        data: {
          toolCallId: event.toolCall.id,
          name: event.toolCall.function.name,
          result: event.result.output,
        },
        timestamp: Date.now(),
      });
    } else if (event.type === 'error') {
      sink.writeEvent({
        event: 'RUN_ERROR',
        threadId,
        runId,
        data: { error: event.error.message },
        timestamp: Date.now(),
      });
    }
  });

  try {
    const finalResponse = await coordinator.runTurn(query);

    sink.writeEvent({
      event: 'RUN_FINISHED',
      threadId,
      runId,
      data: {
        status: 'completed',
        finalResponse,
      },
      timestamp: Date.now(),
    });

    return { finalResponse, runId };
  } catch (err: any) {
    sink.writeEvent({
      event: 'RUN_ERROR',
      threadId,
      runId,
      data: { error: err.message || String(err) },
      timestamp: Date.now(),
    });
    throw err;
  } finally {
    unsubscribe();
    sink.close();
  }
}

/**
 * Client to consume external AG-UI agent endpoints (e.g. LangGraph or Mastra instances)
 */
export class RemoteAgUiClient extends EventEmitter {
  private endpointUrl: string;
  private authToken?: string;

  constructor(endpointUrl: string, authToken?: string) {
    super();
    this.endpointUrl = endpointUrl.replace(/\/+$/, '');
    this.authToken = authToken;
  }

  public async run(
    request: AgUiRunRequest,
    fetchFn: typeof fetch = globalThis.fetch
  ): Promise<{ finalResponse: string; runId: string }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    const res = await fetchFn(`${this.endpointUrl}/ag-ui/v1/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      throw new Error(`Remote AG-UI agent responded with HTTP ${res.status}: ${res.statusText}`);
    }

    const contentType = res.headers.get('content-type') || '';

    // If server responded with JSON directly
    if (contentType.includes('application/json')) {
      const data = await res.json();
      return {
        finalResponse: data.finalResponse || data.content || '',
        runId: data.runId || request.runId || 'run_remote',
      };
    }

    // Process SSE stream
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Remote AG-UI agent returned empty response stream');
    }

    const decoder = new TextDecoder();
    let finalResponse = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payloadStr = line.replace(/^data:\s*/, '').trim();
        if (!payloadStr || payloadStr === '[DONE]') continue;

        try {
          const eventPayload: AgUiEventPayload = JSON.parse(payloadStr);
          this.emit('event', eventPayload);

          if (eventPayload.event === 'TEXT_MESSAGE_CHUNK' && eventPayload.data?.delta) {
            finalResponse += eventPayload.data.delta;
          } else if (eventPayload.event === 'RUN_FINISHED' && eventPayload.data?.finalResponse) {
            finalResponse = eventPayload.data.finalResponse as string;
          }
        } catch {
          // Ignore malformed SSE chunks
        }
      }
    }

    return {
      finalResponse,
      runId: request.runId || 'run_remote',
    };
  }
}
