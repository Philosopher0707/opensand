/**
 * OpenSand Agent Graph & Cyclical Node Loop Engine
 * Declarative state graph orchestrator enabling cyclical reasoning,
 * self-reflection, multi-node loops, and state checkpointing.
 */

export const START = '__START__';
export const END = '__END__';

export interface GraphContext {
  step: number;
  maxIterations: number;
  metadata?: Record<string, unknown>;
  emitEvent?: (event: GraphEvent<any>) => void;
}

export type GraphNodeHandler<TState> = (
  state: TState,
  context: GraphContext
) => Promise<Partial<TState> | void> | Partial<TState> | void;

export type ConditionalEdgeRouter<TState> = (
  state: TState,
  context: GraphContext
) => Promise<string> | string;

export interface StateSnapshot<TState> {
  step: number;
  node: string;
  state: TState;
  timestamp: number;
  durationMs: number;
}

export interface GraphCompileOptions {
  maxIterations?: number;
  onCheckpoint?: <TState>(snapshot: StateSnapshot<TState>) => void;
}

export interface GraphRunOptions {
  maxIterations?: number;
  metadata?: Record<string, unknown>;
}

export type GraphEventType =
  | 'node_start'
  | 'node_end'
  | 'edge_traversed'
  | 'checkpoint'
  | 'cycle_detected'
  | 'graph_complete'
  | 'graph_error';

export interface GraphEvent<TState> {
  type: GraphEventType;
  step: number;
  node?: string;
  targetNode?: string;
  state?: Partial<TState>;
  error?: string;
  timestamp: number;
}

export interface GraphRunResult<TState> {
  finalState: TState;
  totalSteps: number;
  history: StateSnapshot<TState>[];
  completed: boolean;
  error?: string;
}

/**
 * Declarative State Graph definition
 */
export class StateGraph<TState extends Record<string, unknown>> {
  private nodes: Map<string, GraphNodeHandler<TState>> = new Map();
  private edges: Map<string, string> = new Map();
  private conditionalEdges: Map<string, {
    router: ConditionalEdgeRouter<TState>;
    routeMap?: Record<string, string>;
  }> = new Map();
  private entryPoint: string | null = null;

  public addNode(name: string, handler: GraphNodeHandler<TState>): this {
    if (name === START || name === END) {
      throw new Error(`Cannot register reserved node name: "${name}"`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`Node "${name}" is already registered`);
    }
    this.nodes.set(name, handler);
    return this;
  }

  public addEdge(from: string, to: string): this {
    if (from !== START && !this.nodes.has(from)) {
      throw new Error(`Source node "${from}" is not registered in graph`);
    }
    if (to !== END && !this.nodes.has(to)) {
      throw new Error(`Target node "${to}" is not registered in graph`);
    }
    this.edges.set(from, to);
    return this;
  }

  public addConditionalEdges(
    from: string,
    router: ConditionalEdgeRouter<TState>,
    routeMap?: Record<string, string>
  ): this {
    if (from !== START && !this.nodes.has(from)) {
      throw new Error(`Source node "${from}" is not registered in graph`);
    }
    this.conditionalEdges.set(from, { router, routeMap });
    return this;
  }

  public setEntryPoint(name: string): this {
    if (!this.nodes.has(name)) {
      throw new Error(`Entry point node "${name}" does not exist in graph`);
    }
    this.entryPoint = name;
    this.edges.set(START, name);
    return this;
  }

  public getNodes(): string[] {
    return Array.from(this.nodes.keys());
  }

  public compile(options: GraphCompileOptions = {}): CompiledGraph<TState> {
    if (!this.entryPoint && !this.edges.has(START)) {
      throw new Error('Graph must have an entry point defined before compilation (use setEntryPoint)');
    }
    return new CompiledGraph<TState>({
      nodes: new Map(this.nodes),
      edges: new Map(this.edges),
      conditionalEdges: new Map(this.conditionalEdges),
      entryPoint: this.entryPoint || this.edges.get(START)!,
      defaultMaxIterations: options.maxIterations || 150,
      onCheckpoint: options.onCheckpoint,
    });
  }
}

/**
 * Compiled executable state graph
 */
