import { describe, expect, it } from "vitest";
import { REVIEW_MAX_ATTEMPTS, parseVerdict } from "../src/server/runtime.js";
import { edge, harness, orderFor, terminalRun, updateTopology } from "./helpers.js";

describe("strict verdict parsing (audit A4)", () => {
  it("never infers a verdict from prose or partial output", () => {
    expect(parseVerdict("I could not inspect the files.")).toBeNull();
    expect(parseVerdict("Looks good to me, approve.")).toBeNull();
    expect(parseVerdict('{"verdict": "approve"')).toBeNull();
    expect(parseVerdict('{"verdict": "ship-it", "summary": "x", "findings": []}')).toBeNull();
    expect(parseVerdict("")).toBeNull();
    // The reserved value cannot be chosen by a reviewer.
    expect(parseVerdict('{"verdict": "indeterminate", "summary": "x", "findings": []}')).toBeNull();
  });

  it("accepts schema-valid verdicts, including fenced JSON", () => {
    expect(parseVerdict('{"verdict":"approve","summary":"ok","findings":[]}')?.verdict).toBe("approve");
    expect(parseVerdict('Here you go:\n```json\n{"verdict":"reject","summary":"no","findings":[]}\n```')?.verdict).toBe("reject");
    expect(
      parseVerdict('{"verdict":"revise","summary":"fix","findings":[{"severity":"major","issue":"a","recommendation":"b"}]}')
        ?.findings,
    ).toHaveLength(1);
  });
});

describe("review fails closed in a running system (audit A4)", () => {
  it("marks direct work unreviewed when the reviewer returns prose", async () => {
    const { store, runtime } = await harness();
    const run = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[direct] [review-garbage] Draft the release notes and review them.",
      })).id,
    );
    expect(run.status).toBe("completed");
    const root = run.workOrders[0]!;
    const review = orderFor(run, "agent-reviewer")[0]!;
    expect(review.status).toBe("failed");
    expect(review.verdict?.verdict).toBe("indeterminate");
    expect(review.error).toMatch(/did not return a valid verdict/);
    // Bounded retries: the reviewer was asked more than once, then stopped.
    const reviewCalls = run.contextFrames.filter((frame) => frame.workOrderId === review.id);
    expect(reviewCalls).toHaveLength(REVIEW_MAX_ATTEMPTS);
    expect(root.reviewOutcome).toBe("indeterminate");
    expect(run.result).toContain("Review could not be completed");
    expect(run.result).toContain("has not been independently reviewed");
    expect(run.events.some((item) => item.type === "review_indeterminate")).toBe(true);
  });

  it("tells the integrator that delegated work was not reviewed", async () => {
    const { store, runtime } = await harness();
    const run = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[review-garbage] Build the implementation plan and review its risks.",
      })).id,
    );
    expect(run.status).toBe("completed");
    const review = orderFor(run, "agent-reviewer")[0]!;
    expect(review.verdict?.verdict).toBe("indeterminate");
    expect(run.workOrders[0]?.reviewOutcome).toBe("indeterminate");
    expect(run.result).toContain("REVIEW COULD NOT BE COMPLETED");
  });

  it("keeps an approved review distinguishable from a failed one", async () => {
    const { store, runtime } = await harness();
    const run = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[direct] Draft the release notes and review them.",
      })).id,
    );
    expect(run.workOrders[0]?.reviewOutcome).toBe("approved");
    expect(run.result).not.toContain("Review could not be completed");
  });
});

describe("review after handoff (audit B2)", () => {
  it("reviews the successor's delivered work, not the handoff notice", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.edges.push(edge("edge-builder-handoff", "agent-builder", "agent-architect", "agent_can_handoff_to_agent"));
    });
    const run = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[handoff-now] Build the implementation plan and review its risks.",
      })).id,
    );
    expect(run.status).toBe("completed");
    const original = orderFor(run, "agent-builder")[0]!;
    const successor = run.workOrders.find((order) => order.handoffFromOrderId === original.id)!;
    const review = orderFor(run, "agent-reviewer")[0]!;
    expect(original.status).toBe("handed_off");
    expect(successor.status).toBe("completed");
    // The queued review was retargeted in the same transaction as the handoff.
    expect(review.dependencies).toEqual([successor.id]);
    expect(review.subjectOrderIds).toEqual([successor.id]);
    // It ran only after the successor finished.
    expect(new Date(review.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(successor.completedAt!).getTime());
    const reviewFrame = run.contextFrames.find((frame) => frame.workOrderId === review.id)!;
    expect(reviewFrame).toBeDefined();
    expect(review.verdict?.verdict).toBe("approve");
    expect(run.events.some((item) => item.type === "handoff" && item.message.includes("now track the successor"))).toBe(true);
  });
});
