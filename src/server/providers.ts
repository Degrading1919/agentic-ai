import { createHash, randomUUID } from "node:crypto";
import type {
  CompletionRequest,
  CompletionResult,
  ModelNode,
  ToolCall,
} from "../shared/contracts.js";
import { estimateTokens } from "../shared/tokens.js";
import { mockCompletion } from "./mock-provider.js";

type OpenAIResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** llama.cpp server extension. */
  timings?: { cache_n?: number; prompt_n?: number };
  error?: { message?: string };
};

function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

function apiUrl(model: ModelNode, pathname: string): string {
  const base = model.config.baseUrl.replace(/\/+$/, "");
  return `${base}/${pathname.replace(/^\/+/, "")}`;
}

function requestHeaders(model: ModelNode): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const envName = model.config.apiKeyEnv.trim();
  if (envName) {
    const key = process.env[envName];
    if (!key) throw new Error(`Model '${model.name}' expects API key environment variable ${envName}.`);
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function fetchOpenAICompletion(
  request: CompletionRequest,
  includeResponseFormat: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: request.model.config.modelId,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
    })),
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream: false,
  };
  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  if (request.jsonSchema && includeResponseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "agentic_harness_response",
        strict: true,
        schema: request.jsonSchema,
      },
    };
  }

  const timeout = AbortSignal.timeout(request.model.config.requestTimeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  return fetch(apiUrl(request.model, "chat/completions"), {
    method: "POST",
    headers: requestHeaders(request.model),
    body: JSON.stringify(body),
    signal,
  });
}

async function openAICompatibleCompletion(
  request: CompletionRequest,
): Promise<CompletionResult> {
  let response = await fetchOpenAICompletion(request, true);
  if (!response.ok && request.jsonSchema && [400, 404, 422].includes(response.status)) {
    response = await fetchOpenAICompletion(request, false);
  }
  const text = await response.text();
  let payload: OpenAIResponse;
  try {
    payload = JSON.parse(text) as OpenAIResponse;
  } catch {
    throw new Error(
      `Model endpoint returned ${response.status} with a non-JSON response: ${text.slice(0, 300)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      payload.error?.message ?? `Model endpoint returned HTTP ${response.status}.`,
    );
  }

  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("Model endpoint returned no completion choice.");
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (!name) return [];
    return [
      {
        id: call.id ?? `call_${randomUUID()}`,
        type: "function" as const,
        function: {
          name,
          arguments: call.function?.arguments ?? "{}",
        },
      },
    ];
  });
  const content = normalizeContent(message.content);
  return {
    content,
    toolCalls,
    usage: {
      promptTokens: payload.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(request.messages)),
      completionTokens: payload.usage?.completion_tokens ?? estimateTokens(content),
      cachedPromptTokens:
        payload.usage?.prompt_tokens_details?.cached_tokens ?? payload.timings?.cache_n ?? null,
      estimated: payload.usage?.prompt_tokens === undefined,
    },
  };
}

/**
 * Hash of everything in a request that precedes the dynamic messages, as the
 * server receives it: provider, endpoint, model, system message, tools that
 * are actually sent, and any JSON response schema. Two requests with equal
 * hashes share a byte-identical prefix; whether the backend reuses its cache
 * is only known from server-reported cached tokens.
 */
export function requestPrefixHash(request: Pick<CompletionRequest, "model" | "messages" | "tools" | "jsonSchema">): string {
  const system = request.messages.find((message) => message.role === "system")?.content ?? "";
  const payload = JSON.stringify([
    request.model.config.provider,
    request.model.config.baseUrl,
    request.model.config.modelId,
    system,
    request.jsonSchema ? null : (request.tools ?? []),
    request.jsonSchema ?? null,
  ]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  if (request.signal?.aborted) throw new DOMException("Run paused", "AbortError");
  if (request.model.config.provider === "mock") {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 120);
      request.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Run paused", "AbortError"));
        },
        { once: true },
      );
    });
    return mockCompletion(request);
  }
  return openAICompatibleCompletion(request);
}

export async function testModelConnection(model: ModelNode): Promise<{
  ok: boolean;
  message: string;
  models?: string[];
}> {
  if (model.config.provider === "mock") {
    return { ok: true, message: "Built-in deterministic provider is ready.", models: [model.config.modelId] };
  }

  try {
    const response = await fetch(apiUrl(model, "models"), {
      headers: requestHeaders(model),
      signal: AbortSignal.timeout(Math.min(model.config.requestTimeoutMs, 10_000)),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, message: `Endpoint returned HTTP ${response.status}: ${text.slice(0, 240)}` };
    }
    const payload = JSON.parse(text) as { data?: Array<{ id?: string }> };
    const models = (payload.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : []));
    return {
      ok: true,
      message: models.includes(model.config.modelId)
        ? `Connected; '${model.config.modelId}' is available.`
        : `Connected; requested model was not listed, but the endpoint is healthy.`,
      models,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestLlamaSwapUnload(model: ModelNode): Promise<void> {
  if (model.config.provider !== "openai-compatible" || model.config.lifecycle !== "llama-swap") {
    return;
  }
  const baseV1 = model.config.baseUrl.replace(/\/+$/, "");
  const root = baseV1.endsWith("/v1") ? baseV1.slice(0, -3) : baseV1;
  const response = await fetch(
    `${root}/api/models/unload/${encodeURIComponent(model.config.modelId)}`,
    {
      method: "POST",
      headers: requestHeaders(model),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`llama-swap unload returned HTTP ${response.status}.`);
  }
}
