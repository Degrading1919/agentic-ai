import { open, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Minimal GGUF header reader (spec: ggml/docs/gguf.md). It reads only the
 * key/value metadata section, streaming through large arrays such as the
 * tokenizer vocabulary without holding them in memory.
 */

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

enum ValueType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

const scalarSize: Partial<Record<ValueType, number>> = {
  [ValueType.UINT8]: 1,
  [ValueType.INT8]: 1,
  [ValueType.UINT16]: 2,
  [ValueType.INT16]: 2,
  [ValueType.UINT32]: 4,
  [ValueType.INT32]: 4,
  [ValueType.FLOAT32]: 4,
  [ValueType.BOOL]: 1,
  [ValueType.UINT64]: 8,
  [ValueType.INT64]: 8,
  [ValueType.FLOAT64]: 8,
};

/** llama.cpp `enum llama_ftype` → conventional quantization label. */
export const fileTypeNames: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  36: "TQ1_0",
  37: "TQ2_0",
  38: "MXFP4_MOE",
};

type MetadataValue = string | number | bigint | boolean | { arrayType: number; length: number; sample: unknown[] };

class BufferedReader {
  private buffer = Buffer.alloc(0);
  private offset = 0;
  private position = 0;

  constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly chunkSize = 1 << 20,
  ) {}

  private async ensure(bytes: number): Promise<void> {
    if (this.buffer.length - this.offset >= bytes) return;
    const remaining = this.buffer.subarray(this.offset);
    const chunk = Buffer.alloc(Math.max(this.chunkSize, bytes));
    const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.position);
    this.position += bytesRead;
    this.buffer = Buffer.concat([remaining, chunk.subarray(0, bytesRead)]);
    this.offset = 0;
    if (this.buffer.length < bytes) throw new Error("Unexpected end of GGUF file.");
  }

  async u32(): Promise<number> {
    await this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  async u64(): Promise<bigint> {
    await this.ensure(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  async string(maxLength = 1 << 20): Promise<string> {
    const length = Number(await this.u64());
    if (length > maxLength) {
      await this.skip(length);
      return "";
    }
    await this.ensure(length);
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  async skip(bytes: number): Promise<void> {
    const available = this.buffer.length - this.offset;
    if (bytes <= available) {
      this.offset += bytes;
      return;
    }
    this.position += bytes - available;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
  }

  async scalar(type: ValueType): Promise<number | bigint | boolean> {
    const size = scalarSize[type];
    if (!size) throw new Error(`Unsupported GGUF value type ${type}.`);
    await this.ensure(size);
    const at = this.offset;
    this.offset += size;
    switch (type) {
      case ValueType.UINT8:
        return this.buffer.readUInt8(at);
      case ValueType.INT8:
        return this.buffer.readInt8(at);
      case ValueType.UINT16:
        return this.buffer.readUInt16LE(at);
      case ValueType.INT16:
        return this.buffer.readInt16LE(at);
      case ValueType.UINT32:
        return this.buffer.readUInt32LE(at);
      case ValueType.INT32:
        return this.buffer.readInt32LE(at);
      case ValueType.FLOAT32:
        return this.buffer.readFloatLE(at);
      case ValueType.BOOL:
        return this.buffer.readUInt8(at) !== 0;
      case ValueType.UINT64:
        return this.buffer.readBigUInt64LE(at);
      case ValueType.INT64:
        return this.buffer.readBigInt64LE(at);
      case ValueType.FLOAT64:
        return this.buffer.readDoubleLE(at);
      default:
        throw new Error(`Unsupported GGUF value type ${type}.`);
    }
  }
}

async function readValue(reader: BufferedReader, type: ValueType): Promise<MetadataValue> {
  if (type === ValueType.STRING) return reader.string();
  if (type === ValueType.ARRAY) {
    const arrayType = (await reader.u32()) as ValueType;
    const length = Number(await reader.u64());
    const sample: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (arrayType === ValueType.STRING) {
        const value = await reader.string(4_096);
        if (sample.length < 8) sample.push(value);
      } else if (arrayType === ValueType.ARRAY) {
        throw new Error("Nested GGUF arrays are not supported.");
      } else if (index < 8) {
        sample.push(await reader.scalar(arrayType));
      } else {
        await reader.skip((scalarSize[arrayType] ?? 1) * (length - index));
        break;
      }
    }
    return { arrayType, length, sample };
  }
  return reader.scalar(type);
}

export type GgufMetadata = Record<string, MetadataValue>;

export async function readGgufMetadata(filePath: string): Promise<{ version: number; tensorCount: number; metadata: GgufMetadata }> {
  const handle = await open(filePath, "r");
  try {
    const reader = new BufferedReader(handle);
    if ((await reader.u32()) !== GGUF_MAGIC) throw new Error("Not a GGUF file (bad magic).");
    const version = await reader.u32();
    if (version < 2) throw new Error(`GGUF version ${version} is not supported.`);
    const tensorCount = Number(await reader.u64());
    const kvCount = Number(await reader.u64());
    const metadata: GgufMetadata = {};
    for (let index = 0; index < kvCount; index += 1) {
      const key = await reader.string(4_096);
      const type = (await reader.u32()) as ValueType;
      metadata[key] = await readValue(reader, type);
    }
    return { version, tensorCount, metadata };
  } finally {
    await handle.close();
  }
}

function num(value: MetadataValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function str(value: MetadataValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export type ModelInspection = {
  path: string;
  fileSizeMb: number;
  ggufVersion: number;
  architecture: string;
  name: string;
  parameterLabel: string;
  quantization: string;
  trainedContextLength: number;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  baseModel: string;
  isAdapter: boolean;
  /** Estimated resident memory for the requested context (weights + f16 KV cache + overhead). */
  estimatedMemoryMb: number;
  kvCacheMb: number;
  contextWindowForEstimate: number;
};

/** KV cache bytes for an f16 cache: 2 (K,V) × layers × ctx × kv_heads × head_dim × 2 bytes. */
export function estimateKvCacheMb(input: {
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  keyLength?: number | null;
  contextWindow: number;
}): number {
  const { blockCount, embeddingLength, headCount, contextWindow } = input;
  if (!blockCount || !embeddingLength || !headCount) return 0;
  const kvHeads = input.headCountKv || headCount;
  const headDim = input.keyLength || embeddingLength / headCount;
  const bytes = 2 * blockCount * contextWindow * kvHeads * headDim * 2;
  return Math.round(bytes / 1024 / 1024);
}

export async function inspectGguf(filePath: string, contextWindow = 8_192): Promise<ModelInspection> {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== ".gguf") throw new Error("Only .gguf files can be inspected.");
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Model path is not a file.");
  const { version, metadata } = await readGgufMetadata(resolved);
  const architecture = str(metadata["general.architecture"]);
  const key = (suffix: string) => metadata[`${architecture}.${suffix}`];
  const fileType = num(metadata["general.file_type"]);
  const blockCount = num(key("block_count"));
  const embeddingLength = num(key("embedding_length"));
  const headCount = num(key("attention.head_count"));
  const headCountKv = num(key("attention.head_count_kv"));
  const keyLength = num(key("attention.key_length"));
  const trained = num(key("context_length")) ?? 0;
  const window = Math.max(512, Math.min(contextWindow, trained || contextWindow));
  const kvCacheMb = estimateKvCacheMb({ blockCount, embeddingLength, headCount, headCountKv, keyLength, contextWindow: window });
  const fileSizeMb = Math.round(info.size / 1024 / 1024);
  const baseModel = [str(metadata["general.base_model.0.name"]), str(metadata["general.base_model.0.organization"])]
    .filter(Boolean)
    .join(" · ");
  return {
    path: resolved,
    fileSizeMb,
    ggufVersion: version,
    architecture,
    name: str(metadata["general.name"]) || str(metadata["general.basename"]) || path.basename(resolved, ".gguf"),
    parameterLabel: str(metadata["general.size_label"]),
    quantization: fileType === null ? "" : (fileTypeNames[fileType] ?? `type ${fileType}`),
    trainedContextLength: trained,
    blockCount,
    embeddingLength,
    headCount,
    headCountKv,
    baseModel,
    isAdapter: str(metadata["general.type"]) === "adapter",
    estimatedMemoryMb: fileSizeMb + kvCacheMb + 256,
    kvCacheMb,
    contextWindowForEstimate: window,
  };
}
