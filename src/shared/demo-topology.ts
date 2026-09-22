import type { Topology } from "./contracts.js";

const now = new Date().toISOString();

export function createDemoTopology(): Topology {
  return {
    version: 1,
    id: "topology-local-studio",
    name: "Local product studio",
    description:
      "A compact team that delegates implementation and review work while respecting explicit capability boundaries.",
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "agent-orchestrator",
        kind: "agent",
        name: "Orchestrator",
        description: "Plans, delegates, tracks, and integrates work.",
        position: { x: 80, y: 230 },
        config: {
          role: "Planning and integration lead",
          instructions:
            "Decompose the request into clear work, use connected specialists when they add value, and synthesize a concise final result grounded in their outputs.",
          entrypoint: true,
          autoDelegate: true,
          conversationPersistence: "connected-storage",
          temperature: 0.2,
          maxOutputTokens: 1_200,
        },
      },
      {
        id: "agent-builder",
        kind: "agent",
        name: "Builder",
        description: "Turns scoped objectives into practical implementation guidance.",
        position: { x: 520, y: 80 },
        config: {
          role: "Implementation specialist",
          instructions:
            "Produce a concrete, technically precise implementation response. State assumptions and verify important details.",
          entrypoint: false,
          autoDelegate: false,
          conversationPersistence: "connected-storage",
          temperature: 0.2,
          maxOutputTokens: 1_000,
        },
      },
      {
        id: "agent-reviewer",
        kind: "agent",
        name: "Reviewer",
        description: "Checks correctness, risks, and omissions.",
        position: { x: 520, y: 390 },
        config: {
          role: "Quality and risk reviewer",
          instructions:
            "Review the objective and available inputs critically. Identify concrete correctness issues, risks, and the smallest useful improvements.",
          entrypoint: false,
          autoDelegate: false,
          conversationPersistence: "connected-storage",
          temperature: 0.1,
          maxOutputTokens: 800,
        },
      },
      {
        id: "model-demo",
        kind: "model",
        name: "Built-in demo model",
        description:
          "Deterministic local simulator. Swap this node to an OpenAI-compatible llama.cpp or llama-swap endpoint for real inference.",
        position: { x: 300, y: 610 },
        config: {
          provider: "mock",
          modelId: "agentic-harness-demo",
          baseUrl: "http://127.0.0.1:8080/v1",
          apiKeyEnv: "",
          contextWindow: 8_192,
          estimatedMemoryMb: 512,
          idleTtlMs: 20_000,
          requestTimeoutMs: 30_000,
          lifecycle: "logical",
        },
      },
      {
        id: "capability-calculator",
        kind: "capability",
        name: "Calculator",
        description: "Evaluates bounded arithmetic expressions without executing code.",
        position: { x: 890, y: 60 },
        config: {
          capabilityId: "calculator",
          enabled: true,
        },
      },
      {
        id: "skill-evidence",
        kind: "skill",
        name: "Evidence-first delivery",
        description: "Reusable operating guidance for verifiable work.",
        position: { x: 890, y: 235 },
        config: {
          instructions:
            "Separate observed facts from assumptions. Prefer testable outcomes and name any unresolved uncertainty.",
        },
      },
      {
        id: "connector-mcp",
        kind: "connector",
        name: "MCP server",
        description: "Reserved connector boundary for a local MCP server.",
        position: { x: 890, y: 410 },
        config: {
          connectorType: "mcp",
          endpoint: "http://127.0.0.1:3333/mcp",
          authEnv: "",
          enabled: false,
        },
      },
      {
        id: "storage-artifacts",
        kind: "storage",
        name: "Run artifacts",
        description: "Local durable output and conversation archive.",
        position: { x: 890, y: 585 },
        config: {
          storageType: "artifact-store",
          location: "artifacts",
        },
      },
    ],
    edges: [
      {
        id: "edge-orchestrator-model",
        source: "agent-orchestrator",
        target: "model-demo",
        kind: "agent_uses_model",
      },
      {
        id: "edge-builder-model",
        source: "agent-builder",
        target: "model-demo",
        kind: "agent_uses_model",
      },
      {
        id: "edge-reviewer-model",
        source: "agent-reviewer",
        target: "model-demo",
        kind: "agent_uses_model",
      },
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
      },
      {
        id: "edge-builder-calculator",
        source: "agent-builder",
        target: "capability-calculator",
        kind: "agent_can_use_capability",
      },
      {
        id: "edge-builder-skill",
        source: "agent-builder",
        target: "skill-evidence",
        kind: "agent_can_use_skill",
      },
      {
        id: "edge-reviewer-skill",
        source: "agent-reviewer",
        target: "skill-evidence",
        kind: "agent_can_use_skill",
      },
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
        id: "edge-orchestrator-connector",
        source: "agent-orchestrator",
        target: "connector-mcp",
        kind: "agent_can_use_connector",
      },
    ],
  };
}
