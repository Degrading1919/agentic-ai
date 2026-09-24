import { type Topology, topologySchema } from "./contracts.js";
import type { z } from "zod";

type TopologyInput = z.input<typeof topologySchema>;

export function createDemoTopology(): Topology {
  const now = new Date().toISOString();
  const input: TopologyInput = {
    version: 1,
    id: "topology-local-studio",
    name: "Local product studio",
    description:
      "A compact team that delegates implementation, consults on architecture, and reviews risk while respecting explicit capability boundaries.",
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "agent-orchestrator",
        kind: "agent",
        name: "Orchestrator",
        description: "Plans, delegates, tracks, and integrates work.",
        position: { x: 80, y: 250 },
        config: {
          role: "Planning and integration lead",
          instructions:
            "Decompose the request into clear work, use connected specialists only when they add value, and synthesize a concise final result grounded in their outputs.",
          entrypoint: true,
          autoDelegate: true,
          maxOutputTokens: 1_200,
        },
      },
      {
        id: "agent-builder",
        kind: "agent",
        name: "Builder",
        description:
          "Turns scoped objectives into practical implementation plans, designs, code, calculations, and build steps.",
        position: { x: 520, y: 70 },
        config: {
          role: "Implementation specialist",
          instructions:
            "Produce a concrete, technically precise implementation response. State assumptions and verify important details.",
          autoDelegate: false,
          maxOutputTokens: 1_000,
        },
      },
      {
        id: "agent-reviewer",
        kind: "agent",
        name: "Reviewer",
        description: "Checks correctness, risks, verification, and omissions.",
        position: { x: 520, y: 430 },
        config: {
          role: "Quality and risk reviewer",
          instructions:
            "Review the objective and available inputs critically. Identify concrete correctness issues, risks, and the smallest useful improvements.",
          autoDelegate: false,
          temperature: 0.1,
          maxOutputTokens: 800,
        },
      },
      {
        id: "agent-architect",
        kind: "agent",
        name: "Architect",
        description:
          "Advises on architecture, system boundaries, interfaces, data models, and scaling tradeoffs.",
        position: { x: 520, y: 250 },
        config: {
          role: "Architecture advisor",
          instructions:
            "Give short, decisive architectural advice. Name the tradeoff you are optimizing and the main risk of the recommendation.",
          autoDelegate: false,
          maxOutputTokens: 600,
        },
      },
      {
        id: "model-demo",
        kind: "model",
        name: "Built-in demo model",
        description:
          "Deterministic local simulator. Swap this node to an OpenAI-compatible llama.cpp or llama-swap endpoint for real inference.",
        position: { x: 300, y: 650 },
        config: {
          provider: "mock",
          modelId: "agentic-harness-demo",
          contextWindow: 8_192,
          estimatedMemoryMb: 512,
          idleTtlMs: 20_000,
          requestTimeoutMs: 30_000,
        },
      },
      {
        id: "capability-calculator",
        kind: "capability",
        name: "Calculator",
        description: "Evaluates bounded arithmetic expressions without executing code.",
        position: { x: 900, y: 20 },
        config: { capabilityId: "calculator", enabled: true },
      },
      {
        id: "skill-evidence",
        kind: "skill",
        name: "Evidence-first delivery",
        description: "Reusable operating guidance for verifiable work.",
        position: { x: 900, y: 160 },
        config: {
          instructions:
            "Separate observed facts from assumptions. Prefer testable outcomes and name any unresolved uncertainty.",
        },
      },
      {
        id: "skill-release",
        kind: "skill",
        name: "Release checklist",
        description: "Pre-release verification steps, loaded only when shipping.",
        position: { x: 900, y: 290 },
        config: {
          loading: "on-demand",
          summary: "Steps to verify a build before release.",
          instructions:
            "Before release: run the full test suite, verify the production build starts, check migrations are reversible, confirm the changelog, and record the exact commit released.",
        },
      },
      {
        id: "connector-mcp",
        kind: "connector",
        name: "MCP server",
        description: "Local MCP server. Enable it and discover tools to grant them to the Orchestrator.",
        position: { x: 900, y: 420 },
        config: {
          connectorType: "mcp",
          transport: "streamable-http",
          endpoint: "http://127.0.0.1:3333/mcp",
          enabled: false,
        },
      },
      {
        id: "storage-artifacts",
        kind: "storage",
        name: "Run artifacts",
        description: "Local durable output and conversation archive.",
        position: { x: 900, y: 550 },
        config: { storageType: "artifact-store", location: "artifacts" },
      },
      {
        id: "storage-memory",
        kind: "storage",
        name: "Team memory",
        description: "Local retrievable memory of decisions and outcomes across runs.",
        position: { x: 900, y: 680 },
        config: { storageType: "memory", location: "team" },
      },
      {
        id: "storage-workspace",
        kind: "storage",
        name: "Project workspace",
        description: "Files the Builder may read and write.",
        position: { x: 900, y: 810 },
        config: { storageType: "project-files", location: "project" },
      },
    ],
    edges: [
      { id: "edge-orchestrator-model", source: "agent-orchestrator", target: "model-demo", kind: "agent_uses_model" },
      { id: "edge-builder-model", source: "agent-builder", target: "model-demo", kind: "agent_uses_model" },
      { id: "edge-reviewer-model", source: "agent-reviewer", target: "model-demo", kind: "agent_uses_model" },
      { id: "edge-architect-model", source: "agent-architect", target: "model-demo", kind: "agent_uses_model" },
      {
        id: "edge-delegate-builder",
        source: "agent-orchestrator",
        target: "agent-builder",
        kind: "agent_can_delegate_to_agent",
        label: "delegate",
      },
      {
        id: "edge-review-reviewer",
        source: "agent-orchestrator",
        target: "agent-reviewer",
        kind: "agent_can_review_agent",
        label: "review",
        settings: { maxRevisions: 1 },
      },
      {
        id: "edge-consult-architect",
        source: "agent-orchestrator",
        target: "agent-architect",
        kind: "agent_can_consult_agent",
        label: "consult",
      },
      {
        id: "edge-builder-consult-architect",
        source: "agent-builder",
        target: "agent-architect",
        kind: "agent_can_consult_agent",
        label: "consult",
      },
      { id: "edge-builder-calculator", source: "agent-builder", target: "capability-calculator", kind: "agent_can_use_capability" },
      { id: "edge-builder-skill", source: "agent-builder", target: "skill-evidence", kind: "agent_can_use_skill" },
      { id: "edge-builder-release", source: "agent-builder", target: "skill-release", kind: "agent_can_use_skill" },
      { id: "edge-reviewer-skill", source: "agent-reviewer", target: "skill-evidence", kind: "agent_can_use_skill" },
      {
        id: "edge-orchestrator-storage",
        source: "agent-orchestrator",
        target: "storage-artifacts",
        kind: "agent_can_access_storage",
        permissions: { read: true, write: true, scope: "/runs" },
      },
      {
        id: "edge-builder-storage",
        source: "agent-builder",
        target: "storage-artifacts",
        kind: "agent_can_access_storage",
        permissions: { read: true, write: false, scope: "/runs" },
      },
      {
        id: "edge-orchestrator-memory",
        source: "agent-orchestrator",
        target: "storage-memory",
        kind: "agent_can_access_storage",
        permissions: { read: true, write: true, scope: "/" },
      },
      {
        id: "edge-builder-workspace",
        source: "agent-builder",
        target: "storage-workspace",
        kind: "agent_can_access_storage",
        permissions: { read: true, write: true, scope: "/" },
      },
      { id: "edge-orchestrator-connector", source: "agent-orchestrator", target: "connector-mcp", kind: "agent_can_use_connector" },
    ],
  };
  return topologySchema.parse(input);
}
