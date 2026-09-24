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
    /**
     * Authorization (an edge) and context exposure are separate decisions.
     * `eager` sends every authorized tool schema; `deferred` sends a compact
     * catalog plus stable discovery tools; `auto` chooses per agent.
     */
    toolExposure: z.enum(["auto", "eager", "deferred"]).default("auto"),
    eagerToolLimit: z.number().int().min(0).max(128).default(8),
    maxDelegations: z.number().int().min(0).max(8).default(3),
    maxToolIterations: z.number().int().min(1).max(24).default(6),
  }),
});

export const modelAdapterSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  scale: z.number().min(0).max(4).default(1),
});

/**
 * Lineage and deployment metadata for a (possibly custom fine-tuned) model
 * artifact. Every field has a default so logical or remote models stay valid.
 */
export const modelArtifactSchema = z.object({
  path: z.string().trim().max(2_000).default(""),
  format: z.enum(["gguf", "safetensors", "other"]).default("gguf"),
  architecture: z.string().trim().max(120).default(""),
  baseModel: z.string().trim().max(300).default(""),
  parameterLabel: z.string().trim().max(40).default(""),
  quantization: z.string().trim().max(40).default(""),
  trainedContextLength: z.number().int().min(0).max(10_000_000).default(0),
  version: z.string().trim().max(80).default(""),
  gpuLayers: z.number().int().min(-1).max(1_000).default(-1),
  adapters: z.array(modelAdapterSchema).max(16).default([]),
  notes: z.string().max(4_000).default(""),
});

export type ModelArtifact = z.infer<typeof modelArtifactSchema>;

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
    estimatedVramMb: z.number().int().min(0).max(1_000_000).default(0),
    parallelSlots: z.number().int().min(1).max(64).default(1),
    artifact: modelArtifactSchema.default(() => modelArtifactSchema.parse({})),
  }),
});

export const builtinCapabilityIds = ["calculator"] as const;

export const capabilityNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("capability"),
  config: z.object({
    capabilityId: z.enum(builtinCapabilityIds),
    enabled: z.boolean().default(true),
  }),
});

export const skillNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("skill"),
  config: z.object({
    instructions: z.string().trim().min(1).max(20_000),
    /** `on-demand` skills appear as one catalog line until the worker loads them. */
    loading: z.enum(["always", "on-demand"]).default("always"),
    summary: z.string().trim().max(300).default(""),
  }),
});

export const connectorNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("connector"),
  config: z.object({
    connectorType: z.enum(["mcp", "http-api"]),
    transport: z.enum(["streamable-http", "stdio"]).default("streamable-http"),
    endpoint: z.string().trim().max(2_000).default(""),
    command: z.string().trim().max(2_000).default(""),
    args: z.array(z.string().max(2_000)).max(64).default([]),
    authEnv: z.string().trim().max(200).default(""),
    enabled: z.boolean().default(false),
    /** Empty means every discovered tool is authorized. */
    toolAllowlist: z.array(z.string().max(200)).max(1_000).default([]),
    allowedMethods: z
      .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]))
      .max(5)
      .default(["GET"]),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
    maxResultChars: z.number().int().min(256).max(200_000).default(12_000),
  }),
});

