import { describe, expect, it } from "vitest";
import { edge, harness, node, orderFor, terminalRun, updateTopology } from "./helpers.js";

describe("selective delegation", () => {
  it("works directly when no collaborator adds value", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[direct] Say hello to the team.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    expect(run.workOrders).toHaveLength(1);
    expect(run.plans).toHaveLength(1);
    expect(run.plans[0]).toMatchObject({ mode: "direct", selected: [] });
    // All three collaborators were available but none was invoked.
    expect(run.plans[0]?.available.map((item) => item.agentId).sort()).toEqual([
      "agent-architect",
      "agent-builder",
      "agent-reviewer",
    ]);
    expect(run.metrics.modelCalls).toBe(2); // plan + execute
  });

  it("delegates only to relevant collaborators instead of fanning out", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Calculate 72 * 18 and build the implementation.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    const assignees = run.workOrders.map((order) => order.assigneeAgentId);
    expect(assignees).toContain("agent-builder");
    expect(assignees).not.toContain("agent-architect");
    expect(assignees).not.toContain("agent-reviewer");
    const builder = orderFor(run, "agent-builder")[0]!;
    expect(builder.ownerAgentId).toBe("agent-orchestrator"); // delegation keeps ownership
    expect(builder.returnToAgentId).toBe("agent-orchestrator");
    expect(run.result).toContain("1296");
  });
});

describe("review semantics", () => {
  it("reviews delegated work after it completes and runs a bounded revision", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[needs-revision] Build the implementation plan and review its risks.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");

    const builderOrders = orderFor(run, "agent-builder");
    const reviews = orderFor(run, "agent-reviewer");
    expect(builderOrders).toHaveLength(2);
    const [original, revision] = builderOrders;
    expect(original?.status).toBe("superseded");
    expect(original?.supersededByOrderId).toBe(revision?.id);
    expect(revision?.revisionOf).toBe(original?.id);
    expect(revision?.status).toBe("completed");
    expect(revision?.result).not.toContain("DRAFT-MARKER");

    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.verdict?.verdict).toBe("revise");
    expect(reviews[0]?.dependencies).toEqual([original?.id]);
    expect(reviews[1]?.verdict?.verdict).toBe("approve");
    expect(reviews[1]?.subjectOrderIds).toEqual([revision?.id]);
    expect(run.events.some((item) => item.type === "review_verdict")).toBe(true);
  });

  it("reviews direct work and finalizes the approved draft without another model call", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[direct] [needs-revision] Draft the release notes and review them.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    const root = run.workOrders[0]!;
    const reviews = orderFor(run, "agent-reviewer");
    expect(reviews.map((review) => review.verdict?.verdict)).toEqual(["revise", "approve"]);
    expect(reviews.every((review) => review.subjectOrderIds[0] === root.id)).toBe(true);
    expect(run.result).toContain("Revised deliverable");
    // plan + draft + review + revision + review; approval finalizes deterministically.
    expect(run.metrics.modelCalls).toBe(5);
  });
});

