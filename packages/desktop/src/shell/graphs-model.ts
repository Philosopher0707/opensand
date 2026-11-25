// Pure model for the Agent Graphs view (Phase 5 Row 22).
// Mirrors the legacy renderer/app.js graph controller without DOM or bridge code.

export interface AgentGraph {
  id: string;
  name?: string;
  description?: string;
  nodes?: string[];
  cycleLimit?: number;
  [key: string]: unknown;
}

export interface GraphTraceEvent {
  type: string;
  node?: string;
  edge?: string;
  step?: number;
  timestamp?: number;
  details?: unknown;
  [key: string]: unknown;
}

export interface GraphRunResult {
  trace?: GraphTraceEvent[];
  finalState?: { finalSummary?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface GraphCardView {
  id: string;
  title: string;
  description: string;
  cycleLabel: string;
  nodes: string[];
}

export interface GraphEventView {
  className: string;
  statusClass: string;
  statusLabel: string;
  title: string;
  stepLabel: string;
  time: string;
  details: string;
}

export const GRAPH_EMPTY_STATE = "No agent graphs registered.";
export const GRAPH_TRACE_EMPTY_STATE = "Run a graph to see its state transitions.";
export const GRAPH_RUN_TASK = "Implement robust error-bounded worker queue with self-repair";
export const GRAPH_RUNNING_MESSAGE = "Starting cyclical state graph execution...";
export const GRAPH_ERROR_TITLE = "Execution Failure";

/** The legacy run button has no task input; the only gate is a run already in flight. */
export function canRunGraph(running: boolean, graphId?: string): boolean {
  return !running && Boolean(graphId);
}

export function graphCardView(graph: AgentGraph): GraphCardView {
  return {
    id: graph.id,
    title: graph.name?.trim() || graph.id || "Untitled graph",
    description: graph.description?.trim() || "No description.",
    cycleLabel: `Cycle Limit: ${graph.cycleLimit || 3}`,
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
  };
}

export function graphEventView(event: GraphTraceEvent): GraphEventView {
  const isError = event.type === "cycle_detected" || event.type === "graph_error";
  const isComplete = event.type === "graph_complete";
  const tone = isError ? "fail" : isComplete ? "clean" : "warn";
  const details = event.details
    ? typeof event.details === "object"
      ? JSON.stringify(event.details, null, 2)
      : String(event.details)
    : "";
  return {
    className: `graph-item ${tone}`,
    statusClass: `graph-status ${tone}`,
    statusLabel: String(event.type || "state_transition").toUpperCase(),
    title: event.node ? `Node: ${event.node}` : event.edge ? `Edge: ${event.edge}` : "State Transition",
    stepLabel: event.step ? `(Step ${event.step})` : "",
    time: new Date(event.timestamp || Date.now()).toLocaleTimeString(),
    details,
  };
}

export function graphFinalSummary(result: GraphRunResult): string {
  return result.finalState?.finalSummary || "";
}
