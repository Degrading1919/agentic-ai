import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CirclePause,
  Clock3,
  Cpu,
  FileText,
  Gauge,
  GitBranch,
  HardDrive,
  Inbox,
  Layers,
  LoaderCircle,
  MemoryStick,
  MonitorCog,
  Network,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type {
  ContextFrame,
  RelationshipName,
  Run,
  RuntimeSnapshot,
  Topology,
  WorkOrder,
} from "../../shared/contracts.js";
import { formatTokens } from "../../shared/tokens.js";
import { entryAgents, relationshipDescriptions, relationshipKindFor } from "../../shared/topology.js";
import { api } from "../api.js";
import { relationshipColor } from "../node-meta.js";
import { ContextBar } from "./ContextBar.js";

type Props = {
  topology: Topology;
  runs: Run[];
  runtime: RuntimeSnapshot | null;
  onRunChanged: (run: Run) => void;
  notify: (tone: "success" | "error" | "info", message: string) => void;
};

function shortTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function elapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function agentName(topology: Topology, id: string | null): string {
  if (!id) return "user";
  return topology.nodes.find((node) => node.id === id)?.name ?? id;
}

/** Markdown summaries rendered as a one-line card preview. */
function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function relationColor(name: RelationshipName): string {
  const kind = relationshipKindFor(name);
  return kind ? relationshipColor[kind] : "#c6ff4a";
}

function StatusIcon({ status }: { status: WorkOrder["status"] }) {
  if (status === "completed") return <Check size={12} />;
  if (status === "running") return <LoaderCircle className="spin" size={12} />;
  if (status === "waiting") return <Clock3 size={12} />;
  if (status === "handed_off") return <ArrowRight size={12} />;
  if (status === "superseded") return <GitBranch size={12} />;
  if (status === "failed" || status === "blocked") return <X size={12} />;
  return <CirclePause size={12} />;
}

function RelationBadge({ name }: { name: RelationshipName }) {
  const color = relationColor(name);
  return (
    <span className="relation-badge" style={{ color, borderColor: `${color}55`, background: `${color}14` }} title={relationshipDescriptions[name]}>
      {name}
    </span>
  );
}

function PlanStrip({ run, topology }: { run: Run; topology: Topology }) {
  if (run.plans.length === 0) return null;
  return (
    <section className="plan-strip">
      <div className="section-kicker"><Network size={13} /> Delegation decisions</div>
      {run.plans.map((plan) => {
        const selected = new Set(plan.selected.map((item) => `${item.agentId}:${item.relationship}`));
        return (
          <div className="plan-row" key={plan.id}>
            <div className="plan-head">
              <strong>{agentName(topology, plan.agentId)}</strong>
              <span className={`plan-mode ${plan.mode}`}>{plan.mode}</span>
              {plan.source === "fallback" && <span className="plan-mode fallback" title="The model's plan was not valid JSON; a deterministic relevance plan was used.">fallback</span>}
            </div>
            <div className="plan-candidates">
              {plan.available.map((item) => {
                const chosen = selected.has(`${item.agentId}:${item.relationship}`);
                return (
                  <span key={`${item.agentId}:${item.relationship}`} className={`plan-candidate ${chosen ? "chosen" : "skipped"}`} title={chosen ? "Selected" : "Available but not invoked"}>
                    {chosen ? <Check size={10} /> : <X size={10} />} {agentName(topology, item.agentId)} · {item.relationship}
                  </span>
                );
              })}
            </div>
            <p>{plan.rationale}</p>
          </div>
        );
      })}
    </section>
  );
}

function orderTokens(run: Run, orderId: string): { estimated: number; calls: number } {
  const frames = run.contextFrames.filter((frame) => frame.workOrderId === orderId);
  return { estimated: frames.reduce((sum, frame) => sum + frame.estimatedPromptTokens, 0), calls: frames.length };
}

