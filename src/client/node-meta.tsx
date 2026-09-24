import {
  Bot,
  Box,
  BrainCircuit,
  Cable,
  Database,
  FunctionSquare,
  type LucideIcon,
} from "lucide-react";
import type {
  NodeKind,
  RelationshipKind,
  TopologyEdge,
  TopologyNode,
} from "../shared/contracts.js";
import { topologyNodeSchema } from "../shared/contracts.js";
import type { z } from "zod";

export type NodeMeta = {
  label: string;
  plural: string;
  icon: LucideIcon;
  color: string;
  glow: string;
  hint: string;
};

export const nodeMeta: Record<NodeKind, NodeMeta> = {
  agent: {
    label: "Agent",
    plural: "Agents",
    icon: Bot,
    color: "#c6ff4a",
    glow: "rgba(198, 255, 74, 0.18)",
    hint: "Specialized worker",
  },
  model: {
    label: "Model",
    plural: "Models",
    icon: BrainCircuit,
    color: "#54d7ff",
    glow: "rgba(84, 215, 255, 0.18)",
    hint: "Inference artifact",
  },
  capability: {
    label: "Capability",
    plural: "Capabilities",
    icon: FunctionSquare,
    color: "#ffb454",
    glow: "rgba(255, 180, 84, 0.18)",
    hint: "Callable tool",
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    icon: Box,
    color: "#c09cff",
    glow: "rgba(192, 156, 255, 0.18)",
    hint: "Reusable guidance",
  },
  connector: {
    label: "Connector",
    plural: "Connectors",
    icon: Cable,
    color: "#ff7fc4",
    glow: "rgba(255, 127, 196, 0.18)",
    hint: "MCP or HTTP boundary",
  },
  storage: {
    label: "Storage",
    plural: "Storage",
    icon: Database,
    color: "#76e6b3",
    glow: "rgba(118, 230, 179, 0.18)",
    hint: "Durable local data",
  },
};

export const relationshipColor: Record<RelationshipKind, string> = {
  agent_uses_model: "#54d7ff",
  agent_can_use_capability: "#ffb454",
  agent_can_use_skill: "#c09cff",
  agent_can_use_connector: "#ff7fc4",
  agent_can_access_storage: "#76e6b3",
  agent_can_delegate_to_agent: "#c6ff4a",
  agent_can_consult_agent: "#82f0ff",
  agent_can_review_agent: "#ffc857",
  agent_reports_to_agent: "#b9a9ff",
  agent_can_handoff_to_agent: "#ff8d75",
};

export function edgeStyle(edge: TopologyEdge) {
  const collaboration = edge.kind.includes("_to_agent");
  return {
    stroke: relationshipColor[edge.kind],
    strokeWidth: collaboration ? 2.2 : 1.7,
    strokeDasharray: edge.kind === "agent_can_review_agent" ? "7 5" : undefined,
  };
}

type NodeInput = z.input<typeof topologyNodeSchema>;

function draftNode(kind: NodeKind, id: string, position: { x: number; y: number }): NodeInput {
  switch (kind) {
    case "agent":
      return {
        id,
        kind,
        name: "New agent",
        description: "A specialized worker with explicitly connected resources.",
        position,
        config: {
          role: "Specialist",
          instructions: "Complete assigned work precisely and return a verifiable result.",
          autoDelegate: false,
        },
      };
    case "model":
      return {
        id,
        kind,
        name: "Local model",
        description: "OpenAI-compatible local inference model.",
        position,
        config: { provider: "openai-compatible", modelId: "local-model", estimatedMemoryMb: 3_000 },
      };
    case "capability":
      return {
        id,
        kind,
        name: "Calculator",
        description: "Safe bounded arithmetic.",
        position,
        config: { capabilityId: "calculator", enabled: true },
      };
    case "skill":
      return {
        id,
        kind,
        name: "New skill",
        description: "Reusable operating guidance.",
        position,
        config: { instructions: "Follow this guidance when completing connected work." },
      };
    case "connector":
      return {
        id,
        kind,
        name: "MCP connector",
        description: "A configured external capability boundary.",
        position,
        config: { connectorType: "mcp", endpoint: "http://127.0.0.1:3333/mcp", enabled: false },
      };
    case "storage":
      return {
        id,
        kind,
        name: "Local storage",
        description: "Durable project and run data.",
        position,
        config: { storageType: "artifact-store", location: "artifacts" },
      };
  }
}

/** New nodes pass through the schema so every configuration default applies. */
export function createNode(kind: NodeKind, index: number): TopologyNode {
  const id = `${kind}-${crypto.randomUUID()}`;
  const position = { x: 180 + (index % 3) * 290, y: 120 + Math.floor(index / 3) * 190 };
  return topologyNodeSchema.parse(draftNode(kind, id, position));
}
