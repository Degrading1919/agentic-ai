import { randomUUID } from "node:crypto";
import type {
  AgentNode,
  ChatMessage,
  CompletionResult,
  CreateRunRequest,
  ModelNode,
  ModelRuntimeState,
  RelationshipKind,
  Run,
  RuntimeEvent,
  RuntimeSnapshot,
  Topology,
  ToolDefinition,
  WorkOrder,
} from "../shared/contracts.js";
import {
  collaborationKinds,
  getAgentContext,
  hasCollaborationPermission,
  validateTopology,
} from "../shared/topology.js";
import { defaultMemoryBudgetMb, getHardwareSnapshot } from "./hardware.js";
import { ModelPool } from "./model-pool.js";
import { complete } from "./providers.js";
import { LocalStore } from "./store.js";
import { executeToolCall, toolDefinitions } from "./tools.js";

type PlannedDelegation = {
  agentId: string;
  objective: string;
  edgeKind: RelationshipKind;
};

function now(): string {
  return new Date().toISOString();
}

function event(
  type: RuntimeEvent["type"],
  message: string,
  data: Record<string, unknown> = {},
): RuntimeEvent {
  return { id: randomUUID(), type, message, createdAt: now(), data };
}

function relationName(kind: RelationshipKind): WorkOrder["returnRelationship"] {
  switch (kind) {
    case "agent_can_delegate_to_agent":
      return "delegate";
    case "agent_can_consult_agent":
      return "consult";
    case "agent_can_review_agent":
      return "review";
    case "agent_reports_to_agent":
      return "report";
    case "agent_can_handoff_to_agent":
      return "handoff";
    default:
      return "delegate";
  }
}

