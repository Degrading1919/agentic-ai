import { z } from "zod";

export const nodeKindSchema = z.enum([
  "agent",
  "model",
  "capability",
  "skill",
  "connector",
  "storage",
]);

export type NodeKind = z.infer<typeof nodeKindSchema>;

export const relationshipKindSchema = z.enum([
  "agent_uses_model",
  "agent_can_use_capability",
  "agent_can_use_skill",
  "agent_can_use_connector",
  "agent_can_access_storage",
  "agent_can_delegate_to_agent",
  "agent_can_consult_agent",
  "agent_can_review_agent",
  "agent_reports_to_agent",
  "agent_can_handoff_to_agent",
]);

export type RelationshipKind = z.infer<typeof relationshipKindSchema>;

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const baseNodeShape = {
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(""),
  position: positionSchema,
};

export const agentNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("agent"),
  config: z.object({
    role: z.string().trim().min(1).max(160),
    instructions: z.string().trim().min(1).max(20_000),
    entrypoint: z.boolean().default(false),
    autoDelegate: z.boolean().default(true),
    conversationPersistence: z
      .enum(["transient", "connected-storage"])
      .default("connected-storage"),
    temperature: z.number().min(0).max(2).default(0.2),
    maxOutputTokens: z.number().int().min(64).max(32_768).default(1_024),
  }),
});

export const modelNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("model"),
  config: z.object({
    provider: z.enum(["mock", "openai-compatible"]),
    modelId: z.string().trim().min(1).max(300),
    baseUrl: z.string().trim().max(2_000).default("http://127.0.0.1:8080/v1"),
    apiKeyEnv: z.string().trim().max(200).default(""),
    contextWindow: z.number().int().min(512).max(10_000_000).default(8_192),
    estimatedMemoryMb: z.number().int().min(0).max(1_000_000).default(2_048),
    idleTtlMs: z.number().int().min(0).max(86_400_000).default(60_000),
    requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(120_000),
    lifecycle: z.enum(["logical", "llama-swap"]).default("logical"),
  }),
});

export const capabilityNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("capability"),
  config: z.object({
    capabilityId: z.enum(["calculator"]),
    enabled: z.boolean().default(true),
  }),
});

export const skillNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("skill"),
  config: z.object({
    instructions: z.string().trim().min(1).max(20_000),
  }),
});

export const connectorNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("connector"),
  config: z.object({
    connectorType: z.enum(["mcp", "http-api"]),
    endpoint: z.string().trim().max(2_000).default(""),
    authEnv: z.string().trim().max(200).default(""),
    enabled: z.boolean().default(false),
  }),
});

export const storageNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("storage"),
  config: z.object({
    storageType: z.enum(["artifact-store", "project-files", "git", "vector-store"]),
    location: z.string().trim().max(2_000).default("artifacts"),
  }),
});

export const topologyNodeSchema = z.discriminatedUnion("kind", [
  agentNodeSchema,
  modelNodeSchema,
  capabilityNodeSchema,
  skillNodeSchema,
  connectorNodeSchema,
  storageNodeSchema,
]);

export type TopologyNode = z.infer<typeof topologyNodeSchema>;
export type AgentNode = z.infer<typeof agentNodeSchema>;
export type ModelNode = z.infer<typeof modelNodeSchema>;
export type CapabilityNode = z.infer<typeof capabilityNodeSchema>;
export type SkillNode = z.infer<typeof skillNodeSchema>;
export type ConnectorNode = z.infer<typeof connectorNodeSchema>;
export type StorageNode = z.infer<typeof storageNodeSchema>;

export const topologyEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  kind: relationshipKindSchema,
  label: z.string().max(160).optional(),
  permissions: z
    .object({
      read: z.boolean().default(true),
      write: z.boolean().default(false),
      scope: z.string().trim().max(1_000).default("/"),
    })
    .optional(),
});

export type TopologyEdge = z.infer<typeof topologyEdgeSchema>;

export const topologySchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  nodes: z.array(topologyNodeSchema),
  edges: z.array(topologyEdgeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Topology = z.infer<typeof topologySchema>;

export const workOrderStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "blocked",
]);

export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

export const workOrderSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  parentId: z.string().nullable(),
  senderAgentId: z.string().nullable(),
  assigneeAgentId: z.string().min(1),
  objective: z.string().trim().min(1).max(100_000),
  requiredInputs: z.array(z.string()),
  constraints: z.array(z.string()),
  allowedResources: z.array(z.string()),
  dependencies: z.array(z.string()),
  expectedOutput: z.string().max(5_000),
  outputLocation: z.string().max(2_000),
  priority: z.number().int().min(0).max(100),
  status: workOrderStatusSchema,
  returnRelationship: z
    .enum(["root", "delegate", "consult", "review", "report", "handoff"]),
  returnToAgentId: z.string().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export type WorkOrder = z.infer<typeof workOrderSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "agent", "system", "tool"]),
  agentId: z.string().nullable(),
  content: z.string(),
  createdAt: z.string(),
  workOrderId: z.string().nullable(),
});

export type RunMessage = z.infer<typeof runMessageSchema>;

export const runtimeEventSchema = z.object({
  id: z.string(),
  type: z.enum([
    "run_created",
    "run_paused",
    "run_resumed",
    "run_completed",
    "run_failed",
    "work_order_created",
    "work_order_started",
    "work_order_completed",
    "work_order_failed",
    "model_state",
    "tool_called",
    "topology_boundary",
  ]),
  message: z.string(),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const runSchema = z.object({
  id: z.string().min(1),
  topologyId: z.string().min(1),
  entryAgentId: z.string().min(1),
  objective: z.string().trim().min(1).max(100_000),
  status: runStatusSchema,
  workOrders: z.array(workOrderSchema),
  messages: z.array(runMessageSchema),
  events: z.array(runtimeEventSchema),
  result: z.string().nullable(),
  error: z.string().nullable(),
  artifactPaths: z.array(z.string()),
  metrics: z.object({
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

export type Run = z.infer<typeof runSchema>;

export const appStateSchema = z.object({
  version: z.literal(1),
  activeTopologyId: z.string(),
  topologies: z.array(topologySchema),
  runs: z.array(runSchema),
});

export type AppState = z.infer<typeof appStateSchema>;

export type ValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type ModelResidencyState =
  | "unloaded"
  | "loading"
  | "resident"
  | "executing"
  | "idle"
  | "unloading"
  | "failed";

export type ModelRuntimeState = {
  modelId: string;
  modelName: string;
  state: ModelResidencyState;
  provider: ModelNode["config"]["provider"];
  activeRunId: string | null;
  estimatedMemoryMb: number;
  loadedAt: string | null;
  lastUsedAt: string | null;
  requestCount: number;
  lastError: string | null;
};

export type HardwareSnapshot = {
  platform: string;
  cpuModel: string;
  logicalCores: number;
  loadPercent: number;
  totalRamMb: number;
  usedRamMb: number;
  processRamMb: number;
  gpu: "unavailable";
  capturedAt: string;
};

export type RuntimeSnapshot = {
  status: "idle" | "working" | "paused";
  queuedRunIds: string[];
  activeRunIds: string[];
  models: ModelRuntimeState[];
  hardware: HardwareSnapshot;
  memoryBudgetMb: number;
};

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type CompletionRequest = {
  model: ModelNode;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature: number;
  maxTokens: number;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type CompletionResult = {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
};

export const createRunRequestSchema = z.object({
  topologyId: z.string().min(1),
  entryAgentId: z.string().min(1),
  objective: z.string().trim().min(1).max(100_000),
});

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
