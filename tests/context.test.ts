import { describe, expect, it } from "vitest";
import {
  connectorFingerprint,
  planToolExposure,
  resolveToolDescriptors,
  searchDescriptors,
} from "../src/shared/capabilities.js";
import type { ConnectorCatalog, ConnectorNode, Topology } from "../src/shared/contracts.js";
import { createDemoTopology } from "../src/shared/demo-topology.js";
import { buildStablePrefix, estimateAgentFootprint } from "../src/shared/prompt.js";
import { estimateTokens, truncateToTokens } from "../src/shared/tokens.js";
import { getAgentContext, validateTopology } from "../src/shared/topology.js";
import { ContextBudgetError, dynamicSegment, packContext, summarize } from "../src/server/context-builder.js";
import { edge, node } from "./helpers.js";

function withConnector(toolCount: number): { topology: Topology; catalogs: ConnectorCatalog[] } {
  const topology = createDemoTopology();
  const connector = topology.nodes.find((candidate) => candidate.id === "connector-mcp") as ConnectorNode;
  connector.config.enabled = true;
  const catalog: ConnectorCatalog = {
    connectorId: connector.id,
    fingerprint: connectorFingerprint(connector),
    fetchedAt: new Date().toISOString(),
    serverName: "fixture",
    serverVersion: "1",
    error: null,
    tools: Array.from({ length: toolCount }, (_, index) => ({
      name: `tool_${String(index).padStart(3, "0")}`,
      title: "",
      description: `Fixture tool ${index}. Performs operation ${index} on a repository resource and returns a status report.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, mode: { type: "string", enum: ["a", "b", "c"] } },
        required: ["id"],
      },
      readOnly: index % 2 === 0,
      destructive: index % 2 === 1,
    })),
  };
  return { topology, catalogs: [catalog] };
}

describe("stable prefix construction", () => {
  it("is byte-identical regardless of edge and node insertion order", () => {
    const topology = createDemoTopology();
    const shuffled = structuredClone(topology);
    shuffled.edges.reverse();
    shuffled.nodes.reverse();
    const options = { accessMode: "full" as const, allowCollaboration: true };
    const a = buildStablePrefix(getAgentContext(topology, "agent-orchestrator")!, [], options);
    const b = buildStablePrefix(getAgentContext(shuffled, "agent-orchestrator")!, [], options);
    expect(b.system).toBe(a.system);
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
  });

  it("contains topology-derived material only, in a fixed segment order", () => {
    const prefix = buildStablePrefix(getAgentContext(createDemoTopology(), "agent-builder")!, [], {
      accessMode: "full",
      allowCollaboration: true,
    });
    expect(prefix.segments.map((segment) => segment.kind)).toEqual([
      "harness",
      "worker",
      "skills",
      "skill_catalog",
      "collaborators",
      "resources",
      "tool_schemas",
    ]);
    expect(prefix.system).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamps
    expect(prefix.system).toContain("Release checklist"); // on-demand skill is catalogued…
    expect(prefix.system).not.toContain("changelog"); // …but its body is not loaded
    expect(prefix.tools.map((tool) => tool.function.name)).toContain("load_skill");
  });

  it("narrows tools for read-only work and drops collaboration", () => {
    const context = getAgentContext(createDemoTopology(), "agent-builder")!;
    const full = buildStablePrefix(context, [], { accessMode: "full", allowCollaboration: true });
    const readOnly = buildStablePrefix(context, [], { accessMode: "read-only", allowCollaboration: false });
    const names = (prefix: typeof full) => prefix.tools.map((tool) => tool.function.name);
    expect(names(full).some((name) => name.endsWith("_write"))).toBe(true);
    expect(names(readOnly).some((name) => name.endsWith("_write"))).toBe(false);
    expect(names(full)).toContain("consult_agent");
    expect(names(readOnly)).not.toContain("consult_agent");
    expect(readOnly.system).toContain("read-only access");
  });
});

describe("deferred capability exposure", () => {
  it("keeps a small tool set eager", () => {
    const topology = createDemoTopology();
    const context = getAgentContext(topology, "agent-builder")!;
    const plan = planToolExposure(context.agent, resolveToolDescriptors(context, []));
    expect(plan.mode).toBe("eager");
    expect(plan.native.map((descriptor) => descriptor.name)).toContain("calculator_evaluate");
  });

  it("does not inject 150 connector schemas into every request", () => {
    const { topology, catalogs } = withConnector(150);
    const context = getAgentContext(topology, "agent-orchestrator")!;
    const prefix = buildStablePrefix(context, catalogs, { accessMode: "full", allowCollaboration: true });
    expect(prefix.exposure.mode).toBe("deferred");
    expect(prefix.descriptors.length).toBeGreaterThanOrEqual(150);
    const toolNames = prefix.tools.map((tool) => tool.function.name);
    expect(toolNames).toContain("find_tools");
    expect(toolNames).toContain("call_tool");
    expect(toolNames.some((name) => name.startsWith("mcp_"))).toBe(false);
    // Large catalogs are summarised by group rather than listed tool by tool.
    expect(prefix.system).toMatch(/TOOL CATALOG \(\d+ tools; search with find_tools\)/);

    const footprint = estimateAgentFootprint(topology, "agent-orchestrator", catalogs)!;
    expect(footprint.exposure).toBe("deferred");
    expect(footprint.deferredSchemaTokens).toBeGreaterThan(footprint.stableTokens * 3);
  });

  it("lists moderate catalogs by name and summary", () => {
    const { topology, catalogs } = withConnector(12);
    const prefix = buildStablePrefix(getAgentContext(topology, "agent-orchestrator")!, catalogs, {
      accessMode: "full",
      allowCollaboration: true,
    });
    expect(prefix.exposure.mode).toBe("deferred");
    expect(prefix.system).toContain("- mcp_mcp_server__tool_003: Fixture tool 3.");
  });

  it("honours the connector allowlist and read-only annotations", () => {
    const { topology, catalogs } = withConnector(10);
    const connector = topology.nodes.find((candidate) => candidate.id === "connector-mcp") as ConnectorNode;
    connector.config.toolAllowlist = ["tool_000", "tool_001", "tool_002"];
    const context = getAgentContext(topology, "agent-orchestrator")!;
    const full = resolveToolDescriptors(context, catalogs, "full").filter((d) => d.source.kind === "mcp");
    const readOnly = resolveToolDescriptors(context, catalogs, "read-only").filter((d) => d.source.kind === "mcp");
    expect(full.map((descriptor) => descriptor.source.kind === "mcp" && descriptor.source.toolName)).toEqual([
      "tool_000",
      "tool_001",
      "tool_002",
    ]);
    expect(readOnly.map((descriptor) => descriptor.source.kind === "mcp" && descriptor.source.toolName)).toEqual([
      "tool_000",
      "tool_002",
    ]);
  });

  it("ignores stale catalogs after the connector configuration changes", () => {
    const { topology, catalogs } = withConnector(5);
    const connector = topology.nodes.find((candidate) => candidate.id === "connector-mcp") as ConnectorNode;
    connector.config.endpoint = "http://127.0.0.1:9999/mcp";
    const context = getAgentContext(topology, "agent-orchestrator")!;
    expect(resolveToolDescriptors(context, catalogs).some((d) => d.source.kind === "mcp")).toBe(false);
  });

  it("finds tools by name and description deterministically", () => {
    const { topology, catalogs } = withConnector(30);
    const descriptors = resolveToolDescriptors(getAgentContext(topology, "agent-orchestrator")!, catalogs);
    const hits = searchDescriptors(descriptors, "tool_017");
    expect(hits[0]?.name).toBe("mcp_mcp_server__tool_017");
    expect(searchDescriptors(descriptors, "", ["mcp_mcp_server__tool_004"])[0]?.name).toBe("mcp_mcp_server__tool_004");
  });
});

describe("context packing", () => {
  const smallModel = () =>
    node({
      id: "model-small",
      kind: "model",
      name: "Small",
      position: { x: 0, y: 0 },
      config: { provider: "mock", modelId: "small", contextWindow: 1_600 },
    });

  it("compacts dynamic segments before truncating and never drops the work order", () => {
    const topology = createDemoTopology();
    const context = getAgentContext(topology, "agent-reviewer")!;
    const prefix = buildStablePrefix(context, [], { accessMode: "read-only", allowCollaboration: false });
    const model = smallModel();
    if (model.kind !== "model") throw new Error("expected model");
    const bulky = "Detailed specialist finding with evidence. ".repeat(400);
    const packed = packContext(
      prefix,
      [
        dynamicSegment("work_order", "Work order", "OBJECTIVE\nReview the plan.", 100),
        dynamicSegment("dependencies", "Specialist outputs", `SPECIALIST OUTPUTS\n${bulky}`, 50, "SPECIALIST OUTPUTS (summaries)\nShort summary."),
        dynamicSegment("memory", "Memory", `RELEVANT MEMORY\n${bulky}`, 20),
      ],
      model,
      { ...context.agent, config: { ...context.agent.config, maxOutputTokens: 256 } },
    );
    const total = packed.segments.filter((segment) => !segment.stable).reduce((sum, s) => sum + s.tokens, 0);
    expect(total).toBeLessThanOrEqual(packed.availableTokens);
    expect(packed.messages[1]?.content).toContain("Review the plan.");
    expect(packed.messages[1]?.content).toContain("Short summary.");
    expect(packed.trimmedLabels).toEqual(expect.arrayContaining(["Specialist outputs", "Memory"]));
  });

  it("explains which stable segments overflow a model window", () => {
    const { topology, catalogs } = withConnector(150);
    const context = getAgentContext(topology, "agent-orchestrator")!;
    context.agent.config.toolExposure = "eager";
    const prefix = buildStablePrefix(context, catalogs, { accessMode: "full", allowCollaboration: true });
    const model = smallModel();
    if (model.kind !== "model") throw new Error("expected model");
    expect(() =>
      packContext(prefix, [dynamicSegment("work_order", "Work order", "OBJECTIVE\nx", 100)], model, context.agent),
    ).toThrow(ContextBudgetError);
  });

  it("matches the Configure footprint to the runtime prefix", () => {
    const topology = createDemoTopology();
    const context = getAgentContext(topology, "agent-builder")!;
    const prefix = buildStablePrefix(context, [], { accessMode: "full", allowCollaboration: true });
    const footprint = estimateAgentFootprint(topology, "agent-builder", [])!;
    expect(footprint.segments.map((segment) => segment.tokens)).toEqual(prefix.segments.map((segment) => segment.tokens));
  });
});

describe("token utilities", () => {
  it("estimates punctuation-heavy JSON higher than prose of the same length", () => {
    const prose = "the quick brown fox jumps over the lazy dog ".repeat(10);
    const json = JSON.stringify({ a: [1, 2, 3], b: { c: "d", e: [true, false] } }).repeat(6).slice(0, prose.length);
    expect(estimateTokens(json)).toBeGreaterThan(estimateTokens(prose));
    expect(estimateTokens("")).toBe(0);
  });

  it("truncates to a budget and summarises extractively", () => {
    const text = "Paragraph one explains the result.\n\nParagraph two has more detail. ".repeat(60);
    const truncated = truncateToTokens(text, 50);
    expect(truncated.trimmed).toBe(true);
    expect(estimateTokens(truncated.text)).toBeLessThanOrEqual(60);
    expect(summarize("## Heading\n\nFirst point.\n\n```ts\ncode()\n```\n\nSecond point.", 200)).toContain("[code omitted]");
  });
});

describe("topology validation", () => {
  it("warns about enabled connectors without an endpoint and unsupported storage", () => {
    const topology = createDemoTopology();
    topology.nodes.push(
      node({
        id: "connector-stdio",
        kind: "connector",
        name: "Stdio",
        position: { x: 0, y: 0 },
        config: { connectorType: "mcp", transport: "stdio", enabled: true },
      }),
      node({
        id: "storage-vector",
        kind: "storage",
        name: "Vectors",
        position: { x: 0, y: 0 },
        config: { storageType: "vector-store" },
      }),
    );
    topology.edges.push(edge("e1", "agent-builder", "connector-stdio", "agent_can_use_connector"));
    const codes = validateTopology(topology).map((issue) => issue.code);
    expect(codes).toContain("connector_unconfigured");
    expect(codes).toContain("storage_adapter_unavailable");
  });
});
