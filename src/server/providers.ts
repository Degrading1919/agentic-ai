import { randomUUID } from "node:crypto";
import type {
  CompletionRequest,
  CompletionResult,
  ModelNode,
  ToolCall,
} from "../shared/contracts.js";

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
  };
  error?: { message?: string };
};

function roughTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

function lastUserText(request: CompletionRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function mockCompletion(request: CompletionRequest): CompletionResult {
  const prompt = lastUserText(request);
  const toolResult = [...request.messages]
    .reverse()
    .find((message) => message.role === "tool")?.content;

  if (request.jsonSchema) {
    const candidates = prompt
      .split("\n")
      .filter((line) => line.startsWith("CANDIDATE|"))
      .map((line) => {
        const [, agentId, name, relationship, role] = line.split("|");
        return { agentId, name, relationship, role };
      });
    const content = JSON.stringify({
      delegations: candidates.map((candidate) => ({
        agentId: candidate.agentId,
        objective: `Address the request as ${candidate.role || candidate.name}. Return the most decision-relevant result for the lead agent.`,
        relationship: candidate.relationship,
      })),
      rationale:
        candidates.length > 0
          ? "Use each explicitly connected specialist and integrate their independent contributions."
          : "Complete directly because no collaboration relationship is available.",
    });
    return {
      content,
      toolCalls: [],
      usage: { promptTokens: roughTokens(prompt), completionTokens: roughTokens(content) },
    };
  }

  const calculatorAvailable = request.tools?.some(
    (tool) => tool.function.name === "calculator_evaluate",
  );
  const expressionMatch = prompt.match(
    /(?:calculate|compute|evaluate|what\s+is)\s+([0-9eE+\-*/%^().\s]{1,160})/i,
  );

  if (calculatorAvailable && expressionMatch && !toolResult) {
    const toolCall: ToolCall = {
      id: `call_${randomUUID()}`,
      type: "function",
      function: {
        name: "calculator_evaluate",
        arguments: JSON.stringify({ expression: expressionMatch[1].trim() }),
      },
    };
    return {
      content: "",
      toolCalls: [toolCall],
      usage: { promptTokens: roughTokens(prompt), completionTokens: 8 },
    };
  }

  let content: string;
  if (toolResult) {
    content = `The connected calculator returned ${toolResult}. I used only the capability granted to this worker and included the computed result in the deliverable.`;
  } else if (prompt.includes("SPECIALIST OUTPUTS")) {
    const outputSection = prompt.split("SPECIALIST OUTPUTS")[1]?.trim() ?? "";
    content = [
      "## Integrated result",
      "",
      "The team completed the request through the configured collaboration boundaries. The implementation contribution and independent review have been reconciled into one deliverable.",
      "",
      outputSection || "No specialist output was available, so the lead completed the work directly.",
      "",
      "## Decision notes",
      "",
      "- Execution used only connected models and resources.",
      "- Completed work orders and this final result are durable and can be resumed or inspected.",
    ].join("\n");
  } else {
    const objective = prompt.match(/OBJECTIVE\n([\s\S]*?)(?:\n\n|$)/)?.[1]?.trim() ?? prompt.trim();
    content = [
      "## Specialist response",
      "",
      `I analyzed the scoped objective: ${objective || "No objective supplied."}`,
      "",
      "### Recommended outcome",
      "",
      "Use a small, verifiable implementation slice with explicit inputs, observable state, and a concrete acceptance check. Keep capability access narrow and return evidence with the result so the lead agent can integrate it safely.",
      "",
      "### Checks",
      "",
      "- Confirm required inputs are available through connected resources.",
      "- Test the outcome at the boundary where it will be consumed.",
      "- Record any unresolved assumption instead of silently widening scope.",
    ].join("\n");
  }

  return {
    content,
    toolCalls: [],
    usage: { promptTokens: roughTokens(prompt), completionTokens: roughTokens(content) },
  };
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
      promptTokens: payload.usage?.prompt_tokens ?? roughTokens(JSON.stringify(request.messages)),
      completionTokens: payload.usage?.completion_tokens ?? roughTokens(content),
    },
  };
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
