// Agent Graphs view (Phase 5 Row 22).
// Replaces the #viewGraphs stub with the graph grid and a lifecycle-aware execution trace.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, AgentGraph, GraphTraceEvent } from "../data";
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
} from "../../../src/shell/graphs-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface GraphsViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function GraphsView({ data, active, onSelect, refreshKey }: GraphsViewProps) {
  const [graphs, setGraphs] = useState<AgentGraph[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [trace, setTrace] = useState<GraphTraceEvent[]>([]);
  const [summary, setSummary] = useState("");
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await data.getGraphs();
        if (cancelled) return;
        setGraphs(Array.isArray(list) ? list : []);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, refreshKey]);

  const reload = async () => {
    try {
      setLoading(true);
      const list = await data.getGraphs();
      setGraphs(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRun = async (graph: AgentGraph) => {
    if (!canRunGraph(runningId !== null, graph.id)) return;
    setRunningId(graph.id);
    setTrace([]);
    setSummary("");
    setRunError(null);
    try {
      const result = await data.runGraph(graph.id, GRAPH_RUN_TASK);
      setTrace(Array.isArray(result?.trace) ? result.trace : []);
      setSummary(graphFinalSummary(result));
    } catch (err) {
      setRunError(errorMessage(err));
    } finally {
      setRunningId(null);
    }
  };

  const group = NAV_GROUPS.find((nav) => nav.tabs.some((tab) => tab.view === "graphs"));

  return (
    <div id={viewPanelId("graphs")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container graphs-view-container">
        {group && (
          <nav class="subnav-tabs" data-group={group.id} aria-label={`${group.buttonLabel} views`}>
            {group.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "graphs" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "graphs" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">🕸️ Agent Graphs &amp; Cyclical Loops</div>
            <div class="dashboard-subtitle">
              Run state graphs that loop back through their nodes until verification or a cycle limit.
            </div>
          </div>
          <button id="btnRefreshGraphs" type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>
            Refresh
          </button>
        </div>

        {loadError && (
          <div class="graphs-error" role="alert">
            <span>Could not load graphs: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="card-grid" id="graphsCardGrid">
          {loading ? (
            <div class="graphs-loading">Loading graphs…</div>
          ) : graphs.length === 0 ? (
            <div class="graphs-empty">{GRAPH_EMPTY_STATE}</div>
          ) : (
            graphs.map((graph) => {
              const card = graphCardView(graph);
              return (
                <div class="dashboard-card" key={graph.id}>
                  <div class="card-top">
                    <div class="card-title">{card.title}</div>
                    <span class="badge badge-success">{card.cycleLabel}</span>
                  </div>
                  <div class="card-desc">{card.description}</div>
                  <div class="card-meta graphs-nodes">
                    {card.nodes.map((node, index) => (
                      <span class="badge graph-node-badge" key={`${node}-${index}`}>{node}</span>
                    ))}
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-primary btn-xs btn-run-single-graph"
                      disabled={!canRunGraph(runningId !== null, graph.id)}
                      onClick={() => void handleRun(graph)}
                    >
                      {runningId === graph.id ? "Running…" : "▶ Run Graph"}
                    </button>
                    <button
                      type="button"
                      class="btn btn-primary btn-xs btn-run-coding-graph"
                      data-graph-id="self_reflecting_coding"
                      disabled={runningId !== null}
                      onClick={() =>
                        void handleRun({ id: "self_reflecting_coding", name: "Autonomous Self-Reflecting Coding Graph" })
                      }
                    >
                      Run Coding Graph
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <h3 class="graphs-section-title">Execution Trace</h3>
        <div class="graphs-feed" id="graphTraceFeed">
          {runningId && (
            <div class="graph-item clean" role="status">
              <div class="graph-header-row">
                <div><span class="graph-status warn">RUNNING</span><strong class="graph-trigger">{runningId}</strong></div>
                <span class="graph-time">{GRAPH_RUNNING_MESSAGE}</span>
              </div>
            </div>
          )}
          {runError && (
            <div class="graph-item fail" role="alert">
              <div class="graph-header-row">
                <div><span class="graph-status fail">ERROR</span><strong class="graph-trigger">{GRAPH_ERROR_TITLE}</strong></div>
              </div>
              <div class="graph-output-box">{runError}</div>
            </div>
          )}
          {!runningId && !runError && trace.length === 0 && (
            <div class="graphs-empty">{GRAPH_TRACE_EMPTY_STATE}</div>
          )}
          {trace.map((event, index) => {
            const view = graphEventView(event);
            return (
              <div class={view.className} key={`${view.statusLabel}-${index}`}>
                <div class="graph-header-row">
                  <div>
                    <span class={view.statusClass}>{view.statusLabel}</span>
                    <strong class="graph-trigger">{view.title}</strong>
                    {view.stepLabel && <span class="graphs-step">{view.stepLabel}</span>}
                  </div>
                  <span class="graph-time">{view.time}</span>
                </div>
                {view.details && <pre class="graph-output-box">{view.details}</pre>}
              </div>
            );
          })}
          {summary && (
            <div class="graph-item clean">
              <div class="graph-header-row">
                <div><span class="graph-status clean">SUMMARY</span><strong class="graph-trigger">Final Output &amp; Verification</strong></div>
              </div>
              <div class="graph-proposal-box">{summary}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
