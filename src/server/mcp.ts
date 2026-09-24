import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CatalogTool, ConnectorCatalog, ConnectorNode } from "../shared/contracts.js";
import { connectorFingerprint } from "../shared/capabilities.js";

const CLIENT_INFO = { name: "agentic-harness", version: "0.2.0" };
const MAX_LIST_PAGES = 25;
const IDLE_CLOSE_MS = 5 * 60_000;

type Connection = {
  fingerprint: string;
  client: Client;
  transport: Transport;
  lastUsed: number;
  stderrTail: string[];
};

export type McpCallOutcome = { content: string; isError: boolean };

function authHeaders(connector: ConnectorNode): Record<string, string> {
  const envName = connector.config.authEnv.trim();
  if (!envName) return {};
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Connector '${connector.name}' expects environment variable ${envName}.`);
  }
  return { authorization: `Bearer ${value}` };
}

function contentToText(content: unknown[], structured: unknown): string {
  const parts = content.map((part) => {
    const item = part as { type?: string; text?: string; uri?: string; resource?: { uri?: string; text?: string } };
    switch (item.type) {
      case "text":
        return item.text ?? "";
      case "image":
        return "[image content omitted]";
      case "audio":
        return "[audio content omitted]";
      case "resource":
        return item.resource?.text ?? `[resource ${item.resource?.uri ?? "unknown"}]`;
      case "resource_link":
        return `[resource ${item.uri ?? "unknown"}]`;
      default:
        return JSON.stringify(part);
    }
  });
  const text = parts.filter(Boolean).join("\n");
  if (text) return text;
  return structured === undefined ? "(no content)" : JSON.stringify(structured);
}

export function truncateResult(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n[…truncated ${text.length - maxChars} characters by the connector result limit]`
    : text;
}

/**
 * Pooled MCP client sessions keyed by connector node. Sessions are opened on
 * first use, reused across work orders, re-created when the connector
 * configuration changes, and closed when idle.
 */
export class McpManager {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly idleTimer: NodeJS.Timeout;

  constructor() {
    this.idleTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.idleTimer.unref();
  }

  private createTransport(connector: ConnectorNode, stderrTail: string[]): Transport {
    if (connector.config.transport === "stdio") {
      if (!connector.config.command) {
        throw new Error(`Connector '${connector.name}' has no command configured.`);
      }
      const env = getDefaultEnvironment();
      const authEnv = connector.config.authEnv.trim();
      if (authEnv && process.env[authEnv]) env[authEnv] = process.env[authEnv] as string;
      const transport = new StdioClientTransport({
        command: connector.config.command,
        args: connector.config.args,
        env,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrTail.push(chunk.toString("utf8"));
        if (stderrTail.length > 20) stderrTail.shift();
      });
      return transport;
    }
    if (!connector.config.endpoint) {
      throw new Error(`Connector '${connector.name}' has no endpoint configured.`);
    }
    return new StreamableHTTPClientTransport(new URL(connector.config.endpoint), {
      requestInit: { headers: authHeaders(connector) },
    });
  }

  private async open(connector: ConnectorNode): Promise<Connection> {
    const stderrTail: string[] = [];
    const transport = this.createTransport(connector, stderrTail);
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: connector.config.timeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      const detail = stderrTail.join("").trim().split("\n").slice(-3).join(" ");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not connect to MCP connector '${connector.name}': ${message}${detail ? ` (${detail})` : ""}`,
      );
    }
    return {
      fingerprint: connectorFingerprint(connector),
      client,
      transport,
      lastUsed: Date.now(),
      stderrTail,
    };
  }

  private async connection(connector: ConnectorNode): Promise<Connection> {
    const fingerprint = connectorFingerprint(connector);
    const existing = this.connections.get(connector.id);
    if (existing) {
      const connection = await existing.catch(() => null);
      if (connection && connection.fingerprint === fingerprint) {
        connection.lastUsed = Date.now();
        return connection;
      }
      await this.close(connector.id);
    }
    const pending = this.open(connector);
    this.connections.set(connector.id, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.connections.get(connector.id) === pending) this.connections.delete(connector.id);
      throw error;
    }
  }

  async discover(connector: ConnectorNode): Promise<ConnectorCatalog> {
    if (connector.config.connectorType !== "mcp") {
      throw new Error("Only MCP connectors support tool discovery.");
    }
    const connection = await this.connection(connector);
    const tools: CatalogTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
        timeout: connector.config.timeoutMs,
      });
      for (const tool of result.tools) {
        const readOnly = tool.annotations?.readOnlyHint === true;
        tools.push({
          name: tool.name,
          title: tool.title ?? tool.annotations?.title ?? "",
          description: (tool.description ?? "").slice(0, 8_000),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          readOnly,
          destructive: !readOnly && tool.annotations?.destructiveHint !== false,
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    const server = connection.client.getServerVersion();
    return {
      connectorId: connector.id,
      fingerprint: connection.fingerprint,
      fetchedAt: new Date().toISOString(),
      serverName: server?.name ?? "",
      serverVersion: server?.version ?? "",
      tools,
      error: null,
    };
  }

  async callTool(
    connector: ConnectorNode,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallOutcome> {
    const connection = await this.connection(connector);
    const result = await connection.client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout: connector.config.timeoutMs,
    });
    connection.lastUsed = Date.now();
    const content = Array.isArray(result.content) ? result.content : [];
    return {
      content: truncateResult(
        contentToText(content, result.structuredContent),
        connector.config.maxResultChars,
      ),
      isError: result.isError === true,
    };
  }

  async close(connectorId: string): Promise<void> {
    const pending = this.connections.get(connectorId);
    this.connections.delete(connectorId);
    const connection = await pending?.catch(() => null);
    await connection?.client.close().catch(() => undefined);
  }

  private async closeIdle(): Promise<void> {
    const now = Date.now();
    for (const [connectorId, pending] of [...this.connections.entries()]) {
      const connection = await pending.catch(() => null);
      if (connection && now - connection.lastUsed > IDLE_CLOSE_MS) await this.close(connectorId);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.connections.keys()].map((connectorId) => this.close(connectorId)));
  }
}
