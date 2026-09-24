import { describe, expect, it } from "vitest";
import { resolveArtifact, visibleOrders } from "../src/server/artifact-policy.js";
import { runSchema, workOrderSchema, type Run, type WorkOrder } from "../src/shared/contracts.js";
import { harness, orderFor, terminalRun } from "./helpers.js";

const at = "2026-09-24T00:00:00.000Z";

function order(id: string, patch: Partial<WorkOrder> = {}): WorkOrder {
  return workOrderSchema.parse({
    id,
    runId: "run",
    parentId: null,
    senderAgentId: null,
    assigneeAgentId: `agent-${id}`,
    objective: `objective ${id}`,
    requiredInputs: [],
    constraints: [],
    allowedResources: [],
    dependencies: [],
    expectedOutput: "",
    outputLocation: "",
    priority: 50,
    status: "completed",
    returnRelationship: "delegate",
    returnToAgentId: null,
    result: `RESULT OF ${id}`,
    error: null,
    createdAt: at,
    startedAt: at,
    completedAt: at,
    ...patch,
  });
}

function run(workOrders: WorkOrder[], toolCalls: unknown[] = []): Run {
  return runSchema.parse({
    id: "run",
    topologyId: "t",
    entryAgentId: "agent-root",
    objective: "x",
    status: "running",
    workOrders,
    messages: [],
    events: [],
    result: null,
    error: null,
    artifactPaths: [],
    metrics: { modelCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 },
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    toolCalls,
  });
}

/**
 * root ─┬─ builder (delegate, completed)
 *       ├─ writer  (delegate, completed)
 *       ├─ consult (consult, running)
 *       └─ review  (review of builder, depends on builder)
 */
function team(): Run {
  return run([
    order("root", { returnRelationship: "root", status: "waiting", result: null }),
    order("builder", { parentId: "root" }),
    order("writer", { parentId: "root" }),
    order("consult", { parentId: "root", returnRelationship: "consult", status: "running", result: null, draft: "half-written advice" }),
    order("review", { parentId: "root", returnRelationship: "review", status: "queued", result: null, dependencies: ["builder"], subjectOrderIds: ["builder"] }),
  ]);
}

