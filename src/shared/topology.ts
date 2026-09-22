import type {
  AgentNode,
  CapabilityNode,
  ConnectorNode,
  ModelNode,
  RelationshipKind,
  SkillNode,
  StorageNode,
  Topology,
  TopologyEdge,
  TopologyNode,
  ValidationIssue,
} from "./contracts.js";

export const relationshipLabels: Record<RelationshipKind, string> = {
  agent_uses_model: "uses model",
  agent_can_use_capability: "can use",
  agent_can_use_skill: "applies skill",
  agent_can_use_connector: "can connect",
  agent_can_access_storage: "storage access",
  agent_can_delegate_to_agent: "delegate",
  agent_can_consult_agent: "consult",
  agent_can_review_agent: "review",
  agent_reports_to_agent: "report",
  agent_can_handoff_to_agent: "handoff",
};

export const collaborationKinds: RelationshipKind[] = [
  "agent_can_delegate_to_agent",
  "agent_can_consult_agent",
  "agent_can_review_agent",
  "agent_reports_to_agent",
  "agent_can_handoff_to_agent",
];

const targetKindByRelationship: Record<RelationshipKind, TopologyNode["kind"]> = {
  agent_uses_model: "model",
  agent_can_use_capability: "capability",
  agent_can_use_skill: "skill",
  agent_can_use_connector: "connector",
  agent_can_access_storage: "storage",
  agent_can_delegate_to_agent: "agent",
  agent_can_consult_agent: "agent",
  agent_can_review_agent: "agent",
  agent_reports_to_agent: "agent",
  agent_can_handoff_to_agent: "agent",
};

export function suggestedRelationship(
  source: TopologyNode,
  target: TopologyNode,
): RelationshipKind | null {
  if (source.kind !== "agent") return null;

  switch (target.kind) {
    case "model":
      return "agent_uses_model";
    case "capability":
      return "agent_can_use_capability";
    case "skill":
      return "agent_can_use_skill";
    case "connector":
      return "agent_can_use_connector";
    case "storage":
      return "agent_can_access_storage";
    case "agent":
      return "agent_can_delegate_to_agent";
  }
}

export function isLegalEdge(
  source: TopologyNode | undefined,
  target: TopologyNode | undefined,
  kind: RelationshipKind,
): boolean {
  return Boolean(
    source &&
      target &&
      source.kind === "agent" &&
      targetKindByRelationship[kind] === target.kind &&
      source.id !== target.id,
  );
}

