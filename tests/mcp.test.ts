import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { McpManager } from "../src/server/mcp.js";
import type { ConnectorNode } from "../src/shared/contracts.js";
// @ts-expect-error — plain ESM fixture without type declarations.
import { createFixtureServer } from "./fixtures/mcp-server.mjs";
import { edge, harness, node, terminalRun, updateTopology } from "./helpers.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");

function stdioConnector(generated = 0, extra: Record<string, unknown> = {}): ConnectorNode {
  const created = node({
    id: "connector-fixture",
    kind: "connector",
    name: "Fixture",
    position: { x: 0, y: 0 },
    config: {
      connectorType: "mcp",
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath, String(generated)],
      enabled: true,
      timeoutMs: 20_000,
      ...extra,
    },
  });
  if (created.kind !== "connector") throw new Error("expected connector");
  return created;
}

async function httpFixture(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (request, response) => {
    // Stateless Streamable HTTP: one server/transport pair per request.
    const mcp = createFixtureServer(0);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    let body = "";
    for await (const chunk of request) body += chunk;
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, server };
}

describe("MCP client", () => {
  it("discovers and invokes tools over stdio", async () => {
    const manager = new McpManager();
    try {
      const connector = stdioConnector(2);
      const catalog = await manager.discover(connector);
      expect(catalog.serverName).toBe("fixture-mcp");
      expect(catalog.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["echo", "add", "delete_records", "generated_tool_1"]),
      );
      expect(catalog.tools.find((tool) => tool.name === "echo")).toMatchObject({ readOnly: true, destructive: false });
      expect(catalog.tools.find((tool) => tool.name === "delete_records")).toMatchObject({ readOnly: false, destructive: true });

      expect(await manager.callTool(connector, "add", { a: 2, b: 40 })).toEqual({ content: "42", isError: false });
      expect(await manager.callTool(connector, "fail", {})).toEqual({ content: "fixture failure", isError: true });
    } finally {
      await manager.shutdown();
    }
  }, 30_000);

  it("discovers and invokes tools over Streamable HTTP", async () => {
    const { url, server } = await httpFixture();
    const manager = new McpManager();
    try {
      const created = node({
        id: "connector-http",
        kind: "connector",
        name: "HTTP fixture",
        position: { x: 0, y: 0 },
        config: { connectorType: "mcp", transport: "streamable-http", endpoint: url, enabled: true },
      });
      if (created.kind !== "connector") throw new Error("expected connector");
      const catalog = await manager.discover(created);
      expect(catalog.tools.map((tool) => tool.name)).toContain("echo");
      expect(await manager.callTool(created, "echo", { text: "over http" })).toEqual({
        content: "echo: over http",
        isError: false,
      });
    } finally {
      await manager.shutdown();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);

  it("runs a worker against a 150-tool MCP server with deferred discovery", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.nodes.push(stdioConnector(150));
      topology.edges.push(edge("edge-builder-fixture", "agent-builder", "connector-fixture", "agent_can_use_connector"));
    });

    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: 'Build the implementation. use tool echo with {"text":"from the builder"}',
    });
    const run = await terminalRun(store, created.id, 40_000);
    expect(run.status).toBe("completed");

    // Discovery happened lazily and the catalog was cached.
    expect(store.listCatalogs().find((catalog) => catalog.connectorId === "connector-fixture")?.tools.length).toBeGreaterThan(150);

    const builderFrames = run.contextFrames.filter((frame) => frame.agentId === "agent-builder");
    expect(builderFrames.every((frame) => frame.exposure === "deferred")).toBe(true);
    expect(builderFrames.every((frame) => frame.exposedToolSchemas === 0)).toBe(true);
    expect(builderFrames[0]!.authorizedTools).toBeGreaterThan(150);
    // Every builder request shares one tools payload: loading schemas never changes the prefix.
    expect(new Set(builderFrames.map((frame) => frame.toolsHash)).size).toBe(1);
    expect(builderFrames[0]!.estimatedPromptTokens).toBeLessThan(4_000);

    expect(run.events.some((item) => item.type === "capability_loaded")).toBe(true);
    expect(run.messages.some((message) => message.role === "tool" && message.content.includes("echo: from the builder"))).toBe(true);
    expect(run.result).toContain("echo: from the builder");
  }, 60_000);

  it("keeps connector tools unavailable to agents without the edge", async () => {
    const { store, runtime } = await harness();
    await updateTopology(store, (topology) => {
      topology.nodes.push(stdioConnector(0));
    });
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: 'Build the implementation. use tool echo with {"text":"should not run"}',
    });
    const run = await terminalRun(store, created.id, 40_000);
    expect(run.status).toBe("completed");
    expect(run.messages.some((message) => message.content.includes("should not run") && message.role === "tool")).toBe(false);
  }, 60_000);
});