export class CompiledGraph<TState extends Record<string, unknown>> {
  private nodes: Map<string, GraphNodeHandler<TState>>;
  private edges: Map<string, string>;
  private conditionalEdges: Map<string, {
    router: ConditionalEdgeRouter<TState>;
    routeMap?: Record<string, string>;
  }>;
  private entryPoint: string;
  private defaultMaxIterations: number;
  private onCheckpoint?: <TState>(snapshot: StateSnapshot<TState>) => void;

  constructor(config: {
    nodes: Map<string, GraphNodeHandler<TState>>;
    edges: Map<string, string>;
    conditionalEdges: Map<string, {
      router: ConditionalEdgeRouter<TState>;
      routeMap?: Record<string, string>;
    }>;
    entryPoint: string;
    defaultMaxIterations: number;
    onCheckpoint?: <TState>(snapshot: StateSnapshot<TState>) => void;
  }) {
    this.nodes = config.nodes;
    this.edges = config.edges;
    this.conditionalEdges = config.conditionalEdges;
    this.entryPoint = config.entryPoint;
    this.defaultMaxIterations = config.defaultMaxIterations;
    this.onCheckpoint = config.onCheckpoint;
  }

  public async invoke(
    initialState: TState,
    options: GraphRunOptions = {}
  ): Promise<GraphRunResult<TState>> {
    const events: GraphEvent<TState>[] = [];
    return this.execute(initialState, options, (event) => events.push(event));
  }

  public async stream(
    initialState: TState,
    onEvent: (event: GraphEvent<TState>) => void,
    options: GraphRunOptions = {}
  ): Promise<GraphRunResult<TState>> {
    return this.execute(initialState, options, onEvent);
  }

  private async execute(
    initialState: TState,
    options: GraphRunOptions,
    emitEvent: (event: GraphEvent<TState>) => void
  ): Promise<GraphRunResult<TState>> {
    let currentState: TState = { ...initialState };
    let currentNode: string = this.entryPoint;
    let step = 0;
    const maxIterations = options.maxIterations || this.defaultMaxIterations;
    const history: StateSnapshot<TState>[] = [];

    const context: GraphContext = {
      step: 0,
      maxIterations,
      metadata: options.metadata,
      emitEvent,
    };

    while (currentNode !== END && step < maxIterations) {
      step++;
      context.step = step;

      const handler = this.nodes.get(currentNode);
      if (!handler) {
        const errorMsg = `Node handler for "${currentNode}" not found during graph execution`;
        emitEvent({
          type: 'graph_error',
          step,
          node: currentNode,
          error: errorMsg,
          timestamp: Date.now(),
        });
        return {
          finalState: currentState,
          totalSteps: step,
          history,
          completed: false,
          error: errorMsg,
        };
      }

      emitEvent({
        type: 'node_start',
        step,
        node: currentNode,
        state: currentState,
        timestamp: Date.now(),
      });

      const startTime = Date.now();
      let updates: Partial<TState> | void;

      try {
        updates = await handler(currentState, context);
      } catch (err: any) {
        const errorMsg = `Error in node "${currentNode}": ${err.message || String(err)}`;
        emitEvent({
          type: 'graph_error',
          step,
          node: currentNode,
          error: errorMsg,
          timestamp: Date.now(),
        });
        return {
          finalState: currentState,
          totalSteps: step,
          history,
          completed: false,
          error: errorMsg,
        };
      }

      const durationMs = Date.now() - startTime;

      if (updates && typeof updates === 'object') {
        currentState = { ...currentState, ...updates };
      }

      const snapshot: StateSnapshot<TState> = {
        step,
        node: currentNode,
        state: { ...currentState },
        timestamp: Date.now(),
        durationMs,
      };

      history.push(snapshot);
      if (this.onCheckpoint) {
        this.onCheckpoint(snapshot);
      }

      emitEvent({
        type: 'node_end',
        step,
        node: currentNode,
        state: currentState,
        timestamp: Date.now(),
      });

      emitEvent({
        type: 'checkpoint',
        step,
        node: currentNode,
        state: currentState,
        timestamp: Date.now(),
      });

      // Resolve Next Node: Check Conditional Edges first, then Direct Edges
      let nextNode: string | null = null;

      if (this.conditionalEdges.has(currentNode)) {
        const cond = this.conditionalEdges.get(currentNode)!;
        let routeKey: string;
        try {
          routeKey = await cond.router(currentState, context);
        } catch (err: any) {
          const errorMsg = `Router error in conditional edge from "${currentNode}": ${err.message}`;
          emitEvent({
            type: 'graph_error',
            step,
            node: currentNode,
            error: errorMsg,
            timestamp: Date.now(),
          });
          return {
            finalState: currentState,
            totalSteps: step,
            history,
            completed: false,
            error: errorMsg,
          };
        }

        if (cond.routeMap && cond.routeMap[routeKey]) {
          nextNode = cond.routeMap[routeKey];
        } else {
          nextNode = routeKey;
        }
      } else if (this.edges.has(currentNode)) {
        nextNode = this.edges.get(currentNode)!;
      } else {
        // No outgoing edges defined; implicitly transition to END
        nextNode = END;
      }

      emitEvent({
        type: 'edge_traversed',
        step,
        node: currentNode,
        targetNode: nextNode,
        timestamp: Date.now(),
      });

      currentNode = nextNode;
    }

    const completed = currentNode === END;
    let error: string | undefined;

    if (!completed && step >= maxIterations) {
      error = `Graph exceeded maximum iteration limit of ${maxIterations} steps without terminating`;
      emitEvent({
        type: 'cycle_detected',
        step,
        node: currentNode,
        error,
        timestamp: Date.now(),
      });
    }

    emitEvent({
      type: 'graph_complete',
      step,
      state: currentState,
      timestamp: Date.now(),
    });

    return {
      finalState: currentState,
      totalSteps: step,
      history,
      completed,
      error,
    };
  }
}

