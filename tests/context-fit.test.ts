import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ContextBudgetError, dynamicSegment, fitToolTail, packContext, toolTailBudget } from "../src/server/context-builder.js";
import type { ChatMessage, ModelNode } from "../src/shared/contracts.js";
import { createDemoTopology } from "../src/shared/demo-topology.js";
import { buildStablePrefix } from "../src/shared/prompt.js";
import { getAgentContext } from "../src/shared/topology.js";
import { edge, harness, node, terminalRun, updateTopology } from "./helpers.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");

function smallModel(contextWindow: number): ModelNode {
  const created = node({ id: "model-small", kind: "model", name: "Small", position: { x: 0, y: 0 }, config: { provider: "mock", modelId: "small", contextWindow } });
  if (created.kind !== "model") throw new Error("expected model");
  return created;
}

function packedFor(contextWindow: number) {
  const topology = createDemoTopology();
  const context = getAgentContext(topology, "agent-reviewer")!;
  const agent = { ...context.agent, config: { ...context.agent.config, maxOutputTokens: 256 } };
  const prefix = buildStablePrefix(context, [], { accessMode: "read-only", allowCollaboration: false });
  return packContext(prefix, [dynamicSegment("work_order", "Work order", "OBJECTIVE\nSummarize the reports.", 100)], smallModel(contextWindow), agent);
}

function turn(index: number, resultTokens: number): ChatMessage[] {
  return [
    { role: "assistant", content: null, toolCalls: [{ id: `c${index}`, type: "function", function: { name: "report", arguments: "{}" } }] },
    { role: "tool", name: "report", toolCallId: `c${index}`, operationId: `op-${index}`, content: `REPORT ${index} ` + "measurement ".repeat(resultTokens) },
  ];
}

describe("tool-loop context fitting (audit B1)", () => {
  it("keeps every follow-up call inside the window by eliding, truncating, and dropping old turns", () => {
    const packed = packedFor(3_072);
    const budget = toolTailBudget(packed);
    const tail = [...turn(1, 900), ...turn(2, 900), ...turn(3, 900)];
    const fitted = fitToolTail(packed, tail);
    expect(fitted.tailTokens).toBeLessThanOrEqual(budget);
    expect(fitted.elided).toBeGreaterThan(0);
    const contents = fitted.messages.map((message) => message.content ?? "").join("\n");
    // Older results become references the worker can still follow.
    expect(contents).toContain('read_artifact("tool:op-1")');
    // The newest result is kept (possibly truncated) rather than dropped.
    expect(contents).toContain("REPORT 3");
    // The caller's tail is not mutated.
    expect(tail[1]?.content).toContain("measurement");
  });

  it("leaves a tail that already fits untouched", () => {
    const packed = packedFor(8_192);
    const tail = turn(1, 50);
    const fitted = fitToolTail(packed, tail);
    expect(fitted.elided).toBe(0);
    expect(fitted.messages).toEqual(tail);
  });

  it("refuses to send a call that cannot fit instead of overflowing the provider", () => {
    const packed = packedFor(2_048);
    const giant: ChatMessage[] = [
      { role: "assistant", content: "x ".repeat(4_000), toolCalls: [{ id: "c", type: "function", function: { name: "report", arguments: "{}" } }] },
    ];
    expect(() => fitToolTail(packed, giant)).toThrow(ContextBudgetError);
  });

  it("fits repeated large MCP results into a small model window during a real run", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      const model = topology.nodes.find((candidate) => candidate.id === "model-demo");
      if (model?.kind === "model") model.config.contextWindow = 4_096;
      const orchestrator = topology.nodes.find((candidate) => candidate.id === "agent-orchestrator");
      if (orchestrator?.kind === "agent") orchestrator.config.maxOutputTokens = 400;
      topology.nodes.push(
        node({
          id: "connector-reports",
          kind: "connector",
          name: "Reports",
          position: { x: 0, y: 0 },
          config: { connectorType: "mcp", transport: "stdio", command: process.execPath, args: [fixturePath, "0"], enabled: true, timeoutMs: 20_000 },
        }),
      );
      topology.edges.push(edge("edge-reports", "agent-orchestrator", "connector-reports", "agent_can_use_connector"));
    });
    const run = await terminalRun(
      store,
      (await runtime.createRun({
        topologyId: "topology-local-studio",
        entryAgentId: "agent-orchestrator",
        objective: "[direct] use tool big_payload_a use tool big_payload_b use tool big_payload_c",
      })).id,
      40_000,
    );
    expect(run.status).toBe("completed");
    const payloadCalls = run.toolCalls.filter((call) => call.targetName.includes("big_payload"));
    expect(payloadCalls.filter((call) => call.status === "succeeded")).toHaveLength(3);
    // Full (connector-bounded) results remain in the ledger for read_artifact tool:<id>.
    expect(payloadCalls.every((call) => (call.result?.length ?? 0) > 5_000)).toBe(true);
    const frames = run.contextFrames.filter((frame) => frame.agentId === "agent-orchestrator");
    for (const frame of frames) {
      expect(frame.estimatedPromptTokens + Math.min(frame.reservedOutputTokens, frame.contextWindow / 2)).toBeLessThanOrEqual(frame.contextWindow);
    }
    expect(frames.some((frame) => frame.elidedToolResults > 0)).toBe(true);
    expect(frames.some((frame) => frame.segments.some((segment) => segment.kind === "tool_results" && segment.trimmed))).toBe(true);
  }, 60_000);
});
