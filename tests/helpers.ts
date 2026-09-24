import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { RuntimeEngine } from "../src/server/runtime.js";
import { LocalStore } from "../src/server/store.js";
import {
  type Run,
  type Topology,
  type TopologyEdge,
  topologyNodeSchema,
} from "../src/shared/contracts.js";
import type { z } from "zod";

const temporaryDirectories: string[] = [];
const runtimes: RuntimeEngine[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

export async function tempDir(prefix = "agentic-harness-test-"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export async function harness(): Promise<{ store: LocalStore; runtime: RuntimeEngine; directory: string }> {
  const directory = await tempDir();
  const store = new LocalStore(directory);
  await store.init();
  const runtime = new RuntimeEngine(store);
  await runtime.init();
  runtimes.push(runtime);
  return { store, runtime, directory };
}

export async function terminalRun(store: LocalStore, id: string, timeoutMs = 15_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(id);
    if (run && ["completed", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${id} did not finish before the test deadline.`);
}

export function node(input: z.input<typeof topologyNodeSchema>) {
  return topologyNodeSchema.parse(input);
}

export function edge(
  id: string,
  source: string,
  target: string,
  kind: TopologyEdge["kind"],
  extra: Partial<TopologyEdge> = {},
): TopologyEdge {
  return { id, source, target, kind, ...extra };
}

export async function updateTopology(
  store: LocalStore,
  mutate: (topology: Topology) => void,
  id = "topology-local-studio",
): Promise<Topology> {
  const topology = store.getTopology(id);
  if (!topology) throw new Error(`Topology ${id} missing`);
  mutate(topology);
  return store.saveTopology(topology);
}

export function orderFor(run: Run, agentId: string) {
  return run.workOrders.filter((order) => order.assigneeAgentId === agentId);
}