function newRootOrder(request: CreateRunRequest, topology: Topology): WorkOrder {
  const context = getAgentContext(topology, request.entryAgentId);
  if (!context) throw new Error("Entry agent does not exist in the selected topology.");
  return {
    id: randomUUID(),
    runId: "",
    parentId: null,
    senderAgentId: null,
    assigneeAgentId: request.entryAgentId,
    objective: request.objective,
    requiredInputs: [],
    constraints: [
      "Use only resources and collaborators connected in the active topology.",
      "Return a concrete result and make uncertainty explicit.",
    ],
    allowedResources: context.allowedResourceIds,
    dependencies: [],
    expectedOutput: "An integrated response that resolves the user's objective.",
    outputLocation: "run final result",
    priority: 100,
    status: "queued",
    returnRelationship: "root",
    returnToAgentId: null,
    result: null,
    error: null,
    createdAt: now(),
    startedAt: null,
    completedAt: null,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class RuntimeEngine {
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly maxConcurrentRuns: number;
  readonly modelPool: ModelPool;

  constructor(readonly store: LocalStore) {
    const configuredConcurrency = Number(process.env.AGENTIC_HARNESS_MAX_CONCURRENT_RUNS ?? 1);
    this.maxConcurrentRuns = Number.isInteger(configuredConcurrency)
      ? Math.max(1, Math.min(8, configuredConcurrency))
      : 1;
    this.modelPool = new ModelPool(defaultMemoryBudgetMb(), (state) =>
      this.recordModelTransition(state),
    );
  }

  async init(): Promise<void> {
    for (const run of this.store.listRuns(10_000)) {
      if (run.status === "running") {
        await this.store.mutateRun(run.id, (draft) => {
          draft.status = "queued";
          for (const order of draft.workOrders) {
            if (order.status === "running") {
              order.status = "queued";
              order.startedAt = null;
            }
          }
          draft.events.push(
            event("run_resumed", "Recovered queued work after the local runtime restarted."),
          );
        });
        this.enqueue(run.id);
      } else if (run.status === "queued") {
        this.enqueue(run.id);
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await this.modelPool.shutdown();
  }

  snapshot(): RuntimeSnapshot {
    const hasPaused = this.store.listRuns(10_000).some((run) => run.status === "paused");
    return {
      status: this.active.size > 0 ? "working" : hasPaused ? "paused" : "idle",
      queuedRunIds: [...this.queue],
      activeRunIds: [...this.active],
      models: this.modelPool.snapshot(),
      hardware: getHardwareSnapshot(),
      memoryBudgetMb: this.modelPool.memoryBudgetMb,
    };
  }

  async createRun(request: CreateRunRequest): Promise<Run> {
    const topology = this.store.getTopology(request.topologyId);
    if (!topology) throw new Error("Selected topology does not exist.");
    const errors = validateTopology(topology).filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Topology is not runnable: ${errors.map((issue) => issue.message).join(" ")}`);
    }
    const context = getAgentContext(topology, request.entryAgentId);
    if (!context || !context.agent.config.entrypoint) {
      throw new Error("Selected agent is not configured as a Work entry point.");
    }

    const id = randomUUID();
    const root = newRootOrder(request, topology);
    root.runId = id;
    const createdAt = now();
    const run: Run = {
      id,
      topologyId: topology.id,
      entryAgentId: request.entryAgentId,
      objective: request.objective,
      status: "queued",
      workOrders: [root],
      messages: [
        {
          id: randomUUID(),
          role: "user",
          agentId: null,
          content: request.objective,
          createdAt,
          workOrderId: root.id,
        },
      ],
      events: [event("run_created", `Run queued for ${context.agent.name}.`)],
      result: null,
      error: null,
      artifactPaths: [],
      metrics: {
        modelCalls: 0,
        toolCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        elapsedMs: 0,
      },
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    await this.store.createRun(run);
    this.enqueue(id);
    return this.store.getRun(id) ?? run;
  }

  async pauseRun(runId: string): Promise<Run> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new Error("Run does not exist.");
    if (["completed", "failed"].includes(existing.status)) return existing;

    this.removeFromQueue(runId);
    const updated = await this.store.mutateRun(runId, (run) => {
      run.status = "paused";
      run.events.push(event("run_paused", "Run paused; completed work has been preserved."));
    });
    this.controllers.get(runId)?.abort();
    return updated;
  }

  async resumeRun(runId: string): Promise<Run> {
    const existing = this.store.getRun(runId);
    if (!existing) throw new Error("Run does not exist.");
    if (existing.status !== "paused") throw new Error("Only paused runs can be resumed.");
    const updated = await this.store.mutateRun(runId, (run) => {
      run.status = "queued";
      for (const order of run.workOrders) {
        if (order.status === "running") {
          order.status = "queued";
          order.startedAt = null;
        }
      }
      run.events.push(
        event(
          "run_resumed",
          "Run resumed. Remaining work will use the current saved topology and instructions.",
        ),
      );
    });
    this.enqueue(runId);
    return updated;
  }

  private enqueue(runId: string): void {
    if (!this.queue.includes(runId) && !this.active.has(runId)) this.queue.push(runId);
    void this.pump();
  }

  private removeFromQueue(runId: string): void {
    let index = this.queue.indexOf(runId);
    while (index >= 0) {
      this.queue.splice(index, 1);
      index = this.queue.indexOf(runId);
    }
  }

  private async pump(): Promise<void> {
    while (this.active.size < this.maxConcurrentRuns && this.queue.length > 0) {
      const runId = this.queue.shift();
      if (!runId || this.active.has(runId)) continue;
      const run = this.store.getRun(runId);
      if (!run || run.status === "paused" || ["completed", "failed"].includes(run.status)) {
        continue;
      }
      this.active.add(runId);
      void this.processRun(runId)
        .catch(async (error) => {
          if (!isAbort(error)) await this.failRun(runId, error);
        })
        .finally(() => {
          this.active.delete(runId);
          this.controllers.delete(runId);
          void this.pump();
        });
    }
  }

  private async processRun(runId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    await this.store.mutateRun(runId, (run) => {
      if (run.status !== "paused") run.status = "running";
    });

    while (!controller.signal.aborted) {
      const run = this.store.getRun(runId);
      if (!run || run.status === "paused") return;
      if (["completed", "failed"].includes(run.status)) return;

      const queued = run.workOrders
        .filter(
          (order) =>
            order.status === "queued" &&
            order.dependencies.every((dependency) =>
              run.workOrders.some(
                (candidate) =>
                  candidate.id === dependency &&
                  ["completed", "failed", "blocked"].includes(candidate.status),
              ),
            ),
        )
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];

      if (queued) {
        await this.executeWorkOrder(runId, queued.id, controller.signal);
        continue;
      }

      const root = run.workOrders.find((order) => order.parentId === null);
      if (!root) throw new Error("Run has no root work order.");
      const children = run.workOrders.filter((order) => order.parentId === root.id);
      if (
        root.status === "waiting" &&
        children.every((child) => ["completed", "failed", "blocked"].includes(child.status))
      ) {
        await this.store.mutateRun(runId, (draft) => {
          const draftRoot = draft.workOrders.find((order) => order.id === root.id);
          if (draftRoot) draftRoot.status = "queued";
        });
        continue;
      }
      if (root.status === "completed") {
        await this.completeRun(runId, root.result ?? "Work completed.");
        return;
      }
      if (root.status === "failed" || root.status === "blocked") {
        await this.failRun(runId, new Error(root.error ?? "Root work order failed."));
        return;
      }
      if (run.workOrders.some((order) => order.status === "running")) return;
      throw new Error("Run cannot make progress because no work order is runnable.");
    }
  }

  private async executeWorkOrder(
    runId: string,
    workOrderId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let run = this.store.getRun(runId);
    if (!run) return;
    let order = run.workOrders.find((candidate) => candidate.id === workOrderId);
    if (!order) return;
    const topology = this.store.getTopology(run.topologyId);
    if (!topology) throw new Error("Run topology no longer exists.");

    if (order.senderAgentId) {
      const permission = hasCollaborationPermission(
        topology,
        order.senderAgentId,
        order.assigneeAgentId,
      );
      if (!permission) {
        await this.store.mutateRun(runId, (draft) => {
          const blocked = draft.workOrders.find((candidate) => candidate.id === workOrderId);
          if (!blocked) return;
          blocked.status = "blocked";
          blocked.error = "The collaboration edge was removed before this work executed.";
          blocked.completedAt = now();
          draft.events.push(
            event(
              "topology_boundary",
              "A queued work order was blocked because its collaboration permission is no longer connected.",
              { workOrderId },
            ),
          );
        });
        return;
      }
    }

    await this.store.mutateRun(runId, (draft) => {
      const activeOrder = draft.workOrders.find((candidate) => candidate.id === workOrderId);
      if (!activeOrder) return;
      activeOrder.status = "running";
      activeOrder.startedAt = now();
      draft.events.push(
        event("work_order_started", `Work order started for ${activeOrder.assigneeAgentId}.`, {
          workOrderId,
          agentId: activeOrder.assigneeAgentId,
        }),
      );
    });

    try {
      run = this.store.getRun(runId);
      order = run?.workOrders.find((candidate) => candidate.id === workOrderId);
      if (!run || !order) return;
      const activeOrder = order;
      const context = getAgentContext(topology, activeOrder.assigneeAgentId);
      if (!context) throw new Error("Assigned agent no longer exists in the topology.");

      const isRoot = activeOrder.parentId === null;
      const children = run.workOrders.filter(
        (candidate) => candidate.parentId === activeOrder.id,
      );
      if (isRoot && context.agent.config.autoDelegate && children.length === 0) {
        const plan = await this.planDelegations(
          run,
          activeOrder,
          topology,
          context.agent,
          signal,
        );
        if (plan.length > 0) {
          await this.createChildOrders(runId, activeOrder, topology, plan);
          return;
        }
      }

      const result = await this.executeAgent(run, activeOrder, topology, signal);
      await this.store.mutateRun(runId, (draft) => {
        const completed = draft.workOrders.find((candidate) => candidate.id === workOrderId);
        if (!completed) return;
        completed.status = "completed";
        completed.result = result;
        completed.error = null;
        completed.completedAt = now();
        draft.messages.push({
          id: randomUUID(),
          role: "agent",
          agentId: completed.assigneeAgentId,
          content: result,
          createdAt: now(),
          workOrderId: completed.id,
        });
        draft.events.push(
          event("work_order_completed", "Work order completed.", {
            workOrderId,
            agentId: completed.assigneeAgentId,
          }),
        );
      });
    } catch (error) {
      if (isAbort(error) || signal.aborted) {
        await this.store.mutateRun(runId, (draft) => {
          const interrupted = draft.workOrders.find((candidate) => candidate.id === workOrderId);
          if (interrupted && interrupted.status === "running") {
            interrupted.status = "queued";
            interrupted.startedAt = null;
          }
          if (draft.status !== "paused") draft.status = "queued";
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutateRun(runId, (draft) => {
        const failed = draft.workOrders.find((candidate) => candidate.id === workOrderId);
        if (!failed) return;
        failed.status = "failed";
        failed.error = message;
        failed.completedAt = now();
        draft.events.push(event("work_order_failed", message, { workOrderId }));
      });
    }
  }

  private async planDelegations(
    run: Run,
    order: WorkOrder,
    topology: Topology,
    agent: AgentNode,
    signal: AbortSignal,
  ): Promise<PlannedDelegation[]> {
    const context = getAgentContext(topology, agent.id);
    if (!context?.model || context.collaborators.length === 0) return [];
    const candidates = context.collaborators.filter((item) =>
      collaborationKinds.includes(item.edge.kind),
    );
    if (candidates.length === 0) return [];

    const candidateLines = candidates.map(
      ({ agent: candidate, edge }) =>
        `CANDIDATE|${candidate.id}|${candidate.name}|${relationName(edge.kind)}|${candidate.config.role}`,
    );
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          `You are ${agent.name}, ${agent.config.role}.`,
          agent.config.instructions,
          "Choose only from explicitly connected collaborators. Return JSON matching the supplied schema.",
        ].join("\n\n"),
      },
      {
        role: "user",
        content: [
          "OBJECTIVE",
          order.objective,
          "",
          "CONNECTED COLLABORATORS",
          ...candidateLines,
          "",
          "Select the collaborators who add material value. Give each a self-contained objective.",
        ].join("\n"),
      },
    ];
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        delegations: {
          type: "array",
          maxItems: Math.min(5, candidates.length),
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              agentId: { type: "string", enum: candidates.map((item) => item.agent.id) },
              objective: { type: "string" },
              relationship: {
                type: "string",
                enum: ["delegate", "consult", "review", "report", "handoff"],
              },
            },
            required: ["agentId", "objective", "relationship"],
          },
        },
        rationale: { type: "string" },
      },
      required: ["delegations", "rationale"],
    };
    const response = await this.callModel(
      run.id,
      context.model,
      messages,
      agent,
      signal,
      undefined,
      schema,
    );

    let parsed: unknown;
    try {
      const json = response.content.match(/\{[\s\S]*\}/)?.[0] ?? response.content;
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }
    const rawDelegations =
      typeof parsed === "object" && parsed !== null && "delegations" in parsed
        ? (parsed as { delegations?: unknown }).delegations
        : null;
    const requested = Array.isArray(rawDelegations) ? rawDelegations : [];
    const byId = new Map(candidates.map((candidate) => [candidate.agent.id, candidate]));
    const seen = new Set<string>();
    const planned: PlannedDelegation[] = [];

    for (const raw of requested) {
      if (typeof raw !== "object" || raw === null) continue;
      const agentId = "agentId" in raw ? String(raw.agentId) : "";
      const candidate = byId.get(agentId);
      if (!candidate || seen.has(agentId)) continue;
      const objective = "objective" in raw ? String(raw.objective).trim() : "";
      planned.push({
        agentId,
        objective:
          objective ||
          `Address the user's objective from the perspective of ${candidate.agent.config.role}.`,
        edgeKind: candidate.edge.kind,
      });
      seen.add(agentId);
    }

    // Small local models may fail strict JSON. The deterministic fallback remains
    // bounded by the exact same connected relationships.
    if (planned.length === 0) {
      for (const candidate of candidates.slice(0, 5)) {
        planned.push({
          agentId: candidate.agent.id,
          objective: `Address the user's objective as ${candidate.agent.config.role}. Return a concise result for ${agent.name} to integrate.`,
          edgeKind: candidate.edge.kind,
        });
      }
    }
    return planned;
  }

  private async createChildOrders(
    runId: string,
    root: WorkOrder,
    topology: Topology,
    plan: PlannedDelegation[],
  ): Promise<void> {
    await this.store.mutateRun(runId, (run) => {
      const draftRoot = run.workOrders.find((order) => order.id === root.id);
      if (!draftRoot) return;
      draftRoot.status = "waiting";
      const created: WorkOrder[] = [];
      for (const [index, delegation] of plan.entries()) {
        const context = getAgentContext(topology, delegation.agentId);
        const permission = hasCollaborationPermission(
          topology,
          root.assigneeAgentId,
          delegation.agentId,
          delegation.edgeKind,
        );
        if (!context || !permission) continue;
        const child: WorkOrder = {
          id: randomUUID(),
          runId,
          parentId: root.id,
          senderAgentId: root.assigneeAgentId,
          assigneeAgentId: delegation.agentId,
          objective: delegation.objective,
          requiredInputs: [root.objective],
          constraints: [
            "Use only the model, skills, tools, connectors, and storage connected to this assigned agent.",
            `Return the result to ${root.assigneeAgentId}.`,
          ],
          allowedResources: context.allowedResourceIds,
          dependencies: [],
          expectedOutput: `A ${relationName(delegation.edgeKind)} result for the lead agent.`,
          outputLocation: `work-order:${root.id}`,
          priority: 80 - index,
          status: "queued",
          returnRelationship: relationName(delegation.edgeKind),
          returnToAgentId: root.assigneeAgentId,
          result: null,
          error: null,
          createdAt: now(),
          startedAt: null,
          completedAt: null,
        };
        created.push(child);
        run.events.push(
          event("work_order_created", `Structured ${child.returnRelationship} order created.`, {
            workOrderId: child.id,
            senderAgentId: child.senderAgentId,
            assigneeAgentId: child.assigneeAgentId,
          }),
        );
      }
      run.workOrders.push(...created);
      if (created.length === 0) draftRoot.status = "queued";
    });
  }

  private async executeAgent(
    run: Run,
    order: WorkOrder,
    topology: Topology,
    signal: AbortSignal,
  ): Promise<string> {
    const context = getAgentContext(topology, order.assigneeAgentId);
    if (!context) throw new Error("Assigned agent is unavailable.");
    if (!context.model) {
      throw new Error(`Topology boundary: agent '${context.agent.name}' has no connected model.`);
    }

    await this.store.mutateRun(run.id, (draft) => {
      const current = draft.workOrders.find((candidate) => candidate.id === order.id);
      if (current) current.allowedResources = context.allowedResourceIds;
    });

    const children = run.workOrders.filter((candidate) => candidate.parentId === order.id);
    const specialistOutputs = children
      .map((child) => {
        const name = topology.nodes.find((node) => node.id === child.assigneeAgentId)?.name ?? child.assigneeAgentId;
        return `### ${name} · ${child.returnRelationship} · ${child.status}\n${child.result ?? child.error ?? "No result"}`;
      })
      .join("\n\n");
    const skills = context.skills.map((skill) => `- ${skill.name}: ${skill.config.instructions}`);
    const resources = [
      ...context.capabilities.map((node) => `capability:${node.name}`),
      ...context.connectors.map(
        (node) => `connector:${node.name}${node.config.enabled ? "" : " (disabled)"}`,
      ),
      ...context.storage.map(
        ({ node, edge }) =>
          `storage:${node.name} [read=${edge.permissions?.read ?? false}, write=${edge.permissions?.write ?? false}, scope=${edge.permissions?.scope ?? "/"}]`,
      ),
    ];
    const system = [
      `You are ${context.agent.name}, a specialized worker responsible for ${context.agent.config.role}.`,
      context.agent.config.instructions,
      "The capability topology is a hard security boundary. Do not claim access to anything outside the connected-resource list.",
      skills.length ? `CONNECTED SKILLS\n${skills.join("\n")}` : "CONNECTED SKILLS\nNone",
      resources.length
        ? `CONNECTED RESOURCES\n${resources.map((item) => `- ${item}`).join("\n")}`
        : "CONNECTED RESOURCES\nNone",
    ].join("\n\n");
    const user = [
      "OBJECTIVE",
      order.objective,
      order.requiredInputs.length
        ? `\nREQUIRED INPUTS\n${order.requiredInputs.map((item) => `- ${item}`).join("\n")}`
        : "",
      order.constraints.length
        ? `\nCONSTRAINTS\n${order.constraints.map((item) => `- ${item}`).join("\n")}`
        : "",
      specialistOutputs ? `\nSPECIALIST OUTPUTS\n${specialistOutputs}` : "",
      `\nEXPECTED OUTPUT\n${order.expectedOutput}`,
    ].join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const tools = toolDefinitions(context.capabilities);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const response = await this.callModel(
        run.id,
        context.model,
        messages,
        context.agent,
        signal,
        tools,
      );
      if (response.toolCalls.length === 0) {
        if (!response.content.trim()) throw new Error("Model returned an empty response.");
        return response.content.trim();
      }

      messages.push({
        role: "assistant",
        content: response.content || null,
        toolCalls: response.toolCalls,
      });
      for (const call of response.toolCalls) {
        let result: string;
        try {
          result = executeToolCall(context.agent, context.capabilities, call);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.store.mutateRun(run.id, (draft) => {
            draft.events.push(
              event("topology_boundary", message, {
                agentId: context.agent.id,
                tool: call.function.name,
              }),
            );
          });
          throw error;
        }
        await this.store.mutateRun(run.id, (draft) => {
          draft.metrics.toolCalls += 1;
          draft.messages.push({
            id: randomUUID(),
            role: "tool",
            agentId: context.agent.id,
            content: `${call.function.name}: ${result}`,
            createdAt: now(),
            workOrderId: order.id,
          });
          draft.events.push(
            event("tool_called", `${context.agent.name} used ${call.function.name}.`, {
              agentId: context.agent.id,
              workOrderId: order.id,
              tool: call.function.name,
            }),
          );
        });
        messages.push({
          role: "tool",
          name: call.function.name,
          toolCallId: call.id,
          content: result,
        });
      }
    }
    throw new Error("Agent exceeded the maximum tool-call iterations.");
  }

  private async callModel(
    runId: string,
    model: ModelNode,
    messages: ChatMessage[],
    agent: AgentNode,
    signal: AbortSignal,
    tools?: ToolDefinition[],
    jsonSchema?: Record<string, unknown>,
  ): Promise<CompletionResult> {
    return this.modelPool.withModel(model, runId, async () => {
      const result = await complete({
        model,
        messages,
        tools: jsonSchema ? undefined : tools,
        temperature: agent.config.temperature,
        maxTokens: agent.config.maxOutputTokens,
        jsonSchema,
        signal,
      });
      await this.recordUsage(runId, result);
      return result;
    });
  }

  private async recordUsage(runId: string, response: CompletionResult): Promise<void> {
    await this.store.mutateRun(runId, (run) => {
      run.metrics.modelCalls += 1;
      run.metrics.promptTokens += response.usage.promptTokens;
      run.metrics.completionTokens += response.usage.completionTokens;
      run.metrics.elapsedMs = Date.now() - new Date(run.createdAt).getTime();
    });
  }

  private async recordModelTransition(state: ModelRuntimeState): Promise<void> {
    if (!state.activeRunId) return;
    const run = this.store.getRun(state.activeRunId);
    if (!run || ["completed", "failed"].includes(run.status)) return;
    await this.store.mutateRun(run.id, (draft) => {
      draft.events.push(
        event("model_state", `${state.modelName}: ${state.state}`, {
          modelId: state.modelId,
          state: state.state,
        }),
      );
    });
  }

  private async completeRun(runId: string, result: string): Promise<void> {
    const completedAt = now();
    let run = await this.store.mutateRun(runId, (draft) => {
      draft.status = "completed";
      draft.result = result;
      draft.error = null;
      draft.completedAt = completedAt;
      draft.metrics.elapsedMs = Date.now() - new Date(draft.createdAt).getTime();
      draft.events.push(event("run_completed", "Run completed and state persisted."));
    });

    const topology = this.store.getTopology(run.topologyId);
    const context = topology ? getAgentContext(topology, run.entryAgentId) : null;
    const writableStorage = context?.storage.some(({ edge }) => edge.permissions?.write);
    if (
      context?.agent.config.conversationPersistence === "connected-storage" &&
      writableStorage
    ) {
      const finalPath = await this.store.writeRunArtifact(
        runId,
        "final.md",
        `# ${run.objective}\n\n${result}\n`,
      );
      const conversationPath = await this.store.writeRunArtifact(
        runId,
        "conversation.json",
        `${JSON.stringify(
          {
            runId,
            topologyId: run.topologyId,
            messages: run.messages,
            workOrders: run.workOrders,
            metrics: run.metrics,
          },
          null,
          2,
        )}\n`,
      );
      run = await this.store.mutateRun(runId, (draft) => {
        draft.artifactPaths = [finalPath, conversationPath];
      });
    }
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    const existing = this.store.getRun(runId);
    if (!existing || ["completed", "failed"].includes(existing.status)) return;
    const message = error instanceof Error ? error.message : String(error);
    await this.store.mutateRun(runId, (run) => {
      run.status = "failed";
      run.error = message;
      run.completedAt = now();
      run.metrics.elapsedMs = Date.now() - new Date(run.createdAt).getTime();
      run.events.push(event("run_failed", message));
    });
  }
}
