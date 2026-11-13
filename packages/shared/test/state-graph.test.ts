import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  StateGraph,
  START,
  END,
  createSelfReflectiveCodingGraph,
  GraphEvent,
} from '../src/state-graph.js';

describe('AgentGraphEngine', () => {
  it('executes a linear multi-node state graph', async () => {
    interface TestState extends Record<string, unknown> {
      value: number;
      log: string[];
    }

    const graph = new StateGraph<TestState>();

    graph.addNode('step1', (state) => ({
      value: state.value + 10,
      log: [...state.log, 'ran step1'],
    }));

    graph.addNode('step2', (state) => ({
      value: state.value * 2,
      log: [...state.log, 'ran step2'],
    }));

    graph.setEntryPoint('step1');
    graph.addEdge('step1', 'step2');
    graph.addEdge('step2', END);

    const compiled = graph.compile();
    const result = await compiled.invoke({ value: 5, log: [] });

    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.finalState.value, 30); // (5 + 10) * 2 = 30
    assert.deepStrictEqual(result.finalState.log, ['ran step1', 'ran step2']);
    assert.strictEqual(result.totalSteps, 2);
    assert.strictEqual(result.history.length, 2);
  });

  it('evaluates conditional edges and routes dynamically', async () => {
    interface RouteState extends Record<string, unknown> {
      action: 'code' | 'review' | 'finish';
      path: string[];
    }

    const graph = new StateGraph<RouteState>();

    graph.addNode('routerNode', (state) => ({
      path: [...state.path, 'router'],
    }));

    graph.addNode('codeNode', (state) => ({
      path: [...state.path, 'code'],
    }));

    graph.addNode('reviewNode', (state) => ({
      path: [...state.path, 'review'],
    }));

    graph.setEntryPoint('routerNode');

    graph.addConditionalEdges('routerNode', (state) => {
      if (state.action === 'code') return 'codeNode';
      if (state.action === 'review') return 'reviewNode';
      return END;
    });

    graph.addEdge('codeNode', END);
    graph.addEdge('reviewNode', END);

    const compiled = graph.compile();

    const result1 = await compiled.invoke({ action: 'code', path: [] });
    assert.deepStrictEqual(result1.finalState.path, ['router', 'code']);

    const result2 = await compiled.invoke({ action: 'review', path: [] });
    assert.deepStrictEqual(result2.finalState.path, ['router', 'review']);

    const result3 = await compiled.invoke({ action: 'finish', path: [] });
    assert.deepStrictEqual(result3.finalState.path, ['router']);
  });

  it('executes cyclical self-reflection loops until success condition is met', async () => {
    interface LoopState extends Record<string, unknown> {
      count: number;
      converged: boolean;
    }

    const graph = new StateGraph<LoopState>();

    graph.addNode('increment', (state) => {
      const next = state.count + 1;
      return {
        count: next,
        converged: next >= 4,
      };
    });

    graph.setEntryPoint('increment');
    graph.addConditionalEdges('increment', (state) => {
      return state.converged ? END : 'increment';
    });

    const compiled = graph.compile({ maxIterations: 10 });
    const result = await compiled.invoke({ count: 0, converged: false });

    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.finalState.count, 4);
    assert.strictEqual(result.totalSteps, 4);
  });

  it('enforces circuit-breaker safety when cycles exceed maxIterations', async () => {
    interface InfiniteState extends Record<string, unknown> {
      ticks: number;
    }

    const graph = new StateGraph<InfiniteState>();
    graph.addNode('spin', (state) => ({ ticks: state.ticks + 1 }));
    graph.setEntryPoint('spin');
    graph.addEdge('spin', 'spin'); // Infinite loop

    const compiled = graph.compile({ maxIterations: 5 });
    const result = await compiled.invoke({ ticks: 0 });

    assert.strictEqual(result.completed, false);
    assert.strictEqual(result.totalSteps, 5);
    assert.ok(result.error?.includes('exceeded maximum iteration limit of 5 steps'));
  });

  it('streams granular graph events during execution', async () => {
    interface EventState extends Record<string, unknown> {
      step: number;
    }

    const graph = new StateGraph<EventState>();
    graph.addNode('nodeA', (s) => ({ step: s.step + 1 }));
    graph.addNode('nodeB', (s) => ({ step: s.step + 1 }));
    graph.setEntryPoint('nodeA');
    graph.addEdge('nodeA', 'nodeB');
    graph.addEdge('nodeB', END);

    const compiled = graph.compile();
    const events: GraphEvent<EventState>[] = [];

    const result = await compiled.stream({ step: 0 }, (ev) => events.push(ev));

    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.finalState.step, 2);

    const types = events.map((e) => e.type);
    assert.ok(types.includes('node_start'));
    assert.ok(types.includes('node_end'));
    assert.ok(types.includes('edge_traversed'));
    assert.ok(types.includes('checkpoint'));
    assert.ok(types.includes('graph_complete'));
  });

  it('runs pre-configured Self-Reflective Coding Graph with repair cycle', async () => {
    let testAttempts = 0;

    const codingGraph = createSelfReflectiveCodingGraph({
      planFn: async (task) => [`Plan item for ${task}`],
      codeFn: async (task, plan, failureReason) => {
        if (failureReason) {
          return { 'main.ts': 'export const answer = 42; // Fixed bug' };
        }
        return { 'main.ts': 'export const answer = 0; // Initial bug' };
      },
      testFn: async (codeFiles) => {
        testAttempts++;
        if (codeFiles['main.ts']?.includes('42')) {
          return { passed: true, output: '1 test passed' };
        }
        return { passed: false, output: 'AssertionError: expected 42 got 0' };
      },
      reviewFn: async (task, codeFiles, testsPassed) => {
        return `Review complete for ${task}. Status: ${testsPassed ? 'PASSED' : 'FAILED'}`;
      },
      maxRepairs: 3,
    });

    const result = await codingGraph.invoke({
      task: 'Fix calculation in main.ts',
      iterationCount: 0,
      maxRepairs: 3,
    });

    assert.strictEqual(result.completed, true);
    assert.strictEqual(result.finalState.testsPassed, true);
    assert.strictEqual(testAttempts, 2); // First failed, second passed after self-repair!
    assert.ok(result.finalState.codeFiles?.['main.ts']?.includes('Fixed bug'));
    assert.ok(result.finalState.finalSummary?.includes('PASSED'));
  });
});
