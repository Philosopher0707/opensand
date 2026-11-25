import test from "node:test";
import assert from "node:assert";
import {
  GRAPH_EMPTY_STATE,
  GRAPH_ERROR_TITLE,
  GRAPH_RUNNING_MESSAGE,
  GRAPH_RUN_TASK,
  GRAPH_TRACE_EMPTY_STATE,
  canRunGraph,
  graphCardView,
  graphEventView,
  graphFinalSummary,
} from "../src/shell/graphs-model.js";

test("graphs-model: run is gated by an in-flight run and a graph id", () => {
  assert.strictEqual(canRunGraph(false, "g-1"), true);
  assert.strictEqual(canRunGraph(true, "g-1"), false);
  assert.strictEqual(canRunGraph(false, ""), false);
  assert.strictEqual(canRunGraph(false, undefined), false);
});

test("graphs-model: card applies node badges and cycle default", () => {
  assert.deepStrictEqual(graphCardView({ id: "g-1" }), {
    id: "g-1",
    title: "g-1",
    description: "No description.",
    cycleLabel: "Cycle Limit: 3",
    nodes: [],
  });
  assert.deepStrictEqual(graphCardView({ id: "g-2", name: " Coding ", description: " Loops ", cycleLimit: 7, nodes: ["plan", "code"] }), {
    id: "g-2",
    title: "Coding",
    description: "Loops",
    cycleLabel: "Cycle Limit: 7",
    nodes: ["plan", "code"],
  });
});

test("graphs-model: trace events map type to tone, title and details", () => {
  const event = graphEventView({ type: "cycle_detected", node: "review", step: 4, timestamp: 0, details: { retry: 2 } });
  assert.strictEqual(event.className, "graph-item fail");
  assert.strictEqual(event.statusClass, "graph-status fail");
  assert.strictEqual(event.statusLabel, "CYCLE_DETECTED");
  assert.strictEqual(event.title, "Node: review");
  assert.strictEqual(event.stepLabel, "(Step 4)");
  assert.ok(event.details.includes('"retry": 2'));

  assert.strictEqual(graphEventView({ type: "graph_complete", edge: "code->verify" }).className, "graph-item clean");
  assert.strictEqual(graphEventView({ type: "state_enter" }).title, "State Transition");
  assert.strictEqual(graphEventView({ type: "state_enter" }).statusLabel, "STATE_ENTER");
  assert.strictEqual(graphEventView({ type: "state_enter" }).details, "");
});

test("graphs-model: final summary and copy constants", () => {
  assert.strictEqual(graphFinalSummary({ finalState: { finalSummary: "done" } }), "done");
  assert.strictEqual(graphFinalSummary({}), "");
  assert.ok(GRAPH_EMPTY_STATE.includes("No agent graphs"));
  assert.ok(GRAPH_TRACE_EMPTY_STATE.includes("Run a graph"));
  assert.ok(GRAPH_RUNNING_MESSAGE.includes("Starting"));
  assert.ok(GRAPH_ERROR_TITLE.includes("Failure"));
  assert.ok(GRAPH_RUN_TASK.includes("self-repair"));
});
