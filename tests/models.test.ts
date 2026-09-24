import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateKvCacheMb, inspectGguf } from "../src/server/gguf.js";
import { parseNvidiaSmi, vramBudgetFrom } from "../src/server/hardware.js";
import { generateLlamaSwapConfig } from "../src/server/llama-swap.js";
import { createDemoTopology } from "../src/shared/demo-topology.js";
import { node, tempDir } from "./helpers.js";

type Value = { type: number; value: unknown };

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function str(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function encode({ type, value }: Value): Buffer {
  switch (type) {
    case 4:
      return u32(value as number);
    case 8:
      return str(value as string);
    case 9: {
      const items = value as string[];
      return Buffer.concat([u32(8), u64(items.length), ...items.map(str)]);
    }
    default:
      throw new Error(`unsupported ${type}`);
  }
}

async function writeGguf(file: string, metadata: Record<string, Value>): Promise<void> {
  const entries = Object.entries(metadata);
  const parts = [Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(entries.length)];
  for (const [key, value] of entries) parts.push(str(key), u32(value.type), encode(value));
  parts.push(Buffer.alloc(1024)); // stand-in for tensor data
  await writeFile(file, Buffer.concat(parts));
}

describe("GGUF inspection", () => {
  it("reads architecture, quantization, lineage, and memory estimates", async () => {
    const file = path.join(await tempDir(), "specialist-3b.Q4_K_M.gguf");
    await writeGguf(file, {
      "general.architecture": { type: 8, value: "llama" },
      "general.name": { type: 8, value: "Runtime Coder" },
      "general.size_label": { type: 8, value: "3B" },
      "general.file_type": { type: 4, value: 15 },
      "general.base_model.0.name": { type: 8, value: "Llama 3.2 3B Instruct" },
      "llama.context_length": { type: 4, value: 131_072 },
      "llama.block_count": { type: 4, value: 28 },
      "llama.embedding_length": { type: 4, value: 3_072 },
      "llama.attention.head_count": { type: 4, value: 24 },
      "llama.attention.head_count_kv": { type: 4, value: 8 },
      // A large vocabulary array must be streamed past, not loaded.
      "tokenizer.ggml.tokens": { type: 9, value: Array.from({ length: 50_000 }, (_, index) => `tok${index}`) },
    });
    const inspection = await inspectGguf(file, 8_192);
    expect(inspection).toMatchObject({
      architecture: "llama",
      name: "Runtime Coder",
      parameterLabel: "3B",
      quantization: "Q4_K_M",
      trainedContextLength: 131_072,
      blockCount: 28,
      headCountKv: 8,
      baseModel: "Llama 3.2 3B Instruct",
      isAdapter: false,
      contextWindowForEstimate: 8_192,
    });
    // 2 × 28 layers × 8192 ctx × 8 kv-heads × 128 dim × 2 bytes = 896 MiB
    expect(inspection.kvCacheMb).toBe(896);
    // Server-default offload is treated as full offload: weights + KV on the GPU (audit A6).
    expect(inspection.offloadedLayers).toBe(28);
    expect(inspection.estimatedVramMb).toBe(inspection.fileSizeMb + 896 + 384);
    expect(inspection.estimatedMemoryMb).toBe(256);
    expect(inspection.assumptions).toMatch(/Estimates, not measurements/);

    // Partial offload splits weights and KV cache; parallel slots multiply the KV cache.
    const partial = await inspectGguf(file, 8_192, { gpuLayers: 14, parallelSlots: 2 });
    expect(partial.kvContextTokens).toBe(16_384);
    expect(partial.kvCacheMb).toBe(1_792);
    expect(partial.estimatedVramMb).toBe(Math.round((partial.fileSizeMb + 1_792) / 2 + 384));
    expect(partial.estimatedMemoryMb).toBe(Math.round((partial.fileSizeMb + 1_792) / 2 + 256));

    const cpuOnly = await inspectGguf(file, 8_192, { gpuLayers: 0 });
    expect(cpuOnly.estimatedVramMb).toBe(0);
    expect(cpuOnly.estimatedMemoryMb).toBe(cpuOnly.fileSizeMb + 896 + 256);
  });

  it("rejects non-GGUF input", async () => {
    const directory = await tempDir();
    const bogus = path.join(directory, "bogus.gguf");
    await writeFile(bogus, "not a model");
    await expect(inspectGguf(bogus)).rejects.toThrow(/magic/);
    await expect(inspectGguf(path.join(directory, "model.bin"))).rejects.toThrow(/\.gguf/);
  });

  it("estimates KV cache from grouped-query attention dimensions", () => {
    expect(
      estimateKvCacheMb({ blockCount: 32, embeddingLength: 4_096, headCount: 32, headCountKv: 8, contextWindow: 4_096 }),
    ).toBe(512);
    expect(estimateKvCacheMb({ blockCount: null, embeddingLength: null, headCount: null, headCountKv: null, contextWindow: 1 })).toBe(0);
  });
});

describe("llama-swap configuration", () => {
  it("emits one entry per llama-swap managed artifact", () => {
    const topology = createDemoTopology();
    topology.nodes.push(
      node({
        id: "model-coder",
        kind: "model",
        name: "Runtime coder",
        position: { x: 0, y: 0 },
        config: {
          provider: "openai-compatible",
          modelId: "runtime-coder",
          lifecycle: "llama-swap",
          contextWindow: 16_384,
          parallelSlots: 2,
          idleTtlMs: 120_000,
          artifact: {
            path: "/models/runtime-coder.Q4_K_M.gguf",
            baseModel: "Qwen2.5 Coder 3B",
            version: "v3",
            gpuLayers: 99,
            adapters: [{ path: "/models/style.lora.gguf", scale: 0.5 }],
          },
        },
      }),
    );
    const { yaml, included, skipped } = generateLlamaSwapConfig(topology);
    expect(included).toEqual(["Runtime coder"]);
    expect(skipped.map((entry) => entry.model)).toContain("Built-in demo model");
    expect(yaml).toContain("  runtime-coder:");
    expect(yaml).toContain("llama-server --port ${PORT} -m /models/runtime-coder.Q4_K_M.gguf -c 32768 --parallel 2 --alias runtime-coder -ngl 99 --lora-scaled /models/style.lora.gguf 0.5");
    expect(yaml).toContain("    ttl: 120");
  });
});

describe("hardware telemetry", () => {
  it("parses nvidia-smi CSV output", () => {
    const devices = parseNvidiaSmi("0, NVIDIA GeForce RTX 5070 Laptop GPU, 8151, 463, 6, 48\n1, Other, 12288, [N/A], [N/A], [N/A]\n");
    expect(devices).toHaveLength(1);
    expect(devices[0]).toEqual({
      index: 0,
      name: "NVIDIA GeForce RTX 5070 Laptop GPU",
      totalVramMb: 8151,
      usedVramMb: 463,
      utilizationPercent: 6,
      temperatureC: 48,
    });
  });

  it("derives a VRAM budget only when a GPU is known", () => {
    expect(vramBudgetFrom({ available: false, reason: "none" })).toBeNull();
    expect(
      vramBudgetFrom({
        available: true,
        source: "nvidia-smi",
        capturedAt: "",
        devices: [{ index: 0, name: "g", totalVramMb: 8_000, usedVramMb: 0, utilizationPercent: null, temperatureC: null }],
      }),
    ).toBe(7_200);
  });
});
