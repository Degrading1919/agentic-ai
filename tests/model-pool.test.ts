import { describe, expect, it } from "vitest";
import { ModelPool } from "../src/server/model-pool.js";
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
