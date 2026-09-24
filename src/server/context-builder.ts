import { createHash, randomUUID } from "node:crypto";
import type {
  AgentNode,
  ChatMessage,
  ContextFrame,
  ModelNode,
} from "../shared/contracts.js";
import type { PromptSegment, StablePrefix } from "../shared/prompt.js";
import { segment } from "../shared/prompt.js";
import { MESSAGE_OVERHEAD_TOKENS, estimateTokens, truncateToTokens } from "../shared/tokens.js";

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * A dynamic segment may offer a compact alternative (for example summaries
 * instead of full specialist results) that the packer uses before truncating.
 */
export type DynamicSegment = PromptSegment & {
  compact?: string;
  /** Lower numbers are trimmed first. The work order itself is never dropped. */
  trimPriority: number;
};

export function dynamicSegment(
  kind: PromptSegment["kind"],
  label: string,
  text: string,
  trimPriority: number,
  compact?: string,
): DynamicSegment {
  return { ...segment(kind, label, text, false), trimPriority, compact };
}

export type PackedContext = {
  messages: ChatMessage[];
  segments: PromptSegment[];
  trimmedLabels: string[];
  stablePrefixTokens: number;
  availableTokens: number;
};

const SAFETY_MARGIN = 64;

/**
 * Assemble one request: the stable prefix first (system message and tool
 * schemas, byte-identical across calls), then the dynamic work-order payload.
 * The payload is fitted to the model window deterministically.
 */
export function packContext(
  prefix: StablePrefix,
  dynamic: DynamicSegment[],
  model: ModelNode,
  agent: AgentNode,
): PackedContext {
  const window = model.config.contextWindow;
  const reserved = Math.min(agent.config.maxOutputTokens, Math.floor(window / 2));
  const stablePrefixTokens =
    prefix.segments.reduce((sum, item) => sum + item.tokens, 0) + MESSAGE_OVERHEAD_TOKENS;
  const availableTokens = window - reserved - SAFETY_MARGIN - stablePrefixTokens - MESSAGE_OVERHEAD_TOKENS;

  if (availableTokens <= 0) {
    const heaviest = [...prefix.segments]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map((item) => `${item.label} ≈${item.tokens}`)
      .join(", ");
    throw new ContextBudgetError(
      `Agent '${agent.name}' needs ≈${stablePrefixTokens} tokens of stable context, which leaves no room in ${model.name}'s ${window}-token window after reserving ${reserved} output tokens. Heaviest: ${heaviest}. Reduce connected tools (or use deferred exposure), skills, or instructions.`,
    );
  }

  const working = dynamic.map((item) => ({ ...item }));
  const total = () => working.reduce((sum, item) => sum + item.tokens, 0);
  const trimmedLabels: string[] = [];

  // Pass 1: swap in compact forms, lowest priority first.
  for (const item of [...working].sort((a, b) => a.trimPriority - b.trimPriority)) {
    if (total() <= availableTokens) break;
    if (item.compact !== undefined && item.compact !== item.text) {
      item.text = item.compact;
      item.tokens = estimateTokens(item.compact);
      item.trimmed = true;
      trimmedLabels.push(item.label);
    }
  }
  // Pass 2: truncate, lowest priority first.
  for (const item of [...working].sort((a, b) => a.trimPriority - b.trimPriority)) {
    const excess = total() - availableTokens;
    if (excess <= 0) break;
    const target = Math.max(0, item.tokens - excess);
    const minimum = item.kind === "work_order" ? Math.min(item.tokens, 200) : 0;
    const truncated = truncateToTokens(item.text, Math.max(target, minimum));
    if (truncated.trimmed) {
      item.text = truncated.text;
      item.tokens = estimateTokens(truncated.text);
      item.trimmed = true;
      if (!trimmedLabels.includes(item.label)) trimmedLabels.push(item.label);
    }
  }

  const present = working.filter((item) => item.text.trim().length > 0);
  const user = present.map((item) => item.text).join("\n\n");
  return {
    messages: [
      { role: "system", content: prefix.system },
      { role: "user", content: user },
    ],
    segments: [...prefix.segments, ...present],
    trimmedLabels,
    stablePrefixTokens,
    availableTokens,
  };
}

/** Estimate tokens for the tool-loop tail appended after the packed context. */
export function toolTailTokens(messages: ChatMessage[], initialCount: number): number {
  return messages.slice(initialCount).reduce((sum, message) => {
    const calls = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
    return sum + estimateTokens(message.content ?? "") + estimateTokens(calls) + MESSAGE_OVERHEAD_TOKENS;
  }, 0);
}

export function buildFrame(input: {
  workOrderId: string;
  agentId: string;
  model: ModelNode;
  agent: AgentNode;
  purpose: ContextFrame["purpose"];
  packed: PackedContext;
  prefix: StablePrefix;
  tailTokens: number;
  prefixReused: boolean;
  sendTools: boolean;
}): ContextFrame {
  const segments = input.packed.segments
    .filter((item) => input.sendTools || item.kind !== "tool_schemas")
    .map((item) => ({
      kind: item.kind,
      label: item.label,
      tokens: item.tokens,
      stable: item.stable,
      trimmed: Boolean(item.trimmed),
    }));
  if (input.tailTokens > 0) {
    segments.push({
      kind: "tool_results",
      label: "Tool calls and results",
      tokens: input.tailTokens,
      stable: false,
      trimmed: false,
    });
  }
  const estimatedPromptTokens =
    segments.reduce((sum, item) => sum + item.tokens, 0) + MESSAGE_OVERHEAD_TOKENS * 2;
  return {
    id: randomUUID(),
    workOrderId: input.workOrderId,
    agentId: input.agentId,
    modelId: input.model.id,
    purpose: input.purpose,
    segments,
    estimatedPromptTokens,
    stablePrefixTokens: segments.filter((item) => item.stable).reduce((sum, item) => sum + item.tokens, 0),
    contextWindow: input.model.config.contextWindow,
    reservedOutputTokens: input.agent.config.maxOutputTokens,
    prefixHash: sha(input.prefix.system),
    toolsHash: sha(input.sendTools ? JSON.stringify(input.prefix.tools) : "[]"),
    prefixReused: input.prefixReused,
    exposure: input.prefix.exposure.mode,
    authorizedTools: input.prefix.descriptors.length,
    exposedToolSchemas: input.sendTools ? input.prefix.exposure.native.length : 0,
    actualPromptTokens: null,
    cachedPromptTokens: null,
    createdAt: new Date().toISOString(),
  };
}

/** Extractive digest for completed work; no extra inference. */
export function summarize(text: string, maxTokens = 120): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "[code omitted]").trim();
  const paragraphs = withoutCode.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const picked: string[] = [];
  for (const paragraph of paragraphs) {
    picked.push(paragraph);
    if (estimateTokens(picked.join("\n\n")) >= maxTokens) break;
  }
  const digest = picked.join("\n\n");
  const truncated = truncateToTokens(digest, maxTokens);
  return truncated.trimmed ? truncated.text.replace(/\n\[…trimmed to fit the context budget\]$/, " …") : digest;
}
