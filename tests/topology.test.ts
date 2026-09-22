import { describe, expect, it } from "vitest";
import { createDemoTopology } from "../src/shared/demo-topology.js";
import {
  getAgentContext,
  isLegalEdge,
  suggestedRelationship,
  validateTopology,
} from "../src/shared/topology.js";
import { evaluateArithmetic } from "../src/server/tools.js";

describe("capability topology", () => {
  it("accepts the seeded topology as runnable", () => {
    const topology = createDemoTopology();
    expect(validateTopology(topology).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("requires each agent to have exactly one connected model", () => {
    const topology = createDemoTopology();
    topology.edges = topology.edges.filter((edge) => edge.id !== "edge-builder-model");
    expect(validateTopology(topology)).toContainEqual(
      expect.objectContaining({ code: "agent_without_model", nodeId: "agent-builder" }),
    );
  });

  it("derives legal relationship types from node kinds", () => {
    const topology = createDemoTopology();
    const agent = topology.nodes.find((node) => node.id === "agent-orchestrator")!;
    const storage = topology.nodes.find((node) => node.id === "storage-artifacts")!;
    const model = topology.nodes.find((node) => node.id === "model-demo")!;

    expect(suggestedRelationship(agent, storage)).toBe("agent_can_access_storage");
    expect(suggestedRelationship(agent, model)).toBe("agent_uses_model");
    expect(isLegalEdge(storage, agent, "agent_can_access_storage")).toBe(false);
  });

  it("exposes only resources connected to the requested agent", () => {
    const topology = createDemoTopology();
    const builder = getAgentContext(topology, "agent-builder")!;
    const reviewer = getAgentContext(topology, "agent-reviewer")!;

    expect(builder.capabilities.map((node) => node.id)).toEqual(["capability-calculator"]);
    expect(reviewer.capabilities).toEqual([]);
    expect(reviewer.allowedResourceIds).not.toContain("capability-calculator");
  });
});

describe("calculator capability", () => {
  it("evaluates arithmetic without executing arbitrary code", () => {
    expect(evaluateArithmetic("72 * 18")).toBe(1296);
    expect(evaluateArithmetic("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluateArithmetic("-(4 + 3) * 2")).toBe(-14);
    expect(() => evaluateArithmetic("process.exit()")) .toThrow(/unsupported characters/i);
    expect(() => evaluateArithmetic("1 / 0")).toThrow(/division by zero/i);
  });
});
