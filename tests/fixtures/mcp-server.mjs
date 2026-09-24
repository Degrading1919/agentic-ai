// Stdio MCP server used by the integration tests. Built on the official SDK.
// Usage: node mcp-server.mjs [generatedToolCount]
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function createFixtureServer(generatedToolCount = 0) {
  const server = new McpServer({ name: "fixture-mcp", version: "1.2.3" });
  server.registerTool(
    "echo",
    {
      description: "Echo the provided text back to the caller.",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "add",
    {
      description: "Add two numbers and return the sum.",
      inputSchema: { a: z.number(), b: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerTool(
    "delete_records",
    {
      description: "Destructive fixture tool that must not be exposed to read-only work.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => ({ content: [{ type: "text", text: "deleted" }] }),
  );
  server.registerTool(
    "fail",
    { description: "Always returns a tool error.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "fixture failure" }], isError: true }),
  );
  for (const suffix of ["a", "b", "c"]) {
    server.registerTool(
      `big_payload_${suffix}`,
      {
        description: `Return a large report (${suffix}) used to test context fitting.`,
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: `REPORT-${suffix.toUpperCase()} ` + "detailed measurement row ".repeat(900) }] }),
    );
  }
  server.registerTool(
    "huge_message",
    { description: "Return a single message larger than the client's message limit.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }] }),
  );
  for (let index = 0; index < generatedToolCount; index += 1) {
    server.registerTool(
      `generated_tool_${index}`,
      {
        description: `Generated fixture tool number ${index} used to test large catalogs. It accepts an optional value and returns a marker.`,
        inputSchema: { value: z.string().optional(), mode: z.enum(["fast", "slow"]).optional() },
      },
      async () => ({ content: [{ type: "text", text: `generated ${index}` }] }),
    );
  }
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  const count = Number(process.argv[2] ?? 0);
  await createFixtureServer(count).connect(new StdioServerTransport());
}
