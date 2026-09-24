import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { harness, terminalRun, updateTopology } from "./helpers.js";

describe("local runtime", () => {
  it("executes orchestrator-to-specialist work and persists artifacts", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Calculate 72 * 18 and propose a verification plan.",
    });
    const run = await terminalRun(store, created.id);

    expect(run.status).toBe("completed");
    expect(run.workOrders).toHaveLength(3);
    expect(run.workOrders.every((order) => order.status === "completed")).toBe(true);
    expect(run.metrics.modelCalls).toBeGreaterThanOrEqual(4);
    expect(run.metrics.toolCalls).toBe(1);
    expect(run.result).toContain("1296");
    // Artifacts exist the moment the run is observed as completed.
    expect(run.artifactPaths).toHaveLength(2);
    expect(await readFile(run.artifactPaths[0]!, "utf8")).toContain("1296");
  });

  it("does not expose an unconnected capability", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.edges = topology.edges.filter((edge) => edge.id !== "edge-builder-calculator");
    });

    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Calculate 72 * 18.",
    });
    const run = await terminalRun(store, created.id);

    expect(run.status).toBe("completed");
    expect(run.metrics.toolCalls).toBe(0);
    expect(run.result).not.toContain("1296");
  });

  it("pauses without losing state and resumes remaining work", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Prepare a small implementation brief and review its risks.",
    });
    const paused = await runtime.pauseRun(created.id);
    expect(paused.status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(store.getRun(created.id)?.status).toBe("paused");

    await runtime.resumeRun(created.id);
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    expect(run.events.some((item) => item.type === "run_paused")).toBe(true);
    expect(run.events.some((item) => item.type === "run_resumed")).toBe(true);
    expect(run.workOrders.every((order) => order.status === "completed")).toBe(true);
  });

  it("recovers queued work after a restart", async () => {
    const { store, runtime, directory } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[direct] Summarize the plan.",
    });
    await runtime.pauseRun(created.id);
    await runtime.shutdown();

    const { LocalStore } = await import("../src/server/store.js");
    const { RuntimeEngine } = await import("../src/server/runtime.js");
    const reopened = new LocalStore(directory);
    await reopened.init();
    const restarted = new RuntimeEngine(reopened);
    await restarted.init();
    try {
      expect(reopened.getRun(created.id)?.status).toBe("paused");
      await restarted.resumeRun(created.id);
      const run = await terminalRun(reopened, created.id);
      expect(run.status).toBe("completed");
    } finally {
      await restarted.shutdown();
    }
  });
});
