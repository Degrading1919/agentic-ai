import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeEngine } from "../src/server/runtime.js";
import { LocalStore } from "../src/server/store.js";
import { tempDir, terminalRun } from "./helpers.js";

/** A state document exactly as the first MVP wrote it (no fields added since). */
function legacyState() {
  const at = "2026-09-22T19:12:00.000Z";
  return {
    version: 1,
    activeTopologyId: "topology-legacy",
    topologies: [
      {
        version: 1,
        id: "topology-legacy",
        name: "Legacy studio",
        description: "",
        createdAt: at,
        updatedAt: at,
        nodes: [
          {
            id: "agent-lead",
            kind: "agent",
            name: "Lead",
            description: "Plans and integrates.",
            position: { x: 0, y: 0 },
            config: {
              role: "Lead",
              instructions: "Lead the work.",
              entrypoint: true,
              autoDelegate: true,
              conversationPersistence: "connected-storage",
              temperature: 0.2,
              maxOutputTokens: 800,
            },
          },
          {
            id: "agent-worker",
            kind: "agent",
            name: "Worker",
            description: "Builds implementation work.",
            position: { x: 0, y: 0 },
            config: {
              role: "Implementation worker",
              instructions: "Build things.",
              entrypoint: false,
              autoDelegate: false,
              conversationPersistence: "transient",
              temperature: 0.2,
              maxOutputTokens: 800,
            },
          },
          {
            id: "model-mock",
            kind: "model",
            name: "Mock",
            description: "",
            position: { x: 0, y: 0 },
            config: {
              provider: "mock",
              modelId: "mock",
              baseUrl: "http://127.0.0.1:8080/v1",
              apiKeyEnv: "",
              contextWindow: 8192,
              estimatedMemoryMb: 512,
              idleTtlMs: 20000,
              requestTimeoutMs: 30000,
              lifecycle: "logical",
            },
          },
          {
            id: "skill-old",
            kind: "skill",
            name: "Old skill",
            description: "",
            position: { x: 0, y: 0 },
            config: { instructions: "Be precise." },
          },
          {
            id: "connector-old",
            kind: "connector",
            name: "Old MCP",
            description: "",
            position: { x: 0, y: 0 },
            config: { connectorType: "mcp", endpoint: "http://127.0.0.1:3333/mcp", authEnv: "", enabled: false },
          },
        ],
        edges: [
          { id: "e1", source: "agent-lead", target: "model-mock", kind: "agent_uses_model" },
          { id: "e2", source: "agent-worker", target: "model-mock", kind: "agent_uses_model" },
          { id: "e3", source: "agent-lead", target: "agent-worker", kind: "agent_can_delegate_to_agent", label: "delegate" },
          { id: "e4", source: "agent-worker", target: "skill-old", kind: "agent_can_use_skill" },
          { id: "e5", source: "agent-lead", target: "connector-old", kind: "agent_can_use_connector" },
        ],
      },
    ],
    runs: [
      {
        id: "run-legacy",
        topologyId: "topology-legacy",
        entryAgentId: "agent-lead",
        objective: "Old objective",
        status: "completed",
        workOrders: [
          {
            id: "order-legacy",
            runId: "run-legacy",
            parentId: null,
            senderAgentId: null,
            assigneeAgentId: "agent-lead",
            objective: "Old objective",
            requiredInputs: [],
            constraints: [],
            allowedResources: [],
            dependencies: [],
            expectedOutput: "Answer",
            outputLocation: "run final result",
            priority: 100,
            status: "completed",
            returnRelationship: "root",
            returnToAgentId: null,
            result: "Old answer",
            error: null,
            createdAt: at,
            startedAt: at,
            completedAt: at,
          },
        ],
        messages: [],
        events: [],
        result: "Old answer",
        error: null,
        artifactPaths: [],
        metrics: { modelCalls: 2, toolCalls: 0, promptTokens: 100, completionTokens: 50, elapsedMs: 900 },
        createdAt: at,
        updatedAt: at,
        completedAt: at,
      },
    ],
  };
}

describe("state migration", () => {
  it("loads MVP state with defaults for every new field and keeps it runnable", async () => {
    const directory = await tempDir();
    await writeFile(path.join(directory, "state.json"), JSON.stringify(legacyState()));
    const store = new LocalStore(directory);
    await store.init();

    const topology = store.getTopology("topology-legacy")!;
    const lead = topology.nodes.find((node) => node.id === "agent-lead")!;
    const model = topology.nodes.find((node) => node.id === "model-mock")!;
    const connector = topology.nodes.find((node) => node.id === "connector-old")!;
    expect(lead.kind === "agent" && lead.config.toolExposure).toBe("auto");
    expect(model.kind === "model" && model.config.parallelSlots).toBe(1);
    expect(model.kind === "model" && model.config.artifact.path).toBe("");
    expect(connector.kind === "connector" && connector.config.transport).toBe("streamable-http");

    const legacyRun = store.getRun("run-legacy")!;
    expect(legacyRun.contextFrames).toEqual([]);
    expect(legacyRun.workOrders[0]).toMatchObject({ phase: "plan", ownerAgentId: null, blocking: true });
    expect(store.listCatalogs()).toEqual([]);

    const runtime = new RuntimeEngine(store);
    await runtime.init();
    try {
      const created = await runtime.createRun({
        topologyId: "topology-legacy",
        entryAgentId: "agent-lead",
        objective: "Build the implementation.",
        previousRunId: "run-legacy",
      });
      const run = await terminalRun(store, created.id);
      expect(run.status).toBe("completed");
      expect(run.threadId).toBe("run-legacy");
      expect(run.workOrders.map((order) => order.assigneeAgentId)).toContain("agent-worker");
    } finally {
      await runtime.shutdown();
    }
  });
});