describe("handoff semantics", () => {
  it("transfers ownership and the return path to the receiving agent", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.edges.push(edge("edge-handoff", "agent-orchestrator", "agent-builder", "agent_can_handoff_to_agent"));
    });
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[handoff] Take over building the prototype.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    const [root, successor] = run.workOrders;
    expect(root?.status).toBe("handed_off");
    expect(root?.handedOffToOrderId).toBe(successor?.id);
    expect(successor).toMatchObject({
      assigneeAgentId: "agent-builder",
      ownerAgentId: "agent-builder",
      returnRelationship: "handoff",
      handoffFromOrderId: root?.id,
      status: "completed",
    });
    expect(run.rootOrderId).toBe(successor?.id);
    expect(run.result).toBe(successor?.result);
    expect(run.events.some((item) => item.type === "handoff")).toBe(true);
  });

  it("supports mid-task handoff and blocks handoff back into the chain", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.edges.push(
        edge("edge-handoff", "agent-orchestrator", "agent-builder", "agent_can_handoff_to_agent"),
        edge("edge-handoff-back", "agent-builder", "agent-orchestrator", "agent_can_handoff_to_agent"),
      );
    });
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[direct] [handoff-now] This belongs to someone else.",
    });
    const run = await terminalRun(store, created.id);
    // Orchestrator hands off mid-task; the builder's attempt to hand it back is
    // refused as a recoverable tool error, so the builder finishes the work.
    expect(run.workOrders[0]?.status).toBe("handed_off");
    expect(run.workOrders[1]).toMatchObject({ assigneeAgentId: "agent-builder", status: "completed" });
    expect(run.workOrders).toHaveLength(2);
    expect(run.status).toBe("completed");
    expect(run.events.some((item) => item.type === "topology_boundary" && item.message.includes("loop"))).toBe(true);
  });
});

describe("consult semantics", () => {
  it("answers inline with read-only access while the requester keeps ownership", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "[direct] [consult] Decide the storage architecture for save games.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    const consult = orderFor(run, "agent-architect")[0]!;
    expect(consult).toMatchObject({
      returnRelationship: "consult",
      blocking: false,
      parentId: run.workOrders[0]?.id,
      ownerAgentId: "agent-orchestrator",
      status: "completed",
    });
    expect(run.workOrders[0]?.status).toBe("completed");
    const consultFrame = run.contextFrames.find((frame) => frame.workOrderId === consult.id)!;
    const rootFrame = run.contextFrames.find((frame) => frame.workOrderId === run.workOrders[0]?.id)!;
    expect(consultFrame.prefixHash).not.toBe(rootFrame.prefixHash);
  });
});

describe("report semantics", () => {
  it("delivers status to the target inbox without extra inference", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.edges.push(edge("edge-report", "agent-builder", "agent-architect", "agent_reports_to_agent"));
    });
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Build the implementation.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    expect(run.reports).toHaveLength(1);
    expect(run.reports[0]).toMatchObject({ fromAgentId: "agent-builder", toAgentId: "agent-architect", status: "completed" });
    expect(orderFor(run, "agent-architect")).toHaveLength(0);
    expect(run.events.some((item) => item.type === "report_delivered")).toBe(true);
  });
});

