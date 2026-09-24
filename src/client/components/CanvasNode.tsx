import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { TopologyNode } from "../../shared/contracts.js";
import type { AgentFootprint } from "../../shared/prompt.js";
import { formatTokens } from "../../shared/tokens.js";
import { nodeMeta } from "../node-meta.js";

export type CanvasNodeData = {
  topologyNode: TopologyNode;
  footprint: AgentFootprint | null;
} & Record<string, unknown>;
export type CanvasNodeType = Node<CanvasNodeData, "capabilityNode">;

function subtitle(node: TopologyNode): string {
  switch (node.kind) {
    case "agent":
      return node.config.role;
    case "model":
      return `${node.config.provider} · ${node.config.modelId}${node.config.artifact.quantization ? ` · ${node.config.artifact.quantization}` : ""}`;
    case "capability":
      return node.config.capabilityId;
    case "skill":
      return node.config.loading === "on-demand" ? "on-demand skill" : "instruction bundle";
    case "connector":
      return `${node.config.connectorType}${node.config.connectorType === "mcp" ? ` · ${node.config.transport}` : ""}${node.config.enabled ? "" : " · disabled"}`;
    case "storage":
      return node.config.storageType;
  }
}

/** Static context cost of an agent relative to its model window. */
function FootprintBadge({ footprint }: { footprint: AgentFootprint }) {
  const share = footprint.contextWindow ? footprint.stableTokens / footprint.contextWindow : 0;
  const tone = share > 0.5 ? "heavy" : share > 0.25 ? "warm" : "light";
  return (
    <span
      className={`footprint-badge ${tone}`}
      title={`Stable context ≈${footprint.stableTokens} tokens (${Math.round(share * 100)}% of the model window) before any work-order payload. Tools: ${footprint.exposedToolSchemas}/${footprint.authorizedTools} schemas sent (${footprint.exposure}).`}
    >
      {formatTokens(footprint.stableTokens)}
      {footprint.exposure === "deferred" ? " · lazy" : ""}
    </span>
  );
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
      <div className="node-chips">
        {node.kind === "agent" && node.config.entrypoint && <span className="node-chip">entry</span>}
        {data.footprint && <FootprintBadge footprint={data.footprint} />}
      </div>
      <Handle type="source" position={Position.Right} className="node-handle source" />
    </div>
  );
}