function OrderCard({
  order,
  run,
  topology,
  selected,
  onSelect,
}: {
  order: WorkOrder;
  run: Run;
  topology: Topology;
  selected: boolean;
  onSelect: () => void;
}) {
  const usage = orderTokens(run, order.id);
  const successor = order.handedOffToOrderId ? run.workOrders.find((item) => item.id === order.handedOffToOrderId) : null;
  return (
    <button className={`order-card ${order.status} ${selected ? "selected" : ""}`} onClick={onSelect}>
      <div className="order-card-topline">
        <span className={`status-dot ${order.status}`}><StatusIcon status={order.status} /></span>
        <strong>{agentName(topology, order.assigneeAgentId)}</strong>
        <RelationBadge name={order.returnRelationship} />
        {order.revisionOf && <span className="order-flag">revision</span>}
        {!order.blocking && <span className="order-flag" title="Advice only; failure does not fail the requester.">advisory</span>}
        {order.verdict && <span className={`verdict-chip ${order.verdict.verdict}`}>{order.verdict.verdict}</span>}
        <span className="order-status">{order.status === "running" || order.status === "waiting" ? `${order.status} · ${order.phase}` : order.status.replace("_", " ")}</span>
      </div>
      <p>{plainText(order.summary ?? order.objective)}</p>
      <div className="order-meta">
        <span>owner {agentName(topology, order.ownerAgentId ?? order.assigneeAgentId)}</span>
        {successor && <span>→ {agentName(topology, successor.assigneeAgentId)}</span>}
        {usage.calls > 0 && <span>{usage.calls} call{usage.calls === 1 ? "" : "s"} · ≈{formatTokens(usage.estimated)} ctx</span>}
      </div>
      {order.error && <div className="inline-error">{order.error}</div>}
    </button>
  );
}

