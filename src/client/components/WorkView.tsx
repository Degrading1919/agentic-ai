import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CirclePause,
  Clock3,
  Cpu,
  FileText,
  Gauge,
  HardDrive,
  LoaderCircle,
  MemoryStick,
  Network,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type { Run, RuntimeSnapshot, Topology, WorkOrder } from "../../shared/contracts.js";
import { entryAgents } from "../../shared/topology.js";
import { api } from "../api.js";

type Props = {
  topology: Topology;
  runs: Run[];
  runtime: RuntimeSnapshot | null;
  onRunChanged: (run: Run) => void;
  notify: (tone: "success" | "error" | "info", message: string) => void;
};

function shortTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function elapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function agentName(topology: Topology, id: string): string {
  return topology.nodes.find((node) => node.id === id)?.name ?? id;
}

function StatusIcon({ status }: { status: WorkOrder["status"] }) {
  if (status === "completed") return <Check size={13} />;
  if (status === "running") return <LoaderCircle className="spin" size={13} />;
  if (status === "waiting") return <Clock3 size={13} />;
  if (status === "failed" || status === "blocked") return <X size={13} />;
  return <CirclePause size={13} />;
}

function WorkOrderRail({ run, topology }: { run: Run; topology: Topology }) {
  return (
    <section className="work-order-rail">
      <div className="section-kicker"><Workflow size={13} /> Structured work orders</div>
      <div className="order-grid">
        {run.workOrders.map((order) => (
          <article className={`order-card ${order.status}`} key={order.id}>
            <div className="order-card-topline">
              <span className={`status-dot ${order.status}`}><StatusIcon status={order.status} /></span>
              <strong>{agentName(topology, order.assigneeAgentId)}</strong>
              <span>{order.returnRelationship}</span>
            </div>
            <p>{order.objective}</p>
            <div className="order-meta">
              <span>{order.allowedResources.length} resources</span>
              <span>{order.status}</span>
            </div>
            {order.error && <div className="inline-error">{order.error}</div>}
          </article>
        ))}
      </div>
    </section>
  );
}