describe("read_artifact information-flow policy (audit A2)", () => {
  it("denies a sibling's output even when its ID is known", () => {
    const state = team();
    const consult = state.workOrders.find((item) => item.id === "consult")!;
    for (const sibling of ["builder", "writer", "review"]) {
      const decision = resolveArtifact(state, consult, sibling);
      expect(decision.allowed).toBe(false);
    }
    const writer = state.workOrders.find((item) => item.id === "writer")!;
    expect(resolveArtifact(state, writer, "builder").allowed).toBe(false);
  });

  it("denies a child reading its parent and an unrelated order reading a running order", () => {
    const state = team();
    const builder = state.workOrders.find((item) => item.id === "builder")!;
    expect(resolveArtifact(state, builder, "root").allowed).toBe(false);
    const root = state.workOrders.find((item) => item.id === "root")!;
    // The parent may read children, but not the half-written output of one still running.
    const running = resolveArtifact(state, root, "consult");
    expect(running).toMatchObject({ allowed: false });
    expect(resolveArtifact(state, root, "builder")).toMatchObject({ allowed: true, grant: "child", content: "RESULT OF builder" });
  });

  it("allows a reviewer to read its subject and dependency", () => {
    const state = team();
    const review = state.workOrders.find((item) => item.id === "review")!;
    expect(resolveArtifact(state, review, "builder")).toMatchObject({ allowed: true, content: "RESULT OF builder" });
    expect(resolveArtifact(state, review, "writer").allowed).toBe(false);
  });

  it("resolves a subject through a handoff to the work actually delivered", () => {
    const state = run([
      order("root", { returnRelationship: "root", status: "waiting", result: null }),
      order("builder", { parentId: "root", status: "handed_off", handedOffToOrderId: "successor", result: "Handed off" }),
      order("successor", { parentId: "root", returnRelationship: "handoff", handoffFromOrderId: "builder", result: "SUCCESSOR WORK" }),
      order("review", { parentId: "root", returnRelationship: "review", status: "queued", result: null, subjectOrderIds: ["builder"] }),
    ]);
    const review = state.workOrders.find((item) => item.id === "review")!;
    expect(resolveArtifact(state, review, "successor")).toMatchObject({ allowed: true, content: "SUCCESSOR WORK" });
    // The successor may read the order it took over.
    const successor = state.workOrders.find((item) => item.id === "successor")!;
    expect(resolveArtifact(state, successor, "builder")).toMatchObject({ allowed: true, grant: "handoff" });
  });

  it("allows a revision to read the version it revises and the review that asked for it", () => {
    const state = run([
      order("root", { returnRelationship: "root", status: "waiting", result: null }),
      order("v1", { parentId: "root", status: "superseded", supersededByOrderId: "v2", result: "FIRST VERSION" }),
      order("review1", { parentId: "root", returnRelationship: "review", subjectOrderIds: ["v1"], result: "please revise" }),
      order("v2", { parentId: "root", revisionOf: "v1", status: "running", result: null }),
      order("other", { parentId: "root" }),
    ]);
    const revision = state.workOrders.find((item) => item.id === "v2")!;
    expect(resolveArtifact(state, revision, "v1")).toMatchObject({ allowed: true, grant: "revision", content: "FIRST VERSION" });
    expect(resolveArtifact(state, revision, "review1")).toMatchObject({ allowed: true, grant: "review" });
    expect(resolveArtifact(state, revision, "other").allowed).toBe(false);
    expect([...visibleOrders(state, revision).keys()].sort()).toEqual(["review1", "v1", "v2"]);
  });

  it("scopes tool results to the order that made the call", () => {
    const call = (id: string, workOrderId: string) => ({
      id,
      workOrderId,
      agentId: "a",
      toolName: "t",
      targetName: "t",
      sourceKind: "builtin" as const,
      effect: "none" as const,
      status: "succeeded" as const,
      turnIndex: 0,
      callIndex: 0,
      providerCallId: "c",
      argumentsPreview: "{}",
      result: `TOOL OUTPUT ${id}`,
      createdAt: at,
    });
    const state = run(team().workOrders, [call("op-builder", "builder"), call("op-writer", "writer")]);
    const builder = state.workOrders.find((item) => item.id === "builder")!;
    expect(resolveArtifact(state, builder, "tool:op-builder")).toMatchObject({ allowed: true, content: "TOOL OUTPUT op-builder" });
    expect(resolveArtifact(state, builder, "tool:op-writer").allowed).toBe(false);
  });

  it("limits thread history to the root chain and to prior roots only", () => {
    const state = team();
    const prior = { runId: "prior-run", order: order("prior-root", { returnRelationship: "root", result: "PRIOR FINAL" }) };
    const root = state.workOrders.find((item) => item.id === "root")!;
    const builder = state.workOrders.find((item) => item.id === "builder")!;
    expect(resolveArtifact(state, root, "prior-root", [prior])).toMatchObject({ allowed: true, grant: "thread", content: "PRIOR FINAL" });
    expect(resolveArtifact(state, builder, "prior-root", [prior]).allowed).toBe(false);
    expect(resolveArtifact(state, root, "some-inner-order-of-prior-run", [prior]).allowed).toBe(false);
  });
});

describe("read_artifact in a running system", () => {
  it("denies prior-run internals, allows the prior root, and records the denial", async () => {
    const { store, runtime } = await harness();
    const first = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "Build the implementation plan.",
      })).id,
    );
    const builderOrder = orderFor(first, "agent-builder")[0]!;
    const priorRoot = first.workOrders[0]!;
    const second = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: `[direct] Follow up. read artifact ${builderOrder.id} read artifact ${priorRoot.id}`,
        previousRunId: first.id,
      })).id,
    );
    expect(second.status).toBe("completed");
    const reads = second.toolCalls.filter((call) => call.targetName === "read_artifact");
    expect(reads).toHaveLength(2);
    const denied = reads.find((call) => call.argumentsPreview.includes(builderOrder.id))!;
    const allowed = reads.find((call) => call.argumentsPreview.includes(priorRoot.id))!;
    expect(denied.status).toBe("failed");
    expect(denied.error).toMatch(/knowing its ID is not enough/);
    expect(allowed.status).toBe("succeeded");
    expect(allowed.result).toBe(priorRoot.result);
    expect(second.events.some((item) => item.type === "topology_boundary" && item.message.includes("Artifact access denied"))).toBe(true);
  });
});