function OrderTree({
  run,
  topology,
  selectedOrderId,
  onSelect,
}: {
  run: Run;
  topology: Topology;
  selectedOrderId: string | null;
  onSelect: (id: string) => void;
}) {
  const childrenOf = (parentId: string | null) =>
    run.workOrders.filter((order) => order.parentId === parentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const render = (order: WorkOrder, depth: number): React.ReactNode => (
    <div key={order.id} className="order-branch" style={{ "--depth": depth } as React.CSSProperties}>
      <OrderCard order={order} run={run} topology={topology} selected={selectedOrderId === order.id} onSelect={() => onSelect(order.id)} />
      {childrenOf(order.id).map((child) => render(child, depth + 1))}
    </div>
  );
  return (
    <section className="work-order-rail">
      <div className="section-kicker"><Workflow size={13} /> Structured work orders</div>
      <div className="order-tree">{childrenOf(null).map((order) => render(order, 0))}</div>
    </section>
  );
}

function FrameRow({ frame }: { frame: ContextFrame }) {
  const cached = frame.cachedPromptTokens ?? 0;
  return (
    <div className="frame-row">
      <div className="frame-head">
        <span className="frame-purpose">{frame.purpose.replace("_", " ")}</span>
        <span>{frame.exposure === "none" ? "no tools" : `${frame.exposedToolSchemas}/${frame.authorizedTools} schemas · ${frame.exposure}`}</span>
        <span className={frame.prefixReused ? "reuse yes" : "reuse"} title="Whether this request's stable prefix matched the previous request to the same model.">
          {frame.prefixReused ? "prefix reused" : "new prefix"}
        </span>
        {frame.actualPromptTokens !== null && (
          <span title="Reported by the inference server">
            {formatTokens(frame.actualPromptTokens)} actual{cached ? ` · ${formatTokens(cached)} cached` : ""}
          </span>
        )}
      </div>
      <ContextBar segments={frame.segments} window={frame.contextWindow} reserved={frame.reservedOutputTokens} compact />
    </div>
  );
}

function OrderDetail({ order, run, topology }: { order: WorkOrder; run: Run; topology: Topology }) {
  const frames = run.contextFrames.filter((frame) => frame.workOrderId === order.id);
  const latest = frames.at(-1);
  const content = order.result ?? order.draft;
  return (
    <section className="order-detail">
      <header>
        <div>
          <span className="eyebrow">Work order · {order.id.slice(0, 8)}</span>
          <h3>{agentName(topology, order.assigneeAgentId)} <RelationBadge name={order.returnRelationship} /></h3>
        </div>
        <span className={`run-badge ${order.status}`}>{order.status.replace("_", " ")}</span>
      </header>
      <p className="semantics-line">{relationshipDescriptions[order.returnRelationship]}</p>
      <dl className="order-facts">
        <div><dt>Objective</dt><dd>{order.objective}</dd></div>
        <div><dt>Sender → owner</dt><dd>{agentName(topology, order.senderAgentId)} → {agentName(topology, order.ownerAgentId ?? order.assigneeAgentId)}</dd></div>
        {order.dependencies.length > 0 && <div><dt>Depends on</dt><dd>{order.dependencies.map((id) => agentName(topology, run.workOrders.find((item) => item.id === id)?.assigneeAgentId ?? id)).join(", ")}</dd></div>}
        <div><dt>Resources</dt><dd>{order.allowedResources.length} connected</dd></div>
      </dl>
      {order.verdict && order.verdict.findings.length > 0 && (
        <ul className="findings">
          {order.verdict.findings.map((finding, index) => (
            <li key={index}><span className={`severity ${finding.severity}`}>{finding.severity}</span>{finding.issue}{finding.recommendation && <em> → {finding.recommendation}</em>}</li>
          ))}
        </ul>
      )}
      {latest && (
        <div className="frame-section">
          <div className="section-label"><Layers size={12} /> Context per model call</div>
          {frames.map((frame) => <FrameRow key={frame.id} frame={frame} />)}
          <ContextBar segments={latest.segments} window={latest.contextWindow} reserved={latest.reservedOutputTokens} />
        </div>
      )}
      {content && <div className="result-copy order-result"><ReactMarkdown>{content}</ReactMarkdown></div>}
    </section>
  );
}

function ContextSummary({ run }: { run: Run }) {
  const { metrics } = run;
  const used = new Set(run.workOrders.map((order) => order.assigneeAgentId));
  const available = new Set([run.entryAgentId, ...run.plans.flatMap((plan) => plan.available.map((item) => item.agentId))]);
  const reuse = metrics.modelCalls ? Math.round((metrics.prefixReuses / metrics.modelCalls) * 100) : 0;
  const cachedShare = metrics.promptTokens ? Math.round((metrics.cachedPromptTokens / metrics.promptTokens) * 100) : 0;
  return (
    <div className="context-summary">
      <div><strong>{used.size}/{available.size}</strong><span>agents used</span></div>
      <div><strong>{metrics.modelCalls}</strong><span>model calls</span></div>
      <div><strong>{formatTokens(metrics.estimatedPromptTokens)}</strong><span>context sent (est.)</span></div>
      <div><strong>{formatTokens(metrics.promptTokens)}</strong><span>prompt tokens</span></div>
      <div title="Share of prompt tokens the server reported as served from its prefix cache"><strong>{cachedShare}%</strong><span>cache hits</span></div>
      <div title="Requests whose stable prefix matched the previous request to the same model"><strong>{reuse}%</strong><span>prefix reuse</span></div>
    </div>
  );
}

function RuntimePanel({ runtime }: { runtime: RuntimeSnapshot | null }) {
  if (!runtime) return <aside className="runtime-panel">Runtime snapshot unavailable.</aside>;
  const ramPercent = Math.min(100, (runtime.hardware.usedRamMb / runtime.hardware.totalRamMb) * 100);
  const gpu = runtime.hardware.gpu;
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
        <div className="metric-row"><MemoryStick size={15} /><span>RAM</span><strong>{(runtime.hardware.usedRamMb / 1024).toFixed(1)} / {Math.round(runtime.hardware.totalRamMb / 1024)} GB</strong></div>
        <div className="meter ram"><span style={{ width: `${ramPercent}%` }} /></div>
        {gpu.available ? (
          gpu.devices.map((device) => (
            <div key={device.index}>
              <div className="metric-row" title={device.name}><MonitorCog size={15} /><span>VRAM · {device.name.replace(/^NVIDIA (GeForce )?/, "")}</span><strong>{(device.usedVramMb / 1024).toFixed(1)} / {(device.totalVramMb / 1024).toFixed(1)} GB</strong></div>
              <div className="meter vram"><span style={{ width: `${(device.usedVramMb / device.totalVramMb) * 100}%` }} /></div>
              {device.utilizationPercent !== null && (
                <div className="metric-row sub"><span /><span>GPU util{device.temperatureC !== null ? ` · ${device.temperatureC}°C` : ""}</span><strong>{device.utilizationPercent}%</strong></div>
              )}
            </div>
          ))
        ) : (
          <div className="metric-row" title={gpu.reason}><MonitorCog size={15} /><span>GPU</span><strong>unavailable</strong></div>
        )}
        <div className="metric-row"><Gauge size={15} /><span>Residency budget</span><strong>{(runtime.memoryBudgetMb / 1024).toFixed(1)} GB{runtime.vramBudgetMb !== null ? ` · ${(runtime.vramBudgetMb / 1024).toFixed(1)} GB VRAM` : ""}</strong></div>
      </div>

      <div className="runtime-section">
        <div className="section-label"><Network size={14} /> Scheduler</div>
        <div className="runtime-stat-grid three">
          <div><strong>{runtime.activeRunIds.length}</strong><span>runs</span></div>
          <div><strong>{runtime.activeWorkOrders}</strong><span>orders</span></div>
          <div><strong>{runtime.queuedRunIds.length}</strong><span>queued</span></div>
        </div>
        <p className="muted-copy">Up to {runtime.maxParallelOrders} orders overlap when their models fit the budget; otherwise work runs sequentially.</p>
      </div>

      <div className="runtime-section">
        <div className="section-label"><HardDrive size={14} /> Model residency</div>
        <div className="model-list">
          {runtime.models.length === 0 ? (
            <p className="muted-copy">Models appear here after their first request.</p>
          ) : (
            runtime.models.map((model) => (
              <div className="model-row" key={model.modelId} title={model.lastError ?? undefined}>
                <span className={`model-state ${model.state}`} />
                <div>
                  <strong>{model.modelName}</strong>
                  <span>{model.state} · {model.activeRequests}/{model.parallelSlots} slots{model.waitingRequests ? ` · ${model.waitingRequests} waiting` : ""} · {model.requestCount} calls</span>
                </div>
                <small>{model.estimatedMemoryMb} MB{model.estimatedVramMb ? ` · ${model.estimatedVramMb} V` : ""}</small>
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

export function WorkView({ topology, runs, runtime, onRunChanged, notify }: Props) {
  const agents = useMemo(() => entryAgents(topology), [topology]);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [objective, setObjective] = useState("");
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? "");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [continueThread, setContinueThread] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(agents[0]?.id ?? "");
  }, [agentId, agents]);

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
    if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) setSelectedRunId(runs[0]?.id ?? "");
  }, [runs, selectedRunId]);

  // The run list carries summaries; fetch full detail only when the run changes.
  const summary = runs.find((run) => run.id === selectedRunId) ?? null;
  useEffect(() => {
    if (!summary) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .run(summary.id)
      .then((run) => {
        if (!cancelled) setDetail(run);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [summary?.id, summary?.updatedAt]);

  const selectedRun = detail && detail.id === selectedRunId ? detail : null;
  const selectedOrder = selectedRun?.workOrders.find((order) => order.id === selectedOrderId) ?? null;
  const canContinue = Boolean(selectedRun && ["completed", "failed"].includes(selectedRun.status));
  const threadRuns = selectedRun?.threadId ? runs.filter((run) => run.threadId === selectedRun.threadId || run.id === selectedRun.threadId).length : 0;

  const submit = async () => {
    if (!objective.trim() || !agentId || submitting) return;
    setSubmitting(true);
    try {
      const run = await api.createRun({
        topologyId: topology.id,
        entryAgentId: agentId,
        objective: objective.trim(),
        ...(canContinue && continueThread && selectedRun ? { previousRunId: selectedRun.id } : {}),
      });
      onRunChanged(run);
      setSelectedRunId(run.id);
      setSelectedOrderId(null);
      setObjective("");
      notify("success", run.previousRunId ? "Follow-up accepted; it receives a digest of prior work." : "Work accepted by the local scheduler.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const pauseOrResume = async () => {
    if (!selectedRun) return;
    try {
      const next = selectedRun.status === "paused" ? await api.resumeRun(selectedRun.id) : await api.pauseRun(selectedRun.id);
      onRunChanged(next);
      notify("info", selectedRun.status === "paused" ? "Run resumed." : "Run paused safely.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const status = summary?.status ?? selectedRun?.status;

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
                className={`run-list-item ${selectedRunId === run.id ? "selected" : ""} ${run.previousRunId ? "follow-up" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.id);
                  setSelectedOrderId(null);
                }}
              >
                <span className={`run-status-mark ${run.status}`} />
                <div><strong>{run.objective}</strong><span>{shortTime(run.createdAt)} · {run.status}{run.previousRunId ? " · follow-up" : ""}</span></div>
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
            <span className="eyebrow">Work{threadRuns > 1 ? ` · thread of ${threadRuns}` : ""}</span>
            <h1>{summary ? summary.objective : "What should the team accomplish?"}</h1>
          </div>
          {summary && status && (
            <div className="run-actions">
              <span className={`run-badge ${status}`}>{status}</span>
              {["queued", "running", "paused"].includes(status) && (
                <button className="secondary-button" onClick={() => void pauseOrResume()}>
                  {status === "paused" ? <Play size={14} /> : <Pause size={14} />}
                  {status === "paused" ? "Resume" : "Pause"}
                </button>
              )}
            </div>
          )}
        </header>

        <div className="conversation-scroll">
          {!summary ? (
            <div className="work-empty-state">
              <div className="empty-emblem"><Bot size={30} /></div>
              <h2>One request. A bounded team.</h2>
              <p>
                The lead agent delegates only through relationships drawn in Configure, and only to workers that add value. Every
                model, tool, skill, connector, and storage target remains behind an explicit edge.
              </p>
              <div className="suggestion-grid">
                {[
                  "Calculate 72 * 18 and propose a verification plan",
                  "Design a small local-first feature and review its risks",
                  "Build the implementation and write file notes/plan.md with the steps",
                ].map((suggestion) => (
                  <button key={suggestion} onClick={() => setObjective(suggestion)}>{suggestion}<ArrowUp size={14} /></button>
                ))}
              </div>
            </div>
          ) : !selectedRun ? (
            <div className="active-run-note"><LoaderCircle className="spin" size={17} /><div><strong>Loading run</strong></div></div>
          ) : (
            <div className="conversation-content">
              <article className="message user-message">
                <div className="message-avatar">You</div>
                <div>
                  <span className="message-author">Request{selectedRun.previousRunId ? " · follow-up in thread" : ""}</span>
                  <p>{selectedRun.objective}</p>
                </div>
              </article>

              <PlanStrip run={selectedRun} topology={topology} />
              <OrderTree run={selectedRun} topology={topology} selectedOrderId={selectedOrderId} onSelect={(id) => setSelectedOrderId(id === selectedOrderId ? null : id)} />
              {selectedOrder && <OrderDetail order={selectedOrder} run={selectedRun} topology={topology} />}

              {selectedRun.result ? (
                <article className="message agent-message">
                  <div className="message-avatar"><Bot size={17} /></div>
                  <div>
                    <span className="message-author">{agentName(topology, selectedRun.workOrders.find((order) => order.id === selectedRun.rootOrderId)?.assigneeAgentId ?? selectedRun.entryAgentId)} · final</span>
                    <div className="result-copy"><ReactMarkdown>{selectedRun.result}</ReactMarkdown></div>
                    <div className="result-footer">
                      <span><Clock3 size={12} /> {elapsed(selectedRun.metrics.elapsedMs)}</span>
                      <span>{selectedRun.metrics.promptTokens + selectedRun.metrics.completionTokens} tokens</span>
                      <span>{selectedRun.metrics.toolCalls} tool calls</span>
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

              {selectedRun.metrics.modelCalls > 0 && <ContextSummary run={selectedRun} />}

              {selectedRun.reports.length > 0 && (
                <div className="report-list">
                  <div className="section-label"><Inbox size={12} /> Status reports</div>
                  {selectedRun.reports.map((report) => (
                    <div key={report.id}>
                      <strong>{agentName(topology, report.fromAgentId)} → {agentName(topology, report.toAgentId)}</strong>
                      <span>{report.status}{report.consumedByOrderIds.length ? " · read" : " · unread"}</span>
                      <p>{report.summary}</p>
                    </div>
                  ))}
                </div>
              )}

              {selectedRun.artifacts.some((artifact) => artifact.kind !== "result") && (
                <div className="artifact-strip">
                  <FileText size={15} />
                  <span>
                    {selectedRun.artifacts
                      .filter((artifact) => artifact.kind !== "result")
                      .map((artifact) => `${artifact.name}${artifact.agentId ? ` (${agentName(topology, artifact.agentId)})` : ""}`)
                      .join(" · ")}
                  </span>
                </div>
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
              placeholder={canContinue && continueThread ? "Follow up on this run…" : "Give your configured team a task…"}
              rows={3}
            />
            <div className="composer-bar">
              <label className="agent-picker"><Bot size={14} /><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select></label>
              {canContinue && (
                <label className="thread-toggle" title="The follow-up receives a compact digest of this thread plus retrievable results, not the full transcript.">
                  <input type="checkbox" checked={continueThread} onChange={(event) => setContinueThread(event.target.checked)} />
                  <span>Continue thread</span>
                </label>
              )}
              <span className="composer-hint">Ctrl ↵ to send</span>
              <button className="send-button" disabled={!objective.trim() || !agentId || submitting} onClick={() => void submit()} title="Send task">
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