/**
 * Pre-configured Autonomous Self-Reflective Coding Graph:
 * Spec Planner -> Coder -> Test Auditor -> (Cycle on Failure) -> Reviewer -> END
 */
export interface CodingGraphState extends Record<string, unknown> {
  task: string;
  plan?: string[];
  codeFiles?: Record<string, string>;
  testOutput?: string;
  testsPassed?: boolean;
  iterationCount: number;
  maxRepairs: number;
  finalSummary?: string;
}

export function createSelfReflectiveCodingGraph(options: {
  planFn: (task: string) => Promise<string[]>;
  codeFn: (task: string, plan: string[], failureReason?: string) => Promise<Record<string, string>>;
  testFn: (codeFiles: Record<string, string>) => Promise<{ passed: boolean; output: string }>;
  reviewFn: (task: string, codeFiles: Record<string, string>, testsPassed: boolean) => Promise<string>;
  maxRepairs?: number;
}): CompiledGraph<CodingGraphState> {
  const graph = new StateGraph<CodingGraphState>();

  // 1. Planner Node
  graph.addNode('planner', async (state) => {
    const plan = await options.planFn(state.task);
    return { plan, iterationCount: 0, maxRepairs: options.maxRepairs || 3 };
  });

  // 2. Coder Node
  graph.addNode('coder', async (state) => {
    const failureReason = state.testOutput && !state.testsPassed ? state.testOutput : undefined;
    const codeFiles = await options.codeFn(state.task, state.plan || [], failureReason);
    return {
      codeFiles: { ...(state.codeFiles || {}), ...codeFiles },
      iterationCount: (state.iterationCount || 0) + 1,
    };
  });

  // 3. Test Runner Node
  graph.addNode('tester', async (state) => {
    const result = await options.testFn(state.codeFiles || {});
    return {
      testsPassed: result.passed,
      testOutput: result.output,
    };
  });

  // 4. Reviewer Node
  graph.addNode('reviewer', async (state) => {
    const summary = await options.reviewFn(state.task, state.codeFiles || {}, !!state.testsPassed);
    return { finalSummary: summary };
  });

  // Wire Edges
  graph.setEntryPoint('planner');
  graph.addEdge('planner', 'coder');
  graph.addEdge('coder', 'tester');

  // Conditional Edge: If tests pass OR iteration count >= maxRepairs -> reviewer; else -> coder
  graph.addConditionalEdges('tester', (state) => {
    if (state.testsPassed) {
      return 'reviewer';
    }
    if ((state.iterationCount || 0) >= (state.maxRepairs || 3)) {
      return 'reviewer'; // Cap reached, proceed to review with failure notes
    }
    return 'coder'; // Loop back to coder with failure trace!
  });

  graph.addEdge('reviewer', END);

  return graph.compile();
}
