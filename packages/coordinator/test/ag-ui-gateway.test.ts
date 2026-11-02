import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  handleAgUiRunRequest,
  RemoteAgUiClient,
  AgUiEventPayload,
  AgUiRunRequest,
} from '../src/ag-ui-gateway.js';

describe('AgUiGateway - Universal AG-UI Protocol Compatibility', () => {
  it('handles incoming AG-UI run request and streams standard AG-UI events', async () => {
    const emittedEvents: AgUiEventPayload[] = [];
    let isClosed = false;

    const mockSink = {
      writeEvent: (ev: AgUiEventPayload) => emittedEvents.push(ev),
      close: () => { isClosed = true; },
    };

    // Create minimal mock coordinator
    const mockCoordinator: any = {
      listeners: new Set(),
      addEventListener(cb: any) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
      async runTurn(query: string) {
        for (const l of this.listeners) {
          l({ type: 'text_delta', text: 'Hello ' });
          l({ type: 'text_delta', text: 'from AG-UI!' });
        }
        return 'Hello from AG-UI!';
      },
    };

    const request: AgUiRunRequest = {
      threadId: 'thread_123',
      messages: [
        { role: 'user', content: 'Say hello' },
      ],
    };

    const result = await handleAgUiRunRequest(request, mockCoordinator, mockSink);

    assert.strictEqual(result.finalResponse, 'Hello from AG-UI!');
    assert.strictEqual(isClosed, true);

    const eventNames = emittedEvents.map((e) => e.event);
    assert.ok(eventNames.includes('RUN_STARTED'));
    assert.ok(eventNames.includes('TEXT_MESSAGE_CHUNK'));
    assert.ok(eventNames.includes('RUN_FINISHED'));

    const chunks = emittedEvents.filter((e) => e.event === 'TEXT_MESSAGE_CHUNK');
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].data.delta, 'Hello ');
    assert.strictEqual(chunks[1].data.delta, 'from AG-UI!');
  });

  it('RemoteAgUiClient dispatches request to external AG-UI server and parses SSE stream', async () => {
    const client = new RemoteAgUiClient('http://127.0.0.1:8000', 'test-token');
    const receivedEvents: AgUiEventPayload[] = [];
    client.on('event', (ev) => receivedEvents.push(ev));

    const sseChunks = [
      `data: ${JSON.stringify({ event: 'RUN_STARTED', threadId: 't1', runId: 'r1', data: {}, timestamp: Date.now() })}\n\n`,
      `data: ${JSON.stringify({ event: 'TEXT_MESSAGE_CHUNK', threadId: 't1', runId: 'r1', data: { delta: 'External ' }, timestamp: Date.now() })}\n\n`,
      `data: ${JSON.stringify({ event: 'TEXT_MESSAGE_CHUNK', threadId: 't1', runId: 'r1', data: { delta: 'LangGraph agent' }, timestamp: Date.now() })}\n\n`,
      `data: ${JSON.stringify({ event: 'RUN_FINISHED', threadId: 't1', runId: 'r1', data: { finalResponse: 'External LangGraph agent' }, timestamp: Date.now() })}\n\n`,
    ];

    let chunkIdx = 0;
    const mockStream = new ReadableStream({
      pull(controller) {
        if (chunkIdx < sseChunks.length) {
          controller.enqueue(new TextEncoder().encode(sseChunks[chunkIdx++]));
        } else {
          controller.close();
        }
      },
    });

    const mockFetch: any = async (url: string, init: any) => {
      assert.ok(url.includes('/ag-ui/v1/run'));
      assert.strictEqual(init.headers.Authorization, 'Bearer test-token');
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: mockStream,
      };
    };

    const res = await client.run({
      threadId: 't1',
      messages: [{ role: 'user', content: 'Delegate to external agent' }],
    }, mockFetch);

    assert.strictEqual(res.finalResponse, 'External LangGraph agent');
    assert.strictEqual(receivedEvents.length, 4);
    assert.strictEqual(receivedEvents[0].event, 'RUN_STARTED');
    assert.strictEqual(receivedEvents[3].event, 'RUN_FINISHED');
  });
});
