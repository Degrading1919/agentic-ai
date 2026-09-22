import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type NodeChange,
} from "@xyflow/react";
import {
  AlertTriangle,
  Check,
  CircleDot,
  MousePointer2,
  Plus,
  Redo2,
  Save,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import type {
  NodeKind,
  RuntimeSnapshot,
  Topology,
  TopologyEdge,
  TopologyNode,
  ValidationIssue,
} from "../../shared/contracts.js";
import {
  relationshipLabels,
  suggestedRelationship,
  validateTopology,
} from "../../shared/topology.js";
import { api } from "../api.js";
import { createNode, edgeStyle, nodeMeta, relationshipColor } from "../node-meta.js";
import { CanvasNode, type CanvasNodeType } from "./CanvasNode.js";
import { Inspector } from "./Inspector.js";

type Props = {
  topology: Topology;
  runtime: RuntimeSnapshot | null;
  onSave: (topology: Topology) => Promise<{ topology: Topology; issues: ValidationIssue[] }>;
  notify: (tone: "success" | "error" | "info", message: string) => void;
};

const nodeTypes = { capabilityNode: CanvasNode };
const paletteOrder: NodeKind[] = ["agent", "model", "capability", "skill", "connector", "storage"];

function toFlowNode(node: TopologyNode, selected: boolean): CanvasNodeType {
  return {
    id: node.id,
    type: "capabilityNode",
    position: node.position,
    initialWidth: 210,
    initialHeight: 72,
    handles: [
      {
        id: null,
        type: "target",
        position: Position.Left,
        x: 0,
        y: 0,
        width: 210,
        height: 72,
      },
      {
        id: null,
        type: "source",
        position: Position.Right,
        x: 0,
        y: 0,
        width: 210,
        height: 72,
      },
    ],
    selected,
    data: { topologyNode: node },
  };
}

function toFlowEdge(edge: TopologyEdge, selected: boolean): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    selected,
    label: edge.label || relationshipLabels[edge.kind],
    type: "smoothstep",
    animated: false,
    style: edgeStyle(edge),
    markerEnd: { type: MarkerType.ArrowClosed, color: relationshipColor[edge.kind] },
    labelStyle: { fill: "#aeb5c3", fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: "#11161f", fillOpacity: 0.92 },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
  };
}

function IssueList({ issues, onSelect }: { issues: ValidationIssue[]; onSelect: (issue: ValidationIssue) => void }) {
  if (!issues.length) {
    return <div className="topology-ready"><ShieldCheck size={16} /><span>Topology is runnable</span></div>;
  }
  return (
    <div className="issue-list">
      {issues.slice(0, 5).map((issue, index) => (
        <button key={`${issue.code}-${index}`} className={`issue-row ${issue.severity}`} onClick={() => onSelect(issue)}>
          {issue.severity === "error" ? <AlertTriangle size={13} /> : <CircleDot size={13} />}
          <span>{issue.message}</span>
        </button>
      ))}
      {issues.length > 5 && <small>+ {issues.length - 5} more issues</small>}
    </div>
  );
}

