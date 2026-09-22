import { describe, expect, it } from "vitest";
import { ModelPool } from "../src/server/model-pool.js";
import type { ModelNode } from "../src/shared/contracts.js";

function mockModel(id = "model-shared"): ModelNode {
  return {
    id,
    name: "Shared mock model",
    description: "A model used to verify scheduler serialization.",
    kind: "model",
    position: { x: 0, y: 0 },
    config: {
      provider: "mock",
      modelId: id,
      baseUrl: "",
      apiKeyEnv: "",
      contextWindow: 8_192,
      estimatedMemoryMb: 512,
      idleTtlMs: 1_000,
      requestTimeoutMs: 5_000,
      lifecycle: "logical",
    },
  };
}

describe("model pool", () => {
  it("serializes requests that share one model", async () => {
    const pool = new ModelPool(2_048);
    const model = mockModel();
    let active = 0;
    let maximumActive = 0;

    const operation = async (): Promise<void> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 35));
      active -= 1;
    };

    await Promise.all([
      pool.withModel(model, "run-one", operation),
      pool.withModel(model, "run-two", operation),
    ]);

    expect(maximumActive).toBe(1);
    expect(pool.snapshot()[0]?.requestCount).toBe(2);
    expect(pool.snapshot()[0]?.state).toBe("idle");
    await pool.shutdown();
  });
});
