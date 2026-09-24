import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { ModelPool, modelPoolKey } from "../src/server/model-pool.js";
import { type ModelNode, modelNodeSchema } from "../src/shared/contracts.js";

function mockModel(id = "model-shared", config: Partial<ModelNode["config"]> = {}): ModelNode {
  return modelNodeSchema.parse({
    id,
    name: `Mock ${id}`,
    description: "A model used to verify scheduler behaviour.",
    kind: "model",
    position: { x: 0, y: 0 },
    config: {
      provider: "mock",
      modelId: id,
      baseUrl: "",
      estimatedMemoryMb: 512,
      idleTtlMs: 1_000,
      requestTimeoutMs: 5_000,
      ...config,
    },
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tracker() {
  let active = 0;
  let maximum = 0;
  return {
    get maximum() {
      return maximum;
    },
    operation: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await pause(35);
      active -= 1;
    },
  };
}

describe("model pool", () => {
  it("serializes requests that share one single-slot model", async () => {
    const pool = new ModelPool(2_048);
    const model = mockModel();
    const probe = tracker();

    await Promise.all([
      pool.withModel(model, "run-one", probe.operation),
      pool.withModel(model, "run-two", probe.operation),
    ]);

    expect(probe.maximum).toBe(1);
    expect(pool.snapshot()[0]?.requestCount).toBe(2);
    expect(pool.snapshot()[0]?.state).toBe("idle");
    await pool.shutdown();
  });

  it("runs concurrent requests up to the model's parallel slots", async () => {
    const pool = new ModelPool(2_048);
    const model = mockModel("model-parallel", { parallelSlots: 2 });
    const probe = tracker();

    await Promise.all([1, 2, 3].map((index) => pool.withModel(model, `run-${index}`, probe.operation)));

    expect(probe.maximum).toBe(2);
    await pool.shutdown();
  });

  it("waits for capacity instead of failing when the budget is exhausted", async () => {
    // Budget fits one model at a time: the second request must wait, then evict.
    const pool = new ModelPool(600);
    const first = mockModel("model-a");
    const second = mockModel("model-b");
    const order: string[] = [];

    await Promise.all([
      pool.withModel(first, "run-a", async () => {
        order.push("a:start");
        await pause(60);
        order.push("a:end");
      }),
      pause(5).then(() =>
        pool.withModel(second, "run-b", async () => {
          order.push("b:start");
        }),
      ),
    ]);

    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    const states = Object.fromEntries(pool.snapshot().map((state) => [state.modelId, state.state]));
    expect(states["model-a"]).toBe("unloaded");
    expect(states["model-b"]).toBe("idle");
    await pool.shutdown();
  });

  it("enforces the VRAM budget separately from RAM", async () => {
    const pool = new ModelPool(16_000, undefined, 6_000);
    const big = mockModel("model-big", { estimatedMemoryMb: 1_000, estimatedVramMb: 5_000 });
    const other = mockModel("model-other", { estimatedMemoryMb: 1_000, estimatedVramMb: 3_000 });

    await pool.withModel(big, "run", async () => undefined);
    expect(pool.canStartNow(other)).toBe(true); // idle big model can be evicted
    await pool.withModel(other, "run", async () => undefined);
    const states = Object.fromEntries(pool.snapshot().map((state) => [state.modelId, state.state]));
    expect(states["model-big"]).toBe("unloaded");

    const tooLarge = mockModel("model-huge", { estimatedVramMb: 7_000 });
    await expect(pool.withModel(tooLarge, "run", async () => undefined)).rejects.toThrow(/VRAM budget/);
    await pool.shutdown();
  });

  it("reports whether a model can start without waiting", async () => {
    const pool = new ModelPool(700);
    const first = mockModel("model-a");
    const second = mockModel("model-b");
    let release = () => {};
    const busy = pool.withModel(first, "run", () => new Promise<void>((resolve) => { release = resolve; }));
    await pause(40);
    expect(pool.canStartNow(first)).toBe(false); // single slot occupied
    expect(pool.canStartNow(second)).toBe(false); // cannot evict an executing model
    release();
    await busy;
    expect(pool.canStartNow(second)).toBe(true);
    await pool.shutdown();
  });
});

describe("residency accounting follows configuration (audit A6)", () => {
  const key = (topology: string, id: string) => modelPoolKey(topology, id);

  it("re-accounts an idle resident model when its saved configuration changes", async () => {
    const pool = new ModelPool(4_096);
    await pool.withModel(mockModel("m", { estimatedMemoryMb: 512 }), "run", async () => undefined, undefined, key("t", "m"));
    expect(pool.snapshot()[0]).toMatchObject({ estimatedMemoryMb: 512, state: "idle" });

    await pool.reconcile("t", [{ key: key("t", "m"), model: mockModel("m", { estimatedMemoryMb: 900 }) }]);
    // The old residency was released and the numbers describe the saved configuration.
    expect(pool.snapshot()[0]).toMatchObject({ estimatedMemoryMb: 900, state: "unloaded", reconfigurePending: false });
    await pool.withModel(mockModel("m", { estimatedMemoryMb: 900 }), "run", async () => undefined, undefined, key("t", "m"));
    expect(pool.snapshot()[0]).toMatchObject({ estimatedMemoryMb: 900, state: "idle" });
    await pool.shutdown();
  });

  it("never runs a request under stale accounting while the old configuration is busy", async () => {
    const pool = new ModelPool(4_096);
    const k = key("t", "m");
    let release = () => {};
    const events: string[] = [];
    const oldRequest = pool.withModel(
      mockModel("m", { estimatedMemoryMb: 512, parallelSlots: 2 }),
      "run",
      () => new Promise<void>((resolve) => {
        events.push("old:start");
        release = () => {
          events.push("old:end");
          resolve();
        };
      }),
      undefined,
      k,
    );
    await pause(40);
    await pool.reconcile("t", [{ key: k, model: mockModel("m", { estimatedMemoryMb: 900, parallelSlots: 2 }) }]);
    expect(pool.snapshot()[0]).toMatchObject({ reconfigurePending: true, estimatedMemoryMb: 512 });

    // A new request with the new configuration waits for the old one to drain, despite a free slot.
    const newRequest = pool.withModel(
      mockModel("m", { estimatedMemoryMb: 900, parallelSlots: 2 }),
      "run",
      async () => {
        events.push(`new:start@${pool.snapshot()[0]?.estimatedMemoryMb}`);
      },
      undefined,
      k,
    );
    await pause(40);
    expect(events).toEqual(["old:start"]);
    release();
    await Promise.all([oldRequest, newRequest]);
    expect(events).toEqual(["old:start", "old:end", "new:start@900"]);
    expect(pool.snapshot()[0]).toMatchObject({ estimatedMemoryMb: 900, reconfigurePending: false });
    await pool.shutdown();
  });

  it("accounts an unknown VRAM estimate as the whole GPU budget", async () => {
    const pool = new ModelPool(16_000, undefined, 7_000);
    const gpuModel = (id: string) =>
      mockModel(id, { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", estimatedMemoryMb: 1_000, estimatedVramMb: null });
    const order: string[] = [];
    await Promise.all([
      pool.withModel(gpuModel("a"), "run", async () => {
        order.push("a:start");
        await pause(50);
        order.push("a:end");
      }, undefined, key("t", "a")),
      pause(5).then(() =>
        pool.withModel(gpuModel("b"), "run", async () => {
          order.push("b:start");
        }, undefined, key("t", "b")),
      ),
    ]);
    // Two models with unknown VRAM never co-reside on the GPU.
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    const states = pool.snapshot();
    expect(states.every((state) => state.estimatedVramMb === 7_000 && state.vramEstimateKnown === false)).toBe(true);
    expect(states.every((state) => state.residencyControl === "logical")).toBe(true);

    // An explicit zero is CPU-only and does not reserve the GPU.
    expect(pool.vramFor(mockModel("c", { provider: "openai-compatible", estimatedVramMb: 0 }))).toEqual({ mb: 0, known: true });
    await pool.shutdown();
  });

  it("unloads the previously loaded llama-swap model when the configuration changes", async () => {
    const unloads: string[] = [];
    const server = createServer((request, response) => {
      unloads.push(request.url ?? "");
      response.writeHead(200).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const pool = new ModelPool(8_000);
      const swap = (modelId: string) =>
        mockModel("m", {
          provider: "openai-compatible",
          lifecycle: "llama-swap",
          modelId,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          estimatedVramMb: 0,
        });
      await pool.withModel(swap("coder-v1"), "run", async () => undefined, undefined, key("t", "m"));
      expect(pool.snapshot()[0]?.residencyControl).toBe("llama-swap");
      await pool.reconcile("t", [{ key: key("t", "m"), model: swap("coder-v2") }]);
      expect(unloads).toEqual(["/api/models/unload/coder-v1"]);
      await pool.shutdown();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("tracks the same model node ID in different topologies independently", async () => {
    const pool = new ModelPool(4_096);
    await pool.withModel(mockModel("model-demo", { estimatedMemoryMb: 512 }), "run", async () => undefined, undefined, key("one", "model-demo"));
    await pool.withModel(mockModel("model-demo", { estimatedMemoryMb: 700 }), "run", async () => undefined, undefined, key("two", "model-demo"));
    const byKey = Object.fromEntries(pool.snapshot().map((state) => [state.modelId, state.estimatedMemoryMb]));
    expect(byKey).toEqual({ "one/model-demo": 512, "two/model-demo": 700 });
    // Saving topology "one" without the model retires only its entry.
    await pool.reconcile("one", []);
    expect(pool.snapshot().map((state) => state.modelId)).toEqual(["two/model-demo"]);
    await pool.shutdown();
  });
});