export const storageNodeSchema = z.object({
  ...baseNodeShape,
  kind: z.literal("storage"),
  config: z.object({
    storageType: z.enum(["artifact-store", "project-files", "git", "memory", "vector-store"]),
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
  /** Relationship-specific policy for agent-to-agent edges. */
  settings: z
    .object({
      maxRevisions: z.number().int().min(0).max(5).default(1),
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
  "handed_off",
  "superseded",
]);

export type WorkOrderStatus = z.infer<typeof workOrderStatusSchema>;

export const terminalWorkOrderStatuses: readonly WorkOrderStatus[] = [
  "completed",
  "failed",
  "blocked",
  "handed_off",
  "superseded",
];

export const relationshipNameSchema = z.enum([
  "root",
  "delegate",
  "consult",
  "review",
  "report",
  "handoff",
]);

export type RelationshipName = z.infer<typeof relationshipNameSchema>;

/**
 * Where an order is in its own lifecycle. Resuming reads this field instead
 * of replaying a transcript.
 */
export const workOrderPhaseSchema = z.enum(["plan", "execute", "integrate", "done"]);
export type WorkOrderPhase = z.infer<typeof workOrderPhaseSchema>;

export const reviewFindingSchema = z.object({
  severity: z.enum(["blocking", "major", "minor"]).default("major"),
  issue: z.string().max(4_000),
  recommendation: z.string().max(4_000).default(""),
});

export const reviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "reject"]),
  summary: z.string().max(8_000).default(""),
  findings: z.array(reviewFindingSchema).max(50).default([]),
});

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

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
  returnRelationship: relationshipNameSchema,
  returnToAgentId: z.string().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** Agent accountable for the outcome. Delegation keeps it; handoff moves it. */
  ownerAgentId: z.string().nullable().default(null),
  phase: workOrderPhaseSchema.default("plan"),
  depth: z.number().int().min(0).max(16).default(0),
  /** Consult advice is non-blocking: its failure does not fail the requester. */
  blocking: z.boolean().default(true),
  /** Orders this order evaluates (review) or revises (revision). */
  subjectOrderIds: z.array(z.string()).default([]),
  revisionOf: z.string().nullable().default(null),
  handoffFromOrderId: z.string().nullable().default(null),
  handedOffToOrderId: z.string().nullable().default(null),
  supersededByOrderId: z.string().nullable().default(null),
  /** Compact digest used when full results do not fit a later context. */
  summary: z.string().nullable().default(null),
  verdict: reviewVerdictSchema.nullable().default(null),
  /** Direct work awaiting review before the owner finalizes it. */
  draft: z.string().nullable().default(null),
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
    "delegation_planned",
    "review_verdict",
    "handoff",
    "report_delivered",
    "capability_loaded",
    "context_trimmed",
    "artifact_written",
  ]),
  message: z.string(),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const contextSegmentKindSchema = z.enum([
  "harness",
  "worker",
  "skills",
  "skill_catalog",
  "collaborators",
  "resources",
  "tool_catalog",
  "tool_schemas",
  "work_order",
  "history",
  "memory",
  "dependencies",
  "inbox",
  "tool_results",
]);

export type ContextSegmentKind = z.infer<typeof contextSegmentKindSchema>;

export const contextSegmentStatSchema = z.object({
  kind: contextSegmentKindSchema,
  label: z.string(),
  tokens: z.number().int().nonnegative(),
  stable: z.boolean(),
  trimmed: z.boolean().default(false),
});

export type ContextSegmentStat = z.infer<typeof contextSegmentStatSchema>;

/** Observability record for one model request. Stores sizes, never prompt text. */
export const contextFrameSchema = z.object({
  id: z.string(),
  workOrderId: z.string(),
  agentId: z.string(),
  modelId: z.string(),
  purpose: z.enum(["plan", "execute", "integrate", "review", "tool_followup"]),
  segments: z.array(contextSegmentStatSchema),
  estimatedPromptTokens: z.number().int().nonnegative(),
  stablePrefixTokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().nonnegative(),
  reservedOutputTokens: z.number().int().nonnegative(),
  prefixHash: z.string(),
  toolsHash: z.string(),
  prefixReused: z.boolean(),
  exposure: z.enum(["eager", "deferred", "none"]),
  authorizedTools: z.number().int().nonnegative(),
  exposedToolSchemas: z.number().int().nonnegative(),
  actualPromptTokens: z.number().int().nonnegative().nullable().default(null),
  cachedPromptTokens: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.string(),
});

export type ContextFrame = z.infer<typeof contextFrameSchema>;

const plannedParticipantSchema = z.object({
  agentId: z.string(),
  relationship: relationshipNameSchema,
});

export const delegationPlanRecordSchema = z.object({
  id: z.string(),
  workOrderId: z.string(),
  agentId: z.string(),
  mode: z.enum(["direct", "delegate", "handoff"]),
  source: z.enum(["model", "fallback"]),
  rationale: z.string().max(4_000),
  selected: z.array(plannedParticipantSchema),
  available: z.array(plannedParticipantSchema),
  /** Present when the plan requested an independent review. */
  reviewCriteria: z.string().max(4_000).default(""),
  createdAt: z.string(),
});