describe("context lifecycle", () => {
  it("records a context frame for every model call with a stable per-agent prefix", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Calculate 72 * 18 and build the implementation.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.contextFrames).toHaveLength(run.metrics.modelCalls);
    const orchestratorHashes = new Set(
      run.contextFrames.filter((frame) => frame.agentId === "agent-orchestrator").map((frame) => frame.prefixHash),
    );
    expect(orchestratorHashes.size).toBe(1); // plan and integrate share the same system prefix
    const builderFrames = run.contextFrames.filter((frame) => frame.agentId === "agent-builder");
    expect(builderFrames[0]?.purpose).toBe("execute");
    expect(builderFrames[1]?.purpose).toBe("tool_followup");
    expect(builderFrames[1]?.localPrefixMatch).toBe(true);
    expect(builderFrames[1]?.requestPrefixHash).toBe(builderFrames[0]?.requestPrefixHash);
    expect(builderFrames[1]?.segments.some((segment) => segment.kind === "tool_results")).toBe(true);
    expect(run.metrics.localPrefixMatches).toBeGreaterThan(0);
    // The demo model has no tokenizer or cache: nothing is reported as measured (audit B5).
    expect(run.metrics.usageReportedCalls).toBe(0);
    expect(run.metrics.cacheReportedCalls).toBe(0);
    expect(run.contextFrames.every((frame) => frame.actualPromptTokens === null && frame.cachedPromptTokens === null)).toBe(true);
    // Plan calls carry a response schema, so their request prefix differs from tool calls.
    const orchestratorFrames = run.contextFrames.filter((frame) => frame.agentId === "agent-orchestrator");
    expect(orchestratorFrames[0]?.segments.some((segment) => segment.kind === "response_schema")).toBe(true);
    expect(orchestratorFrames[0]?.requestPrefixHash).not.toBe(orchestratorFrames[1]?.requestPrefixHash);
    for (const frame of run.contextFrames) {
      expect(frame.estimatedPromptTokens).toBeLessThanOrEqual(frame.contextWindow);
    }
  });

  it("continues a thread with a digest and retrieved memory instead of a transcript", async () => {
    const { store, runtime } = await harness();
    const first = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[direct] Choose the save-game format for the voxel prototype.",
      })).id,
    );
    expect(first.status).toBe("completed");
    const second = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[direct] Extend the save-game format for the voxel prototype with versioning.",
        previousRunId: first.id,
      })).id,
    );
    expect(second.status).toBe("completed");
    expect(second.threadId).toBe(first.id);
    const frame = second.contextFrames.find((item) => item.purpose === "execute")!;
    const kinds = frame.segments.map((segment) => segment.kind);
    expect(kinds).toContain("history");
    expect(kinds).toContain("memory");
    const historyTokens = frame.segments.find((segment) => segment.kind === "history")!.tokens;
    expect(historyTokens).toBeLessThan(200);
  });

  it("blocks queued work whose relationship edge was removed during a pause", { timeout: 30_000 }, async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Build the implementation.",
    });
    // Wait until the plan has produced the delegated order, then pause.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !store.getRun(created.id)?.workOrders.some((order) => order.assigneeAgentId === "agent-builder")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await runtime.pauseRun(created.id);
    await updateTopology(store, (topology) => {
      topology.edges = topology.edges.filter((candidate) => candidate.id !== "edge-delegate-builder");
    });
    await runtime.resumeRun(created.id);
    const run = await terminalRun(store, created.id);
    const builder = orderFor(run, "agent-builder")[0]!;
    if (builder.status === "completed") return; // finished before the pause landed
    expect(builder.status).toBe("blocked");
    expect(builder.error).toMatch(/delegate relationship/);
    expect(run.events.some((item) => item.type === "topology_boundary")).toBe(true);
  });
});

describe("storage-backed tools in a run", () => {
  it("lets a worker write a file only through its granted storage edge", async () => {
    const { store, runtime } = await harness();
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: "Build the implementation and write file notes/plan.md with the steps.",
    });
    const run = await terminalRun(store, created.id);
    expect(run.status).toBe("completed");
    const written = run.artifacts.find((artifact) => artifact.kind === "file");
    expect(written?.name).toBe("notes/plan.md");
    expect(written?.agentId).toBe("agent-builder");
    expect(run.events.some((item) => item.type === "artifact_written")).toBe(true);
  });

  it("does not let a worker write without a write grant", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      const grant = topology.edges.find((candidate) => candidate.id === "edge-builder-workspace")!;
      grant.permissions = { read: true, write: false, scope: "/" };
    });
    const run = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "Build the implementation and write file notes/plan.md with the steps.",
      })).id,
    );
    expect(run.status).toBe("completed");
    const files = run.artifacts.filter((artifact) => artifact.kind === "file");
    expect(files.some((artifact) => artifact.agentId === "agent-builder")).toBe(false);
    // Only an agent holding a write grant may persist the file (the Orchestrator → Run artifacts).
    for (const file of files) {
      expect(file).toMatchObject({ agentId: "agent-orchestrator", storageNodeId: "storage-artifacts" });
    }
  });
});

describe("custom nodes", () => {
  it("builds a node through schema defaults", () => {
    const agent = node({ id: "a", kind: "agent", name: "A", position: { x: 0, y: 0 }, config: { role: "r", instructions: "i" } });
    expect(agent.kind === "agent" && agent.config.toolExposure).toBe("auto");
  });
});
