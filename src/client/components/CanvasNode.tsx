import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { TopologyNode } from "../../shared/contracts.js";
import { nodeMeta } from "../node-meta.js";

export type CanvasNodeData = { topologyNode: TopologyNode } & Record<string, unknown>;
export type CanvasNodeType = Node<CanvasNodeData, "capabilityNode">;

function subtitle(node: TopologyNode): string {
  switch (node.kind) {
    case "agent":
      return node.config.role;
    case "model":
      return `${node.config.provider} · ${node.config.modelId}`;
    case "capability":
      return node.config.capabilityId;
    case "skill":
      return "instruction bundle";
    case "connector":
      return `${node.config.connectorType}${node.config.enabled ? "" : " · disabled"}`;
    case "storage":
      return node.config.storageType;
  }
}

export function CanvasNode({ data, selected }: NodeProps<CanvasNodeType>) {
  const node = data.topologyNode;
  const meta = nodeMeta[node.kind];
  const Icon = meta.icon;
  return (
    <div
      className={`canvas-node ${selected ? "selected" : ""} kind-${node.kind}`}
      style={{ "--node-color": meta.color, "--node-glow": meta.glow } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="node-handle target" />
      <div className="node-icon"><Icon size={17} /></div>
      <div className="node-copy">
        <span>{meta.label}</span>
        <strong>{node.name}</strong>
        <small>{subtitle(node)}</small>
      </div>
      {node.kind === "agent" && node.config.entrypoint && <span className="node-chip">entry</span>}
      <Handle type="source" position={Position.Right} className="node-handle source" />
    </div>
  );
}