export type DelegationPlanRecord = z.infer<typeof delegationPlanRecordSchema>;

export const reportRecordSchema = z.object({
  id: z.string(),
  fromAgentId: z.string(),
  toAgentId: z.string(),
  workOrderId: z.string(),
  status: workOrderStatusSchema,
  summary: z.string().max(4_000),
  consumedByOrderIds: z.array(z.string()).default([]),
  createdAt: z.string(),
});

export type ReportRecord = z.infer<typeof reportRecordSchema>;

export const artifactRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workOrderId: z.string().nullable(),
  agentId: z.string().nullable(),
  name: z.string().max(400),
  kind: z.enum(["result", "file", "archive", "memory"]),
  storageNodeId: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
  summary: z.string().max(4_000).default(""),
  tokens: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

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
    cachedPromptTokens: z.number().int().nonnegative().default(0),
    estimatedPromptTokens: z.number().int().nonnegative().default(0),
    prefixReuses: z.number().int().nonnegative().default(0),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  /** Follow-up runs share a thread and receive a digest, not a transcript. */
  threadId: z.string().nullable().default(null),
  previousRunId: z.string().nullable().default(null),
  rootOrderId: z.string().nullable().default(null),
  contextFrames: z.array(contextFrameSchema).default([]),
  plans: z.array(delegationPlanRecordSchema).default([]),
  reports: z.array(reportRecordSchema).default([]),
  artifacts: z.array(artifactRecordSchema).default([]),
});

export type Run = z.infer<typeof runSchema>;

export const catalogToolSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(300).default(""),
  description: z.string().max(8_000).default(""),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
  readOnly: z.boolean().default(false),
  destructive: z.boolean().default(false),
});

export type CatalogTool = z.infer<typeof catalogToolSchema>;

/** Discovered connector tools, cached so estimates and runs need no live connection. */
export const connectorCatalogSchema = z.object({
  connectorId: z.string().min(1),
  fingerprint: z.string(),
  fetchedAt: z.string(),
  serverName: z.string().default(""),
  serverVersion: z.string().default(""),
  tools: z.array(catalogToolSchema),
  error: z.string().nullable().default(null),
});

export type ConnectorCatalog = z.infer<typeof connectorCatalogSchema>;

export const appStateSchema = z.object({
  version: z.literal(1),
  activeTopologyId: z.string(),
  topologies: z.array(topologySchema),
  runs: z.array(runSchema),
  connectorCatalogs: z.array(connectorCatalogSchema).default([]),
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
  estimatedVramMb: number;
  parallelSlots: number;
  activeRequests: number;
  waitingRequests: number;
  loadedAt: string | null;
  lastUsedAt: string | null;
  requestCount: number;
  lastError: string | null;
};

export type GpuDevice = {
  index: number;
  name: string;
  totalVramMb: number;
  usedVramMb: number;
  utilizationPercent: number | null;
  temperatureC: number | null;
};

export type GpuSnapshot =
  | { available: false; reason: string }
  | { available: true; source: "nvidia-smi"; devices: GpuDevice[]; capturedAt: string };

export type HardwareSnapshot = {
  platform: string;
  cpuModel: string;
  logicalCores: number;
  loadPercent: number;
  totalRamMb: number;
  usedRamMb: number;
  processRamMb: number;
  gpu: GpuSnapshot;
  capturedAt: string;
};

export type RuntimeSnapshot = {
  status: "idle" | "working" | "paused";
  queuedRunIds: string[];
  activeRunIds: string[];
  activeWorkOrders: number;
  models: ModelRuntimeState[];
  hardware: HardwareSnapshot;
  memoryBudgetMb: number;
  vramBudgetMb: number | null;
  maxParallelOrders: number;
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
    /** Prompt tokens served from the backend's prefix/KV cache, when reported. */
    cachedPromptTokens?: number | null;
    /** True when the server did not report usage and the value is estimated. */
    estimated?: boolean;
  };
};

export const createRunRequestSchema = z.object({
  topologyId: z.string().min(1),
  entryAgentId: z.string().min(1),
  objective: z.string().trim().min(1).max(100_000),
  /** Continue a thread; the new run receives a compact digest of prior work. */
  previousRunId: z.string().min(1).optional(),
});

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
