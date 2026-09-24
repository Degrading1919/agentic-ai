import { describe, expect, it } from "vitest";
import { LocalStore } from "../src/server/store.js";
import type { Run, Topology } from "../src/shared/contracts.js";
import { harness, tempDir, terminalRun } from "./helpers.js";

/** A store whose next write(s) fail, like a full disk or a locked file. */
class FlakyStore extends LocalStore {
  failures = 0;
  protected override async writeDocument(content: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("simulated disk failure");
    }
    await super.writeDocument(content);
  }
}

async function reopen(directory: string): Promise<LocalStore> {
  const store = new LocalStore(directory);
  await store.init();
  return store;
}

describe("transactional store (audit B3)", () => {
  it("does not publish a topology that fails validation", async () => {
    const directory = await tempDir();
    const store = new LocalStore(directory);
    await store.init();
    const invalid = { ...store.getTopology("topology-local-studio")!, id: "bad", name: "" } as Topology;
    await expect(store.saveTopology(invalid)).rejects.toThrow();
    expect(store.listTopologies().map((item) => item.id)).toEqual(["topology-local-studio"]);
    expect((await reopen(directory)).listTopologies().map((item) => item.id)).toEqual(["topology-local-studio"]);
  });

  it("does not publish a run mutation that produces invalid state or throws", async () => {
    const { store, runtime } = await harness();
    const run = await terminalRun(
      store,
      (await runtime.createRun({ topologyId: "topology-local-studio", entryAgentId: "agent-orchestrator", objective: "[direct] hi" })).id,
    );
    const before = JSON.stringify(store.getRun(run.id));
    await expect(
      store.mutateRun(run.id, (draft) => {
        draft.status = "exploded" as Run["status"];
      }),
    ).rejects.toThrow();
    await expect(
      store.mutateRun(run.id, (draft) => {
        draft.result = "half-applied";
        throw new Error("callback failed midway");
      }),
    ).rejects.toThrow(/midway/);
    expect(JSON.stringify(store.getRun(run.id))).toBe(before);
  });

  it("keeps live state equal to durable state when the write fails", async () => {
    const directory = await tempDir();
    const store = new FlakyStore(directory);
    await store.init();
    const topology = store.getTopology("topology-local-studio")!;

    store.failures = 1;
    await expect(store.saveTopology({ ...topology, name: "Never persisted" })).rejects.toThrow(/simulated disk failure/);
    expect(store.getTopology(topology.id)?.name).toBe("Local product studio");

    // The next successful write must not carry the failed change along.
    await store.saveTopology({ ...topology, description: "persisted" });
    const durable = (await reopen(directory)).getTopology(topology.id)!;
    expect(durable.name).toBe("Local product studio");
    expect(durable.description).toBe("persisted");
  });

  it("serializes queued writes even when one of them fails", async () => {
    const directory = await tempDir();
    const store = new FlakyStore(directory);
    await store.init();
    const topology = store.getTopology("topology-local-studio")!;
    store.failures = 1;
    const results = await Promise.allSettled([
      store.saveTopology({ ...topology, description: "first (fails)" }),
      store.saveTopology({ ...topology, description: "second" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(store.getTopology(topology.id)?.description).toBe("second");
    expect((await reopen(directory)).getTopology(topology.id)?.description).toBe("second");
  });
});
