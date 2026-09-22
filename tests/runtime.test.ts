import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run } from "../src/shared/contracts.js";
import { RuntimeEngine } from "../src/server/runtime.js";
import { LocalStore } from "../src/server/store.js";

const temporaryDirectories: string[] = [];

async function harness(): Promise<{ store: LocalStore; runtime: RuntimeEngine; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentic-harness-test-"));
  temporaryDirectories.push(directory);
  const store = new LocalStore(directory);
  await store.init();
  const runtime = new RuntimeEngine(store);
  await runtime.init();
  return { store, runtime, directory };
}

async function terminalRun(store: LocalStore, id: string): Promise<Run> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const run = store.getRun(id);
    if (run && ["completed", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not finish before the test deadline.`);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

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
    expect(run.artifactPaths).toHaveLength(2);
    expect(await readFile(run.artifactPaths[0], "utf8")).toContain("1296");
    await runtime.shutdown();
  });

  it("does not expose an unconnected capability", async () => {
    const { store, runtime } = await harness();
    const topology = store.getTopology("topology-local-studio")!;
    topology.edges = topology.edges.filter(
      (edge) => edge.id !== "edge-builder-calculator",
    );
    await store.saveTopology(topology);

    const created = await runtime.createRun({
      topologyId: topology.id,
      entryAgentId: "agent-orchestrator",
      objective: "Calculate 72 * 18.",
    });
    const run = await terminalRun(store, created.id);

    expect(run.status).toBe("completed");
    expect(run.metrics.toolCalls).toBe(0);
    expect(run.result).not.toContain("calculator returned 1296");
    await runtime.shutdown();
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
    await runtime.shutdown();
  });
});