function RuntimePanel({ runtime }: { runtime: RuntimeSnapshot | null }) {
  if (!runtime) return <aside className="runtime-panel">Runtime snapshot unavailable.</aside>;
  const ramPercent = Math.min(100, (runtime.hardware.usedRamMb / runtime.hardware.totalRamMb) * 100);
  return (
    <aside className="runtime-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Live telemetry</span>
          <h2>Runtime</h2>
        </div>
        <span className={`runtime-orb ${runtime.status}`} />
      </div>

      <div className="telemetry-card">
        <div className="metric-row"><Cpu size={15} /><span>CPU</span><strong>{runtime.hardware.loadPercent}%</strong></div>
        <div className="meter"><span style={{ width: `${runtime.hardware.loadPercent}%` }} /></div>
        <div className="metric-row"><MemoryStick size={15} /><span>RAM</span><strong>{Math.round(runtime.hardware.usedRamMb / 1024)} / {Math.round(runtime.hardware.totalRamMb / 1024)} GB</strong></div>
        <div className="meter ram"><span style={{ width: `${ramPercent}%` }} /></div>
        <div className="metric-row"><Gauge size={15} /><span>Residency budget</span><strong>{Math.round(runtime.memoryBudgetMb / 1024)} GB</strong></div>
      </div>

      <div className="runtime-section">
        <div className="section-label"><Network size={14} /> Scheduler</div>
        <div className="runtime-stat-grid">
          <div><strong>{runtime.activeRunIds.length}</strong><span>active</span></div>
          <div><strong>{runtime.queuedRunIds.length}</strong><span>queued</span></div>
        </div>
      </div>

      <div className="runtime-section">
        <div className="section-label"><HardDrive size={14} /> Model residency</div>
        <div className="model-list">
          {runtime.models.length === 0 ? (
            <p className="muted-copy">Models appear here after their first request.</p>
          ) : (
            runtime.models.map((model) => (
              <div className="model-row" key={model.modelId}>
                <span className={`model-state ${model.state}`} />
                <div><strong>{model.modelName}</strong><span>{model.state} · {model.requestCount} calls</span></div>
                <small>{model.estimatedMemoryMb} MB</small>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="runtime-footnote">
        <span>GPU metrics</span>
        <strong>provider unavailable</strong>
      </div>
    </aside>
  );
}

export function WorkView({ topology, runs, runtime, onRunChanged, notify }: Props) {
  const agents = useMemo(() => entryAgents(topology), [topology]);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [objective, setObjective] = useState("");
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(agents[0]?.id ?? "");
  }, [agentId, agents]);

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0]?.id ?? "");
    }
  }, [runs, selectedRunId]);

  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const submit = async () => {
    if (!objective.trim() || !agentId || submitting) return;
    setSubmitting(true);
    try {
      const run = await api.createRun({
        topologyId: topology.id,
        entryAgentId: agentId,
        objective: objective.trim(),
      });
      onRunChanged(run);
      setSelectedRunId(run.id);
      setObjective("");
      notify("success", "Work accepted by the local scheduler.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const pauseOrResume = async () => {
    if (!selectedRun) return;
    try {
      const next =
        selectedRun.status === "paused"
          ? await api.resumeRun(selectedRun.id)
          : await api.pauseRun(selectedRun.id);
      onRunChanged(next);
      notify("info", selectedRun.status === "paused" ? "Run resumed." : "Run paused safely.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="work-layout">
      <aside className="run-sidebar">
        <div className="sidebar-heading">
          <div><span className="eyebrow">Workspace</span><h2>Recent work</h2></div>
          <button className="icon-button" title="Refresh" onClick={() => window.location.reload()}><RotateCcw size={15} /></button>
        </div>
        <div className="run-list">
          {runs.length === 0 ? (
            <div className="empty-history"><Sparkles size={20} /><p>Your completed and active runs will live here.</p></div>
          ) : (
            runs.map((run) => (
              <button
                key={run.id}
                className={`run-list-item ${selectedRunId === run.id ? "selected" : ""}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                <span className={`run-status-mark ${run.status}`} />
                <div><strong>{run.objective}</strong><span>{shortTime(run.createdAt)} · {run.status}</span></div>
                <ChevronRight size={14} />
              </button>
            ))
          )}
        </div>
        <div className="sidebar-note">
          <span>Active topology</span>
          <strong>{topology.name}</strong>
          <small>{topology.nodes.length} nodes · {topology.edges.length} boundaries</small>
        </div>
      </aside>

      <section className="work-center">
        <header className="work-header">
          <div>
            <span className="eyebrow">Work</span>
            <h1>{selectedRun ? selectedRun.objective : "What should the team accomplish?"}</h1>
          </div>
          {selectedRun && (
            <div className="run-actions">
              <span className={`run-badge ${selectedRun.status}`}>{selectedRun.status}</span>
              {["queued", "running", "paused"].includes(selectedRun.status) && (
                <button className="secondary-button" onClick={() => void pauseOrResume()}>
                  {selectedRun.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                  {selectedRun.status === "paused" ? "Resume" : "Pause"}
                </button>
              )}
            </div>
          )}
        </header>

        <div className="conversation-scroll">
          {!selectedRun ? (
            <div className="work-empty-state">
              <div className="empty-emblem"><Bot size={30} /></div>
              <h2>One request. A bounded team.</h2>
              <p>
                The lead agent can delegate only through relationships drawn in Configure. Every model,
                tool, skill, connector, and storage target remains behind an explicit edge.
              </p>
              <div className="suggestion-grid">
                {[
                  "Calculate 72 * 18 and propose a verification plan",
                  "Design a small local-first feature and review its risks",
                  "Turn a product idea into an implementation brief",
                ].map((suggestion) => (
                  <button key={suggestion} onClick={() => setObjective(suggestion)}>{suggestion}<ArrowUp size={14} /></button>
                ))}
              </div>
            </div>
          ) : (
            <div className="conversation-content">
              <article className="message user-message">
                <div className="message-avatar">You</div>
                <div><span className="message-author">Request</span><p>{selectedRun.objective}</p></div>
              </article>

              <WorkOrderRail run={selectedRun} topology={topology} />

              {selectedRun.result ? (
                <article className="message agent-message">
                  <div className="message-avatar"><Bot size={17} /></div>
                  <div>
                    <span className="message-author">{agentName(topology, selectedRun.entryAgentId)} · final</span>
                    <div className="result-copy"><ReactMarkdown>{selectedRun.result}</ReactMarkdown></div>
                    <div className="result-footer">
                      <span><Clock3 size={12} /> {elapsed(selectedRun.metrics.elapsedMs)}</span>
                      <span>{selectedRun.metrics.promptTokens + selectedRun.metrics.completionTokens} tokens</span>
                      <span>{selectedRun.metrics.modelCalls} model calls</span>
                    </div>
                  </div>
                </article>
              ) : selectedRun.error ? (
                <div className="run-error"><X size={18} /><div><strong>Run stopped</strong><p>{selectedRun.error}</p></div></div>
              ) : (
                <div className="active-run-note">
                  {selectedRun.status === "paused" ? <CirclePause size={17} /> : <LoaderCircle className="spin" size={17} />}
                  <div><strong>{selectedRun.status === "paused" ? "State preserved" : "Team is working"}</strong><span>{selectedRun.events.at(-1)?.message}</span></div>
                </div>
              )}

              {selectedRun.artifactPaths.length > 0 && (
                <div className="artifact-strip"><FileText size={15} /><span>{selectedRun.artifactPaths.length} durable artifacts written to connected storage</span></div>
              )}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Give your configured team a task…"
              rows={3}
            />
            <div className="composer-bar">
              <label className="agent-picker"><Bot size={14} /><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select></label>
              <span className="composer-hint">Ctrl ↵ to send</span>
              <button
                className="send-button"
                disabled={!objective.trim() || !agentId || submitting}
                onClick={() => void submit()}
                title="Send task"
              >
                {submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={17} />}
              </button>
            </div>
          </div>
        </div>
      </section>

      <RuntimePanel runtime={runtime} />
    </div>
  );
}