export function ConfigureView({ topology, runtime, onSave, notify }: Props) {
  const [draft, setDraft] = useState<Topology>(() => structuredClone(topology));
  const [saved, setSaved] = useState<Topology>(() => structuredClone(topology));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const issues = useMemo(() => validateTopology(draft), [draft]);
  const errors = issues.filter((issue) => issue.severity === "error");
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const flowNodes = useMemo(
    () => draft.nodes.map((node) => toFlowNode(node, selectedNodeId === node.id)),
    [draft.nodes, selectedNodeId],
  );
  const flowEdges = useMemo(
    () => draft.edges.map((edge) => toFlowEdge(edge, selectedEdgeId === edge.id)),
    [draft.edges, selectedEdgeId],
  );
  const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = draft.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const sourceNode = selectedEdge
    ? draft.nodes.find((node) => node.id === selectedEdge.source) ?? null
    : null;
  const targetNode = selectedEdge
    ? draft.nodes.find((node) => node.id === selectedEdge.target) ?? null
    : null;

  const selectNothing = () => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  };

  const addNode = (kind: NodeKind) => {
    const node = createNode(kind, draft.nodes.length);
    setDraft((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNodeType>[]) => {
      const changed = applyNodeChanges(changes, flowNodes);
      const changedById = new Map(changed.map((node) => [node.id, node]));
      setDraft((current) => {
        const remainingIds = new Set(changed.map((node) => node.id));
        return {
          ...current,
          nodes: current.nodes
            .filter((node) => remainingIds.has(node.id))
            .map((node) => ({ ...node, position: changedById.get(node.id)?.position ?? node.position }) as TopologyNode),
          edges: current.edges.filter(
            (edge) => remainingIds.has(edge.source) && remainingIds.has(edge.target),
          ),
        };
      });
    },
    [flowNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const source = draft.nodes.find((node) => node.id === connection.source);
      const target = draft.nodes.find((node) => node.id === connection.target);
      if (!source || !target) return;
      const kind = suggestedRelationship(source, target);
      if (!kind) {
        notify("error", "Connections must originate at an agent and grant access to a compatible target.");
        return;
      }
      const edge: TopologyEdge = {
        id: `edge-${crypto.randomUUID()}`,
        source: source.id,
        target: target.id,
        kind,
        label: relationshipLabels[kind],
        ...(kind === "agent_can_access_storage"
          ? { permissions: { read: true, write: false, scope: "/" } }
          : {}),
      };
      setDraft((current) => ({ ...current, edges: [...current.edges, edge] }));
      setSelectedNodeId(null);
      setSelectedEdgeId(edge.id);
    },
    [draft.nodes, notify],
  );

  const deleteSelected = () => {
    if (selectedNodeId) {
      setDraft((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== selectedNodeId),
        edges: current.edges.filter(
          (edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId,
        ),
      }));
    } else if (selectedEdgeId) {
      setDraft((current) => ({
        ...current,
        edges: current.edges.filter((edge) => edge.id !== selectedEdgeId),
      }));
    }
    selectNothing();
  };

  const save = async (): Promise<Topology> => {
    setSaving(true);
    try {
      const next = { ...draft, updatedAt: new Date().toISOString() };
      const result = await onSave(next);
      setDraft(structuredClone(result.topology));
      setSaved(structuredClone(result.topology));
      return result.topology;
    } finally {
      setSaving(false);
    }
  };

  const testModel = async (node: TopologyNode) => {
    if (node.kind !== "model") return { ok: false, message: "Only model nodes can be tested." };
    try {
      const savedTopology = await save();
      return await api.testModel(savedTopology.id, node.id);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  const reset = () => {
    setDraft(structuredClone(saved));
    selectNothing();
    notify("info", "Unsaved topology changes discarded.");
  };

  return (
    <div className="configure-layout">
      <aside className="palette-panel">
        <div className="sidebar-heading">
          <div><span className="eyebrow">Configure</span><h2>Node library</h2></div>
        </div>
        <p className="palette-intro">Add a resource, then draw from an agent to grant access.</p>
        <div className="node-palette">
          {paletteOrder.map((kind) => {
            const meta = nodeMeta[kind];
            const Icon = meta.icon;
            return (
              <button key={kind} onClick={() => addNode(kind)} style={{ "--node-color": meta.color, "--node-glow": meta.glow } as React.CSSProperties}>
                <span className="palette-icon"><Icon size={16} /></span>
                <span><strong>{meta.label}</strong><small>{meta.hint}</small></span>
                <Plus size={14} />
              </button>
            );
          })}
        </div>

        <div className="topology-summary">
          <div className="section-label">Topology health</div>
          <div className="summary-counts">
            <div><strong>{draft.nodes.length}</strong><span>nodes</span></div>
            <div><strong>{draft.edges.length}</strong><span>edges</span></div>
            <div className={errors.length ? "has-errors" : ""}><strong>{errors.length}</strong><span>errors</span></div>
          </div>
          <IssueList issues={issues} onSelect={(issue) => {
            if (issue.nodeId) { setSelectedNodeId(issue.nodeId); setSelectedEdgeId(null); }
            if (issue.edgeId) { setSelectedEdgeId(issue.edgeId); setSelectedNodeId(null); }
          }} />
        </div>

        <div className="boundary-principle"><ShieldCheck size={16} /><p><strong>Edges are hard boundaries.</strong><span>No edge, no access. Canvas position never implies execution order.</span></p></div>
      </aside>

      <section className="canvas-shell">
        <header className="canvas-toolbar">
          <div>
            <span className="eyebrow">Capability topology</span>
            <input
              className="topology-name-input"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              aria-label="Topology name"
            />
          </div>
          <div className="canvas-toolbar-actions">
            {dirty && <span className="unsaved-indicator"><CircleDot size={12} /> unsaved</span>}
            <button className="icon-button" title="Discard unsaved changes" disabled={!dirty} onClick={reset}><Undo2 size={15} /></button>
            <button className="icon-button" title="Redo is not available yet" disabled><Redo2 size={15} /></button>
            <button className="primary-button" disabled={saving || !dirty} onClick={() => void save()}><Save size={14} />{saving ? "Saving…" : "Save topology"}</button>
          </div>
        </header>

        <div className="flow-stage">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={(changes) => {
              const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
              if (removed.size) setDraft((current) => ({ ...current, edges: current.edges.filter((edge) => !removed.has(edge.id)) }));
            }}
            onConnect={onConnect}
            onNodeClick={(_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
            onPaneClick={selectNothing}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
            minZoom={0.25}
            maxZoom={1.7}
            deleteKeyCode={["Backspace", "Delete"]}
            proOptions={{ hideAttribution: false }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#2b3340" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={(node) => nodeMeta[(node.data as { topologyNode: TopologyNode }).topologyNode.kind].color}
              maskColor="rgba(6, 9, 13, .72)"
            />
          </ReactFlow>
          <div className="canvas-instruction"><MousePointer2 size={13} /> Drag between node handles to grant access</div>
          {runtime?.activeRunIds.length ? <div className="live-edit-note"><span /> Live run active · pause before changing execution boundaries</div> : null}
        </div>
      </section>

      <aside className="inspector-panel">
        <Inspector
          node={selectedNode}
          edge={selectedEdge}
          sourceNode={sourceNode}
          targetNode={targetNode}
          onUpdateNode={(node) => setDraft((current) => ({ ...current, nodes: current.nodes.map((candidate) => candidate.id === node.id ? node : candidate) }))}
          onUpdateEdge={(edge) => setDraft((current) => ({ ...current, edges: current.edges.map((candidate) => candidate.id === edge.id ? edge : candidate) }))}
          onDelete={deleteSelected}
          onTestModel={testModel}
        />
      </aside>
    </div>
  );
}