export function validateTopology(topology: Topology): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeMap = new Map<string, TopologyNode>();
  const edgeIds = new Set<string>();
  const edgeKeys = new Set<string>();

  for (const node of topology.nodes) {
    if (nodeMap.has(node.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_node_id",
        message: `Node ID '${node.id}' is used more than once.`,
        nodeId: node.id,
      });
    }
    nodeMap.set(node.id, node);
  }

  for (const edge of topology.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_edge_id",
        message: `Edge ID '${edge.id}' is used more than once.`,
        edgeId: edge.id,
      });
    }
    edgeIds.add(edge.id);

    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) {
      issues.push({
        severity: "error",
        code: "dangling_edge",
        message: `Edge '${edge.id}' references a missing node.`,
        edgeId: edge.id,
      });
      continue;
    }

    if (!isLegalEdge(source, target, edge.kind)) {
      issues.push({
        severity: "error",
        code: "illegal_edge",
        message: `${edge.kind} cannot connect ${source.kind} '${source.name}' to ${target.kind} '${target.name}'.`,
        edgeId: edge.id,
      });
    }

    const edgeKey = `${edge.source}:${edge.target}:${edge.kind}`;
    if (edgeKeys.has(edgeKey)) {
      issues.push({
        severity: "warning",
        code: "duplicate_relationship",
        message: `The relationship '${relationshipLabels[edge.kind]}' is duplicated between ${source.name} and ${target.name}.`,
        edgeId: edge.id,
      });
    }
    edgeKeys.add(edgeKey);

    if (edge.kind === "agent_can_access_storage" && !edge.permissions) {
      issues.push({
        severity: "error",
        code: "missing_storage_permissions",
        message: `Storage access from '${source.name}' needs explicit read/write permissions.`,
        edgeId: edge.id,
      });
    }
  }

  const agents = topology.nodes.filter((node): node is AgentNode => node.kind === "agent");
  if (!agents.some((agent) => agent.config.entrypoint)) {
    issues.push({
      severity: "error",
      code: "missing_entrypoint",
      message: "At least one agent must be available as a Work entry point.",
    });
  }

  for (const agent of agents) {
    const modelEdges = topology.edges.filter(
      (edge) => edge.source === agent.id && edge.kind === "agent_uses_model",
    );
    if (modelEdges.length === 0) {
      issues.push({
        severity: "error",
        code: "agent_without_model",
        message: `Agent '${agent.name}' has no connected model.`,
        nodeId: agent.id,
      });
    } else if (modelEdges.length > 1) {
      issues.push({
        severity: "error",
        code: "agent_with_multiple_models",
        message: `Agent '${agent.name}' has multiple assigned models; the MVP requires exactly one.`,
        nodeId: agent.id,
      });
    }
  }

  const delegationAdjacency = new Map<string, string[]>();
  for (const edge of topology.edges) {
    if (edge.kind !== "agent_can_delegate_to_agent") continue;
    delegationAdjacency.set(edge.source, [
      ...(delegationAdjacency.get(edge.source) ?? []),
      edge.target,
    ]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasDelegationCycle = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const target of delegationAdjacency.get(nodeId) ?? []) {
      if (hasDelegationCycle(target)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  if (agents.some((agent) => hasDelegationCycle(agent.id))) {
    issues.push({
      severity: "warning",
      code: "delegation_cycle",
      message:
        "Delegation relationships contain a cycle. This is legal topology, but the runtime will not recursively delegate child work in the MVP.",
    });
  }

  return issues;
}

export type AgentTopologyContext = {
  agent: AgentNode;
  model: ModelNode | null;
  capabilities: CapabilityNode[];
  skills: SkillNode[];
  connectors: ConnectorNode[];
  storage: Array<{ node: StorageNode; edge: TopologyEdge }>;
  collaborators: Array<{ agent: AgentNode; edge: TopologyEdge }>;
  allowedResourceIds: string[];
};

export function getAgentContext(
  topology: Topology,
  agentId: string,
): AgentTopologyContext | null {
  const nodeMap = new Map(topology.nodes.map((node) => [node.id, node]));
  const agent = nodeMap.get(agentId);
  if (!agent || agent.kind !== "agent") return null;

  let model: ModelNode | null = null;
  const capabilities: CapabilityNode[] = [];
  const skills: SkillNode[] = [];
  const connectors: ConnectorNode[] = [];
  const storage: Array<{ node: StorageNode; edge: TopologyEdge }> = [];
  const collaborators: Array<{ agent: AgentNode; edge: TopologyEdge }> = [];
  const allowedResourceIds = new Set<string>();

  for (const edge of topology.edges) {
    if (edge.source !== agentId) continue;
    const target = nodeMap.get(edge.target);
    if (!target || !isLegalEdge(agent, target, edge.kind)) continue;

    allowedResourceIds.add(target.id);
    if (edge.kind === "agent_uses_model" && target.kind === "model") model = target;
    if (edge.kind === "agent_can_use_capability" && target.kind === "capability") {
      capabilities.push(target);
    }
    if (edge.kind === "agent_can_use_skill" && target.kind === "skill") skills.push(target);
    if (edge.kind === "agent_can_use_connector" && target.kind === "connector") {
      connectors.push(target);
    }
    if (edge.kind === "agent_can_access_storage" && target.kind === "storage") {
      storage.push({ node: target, edge });
    }
    if (collaborationKinds.includes(edge.kind) && target.kind === "agent") {
      collaborators.push({ agent: target, edge });
    }
  }

  return {
    agent,
    model,
    capabilities,
    skills,
    connectors,
    storage,
    collaborators,
    allowedResourceIds: [...allowedResourceIds],
  };
}

export function hasCollaborationPermission(
  topology: Topology,
  sourceAgentId: string,
  targetAgentId: string,
  relationship?: RelationshipKind,
): TopologyEdge | null {
  return (
    topology.edges.find(
      (edge) =>
        edge.source === sourceAgentId &&
        edge.target === targetAgentId &&
        collaborationKinds.includes(edge.kind) &&
        (!relationship || edge.kind === relationship),
    ) ?? null
  );
}

export function entryAgents(topology: Topology): AgentNode[] {
  return topology.nodes.filter(
    (node): node is AgentNode => node.kind === "agent" && node.config.entrypoint,
  );
}
