import type { ToolDescriptor } from "../shared/capabilities.js";
import type { ConnectorNode, StorageNode, Topology, TopologyEdge } from "../shared/contracts.js";
import { McpManager, truncateResult } from "./mcp.js";
import { StorageService } from "./storage.js";
import { evaluateArithmetic } from "./tools.js";

export type ToolInvocation = {
  runId: string;
  workOrderId: string;
  agentId: string;
  topology: Topology;
  signal?: AbortSignal;
};

export type ToolOutcome = {
  content: string;
  isError: boolean;
  /** Present when the call persisted a file that should be tracked as an artifact. */
  written?: { storageNodeId: string; path: string; name: string };
  remembered?: { storageNodeId: string; entryId: string };
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : value === undefined ? fallback : String(value);
}

function nodeById<T extends "storage" | "connector">(
  topology: Topology,
  id: string,
  kind: T,
): (T extends "storage" ? StorageNode : ConnectorNode) | null {
  const node = topology.nodes.find((candidate) => candidate.id === id && candidate.kind === kind);
  return (node as T extends "storage" ? StorageNode : ConnectorNode) ?? null;
}

/** Resolve a request URL strictly under the connector's configured base URL. */
export function resolveHttpTarget(
  endpoint: string,
  requestPath: string,
  query: Record<string, unknown> = {},
): URL {
  const base = new URL(endpoint);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(requestPath) || requestPath.startsWith("//")) {
    throw new Error("Topology boundary: HTTP paths must be relative to the connector endpoint.");
  }
  const target = new URL(requestPath.replace(/^\/+/, ""), new URL(basePath, base.origin));
  if (target.origin !== base.origin || !`${target.pathname}/`.startsWith(basePath)) {
    throw new Error("Topology boundary: the request escapes the connector endpoint.");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }
  return target;
}

export class CapabilityExecutor {
  constructor(
    readonly storage: StorageService,
    readonly mcp: McpManager,
  ) {}

  async execute(
    descriptor: ToolDescriptor,
    rawArgs: unknown,
    invocation: ToolInvocation,
  ): Promise<ToolOutcome> {
    const args = asRecord(rawArgs);
    const source = descriptor.source;
    switch (source.kind) {
      case "builtin": {
        const expression = stringArg(args, "expression");
        if (!expression) return { content: "Calculator requires an expression.", isError: true };
        return { content: String(evaluateArithmetic(expression)), isError: false };
      }
      case "storage":
        return this.executeStorage(descriptor, source, args, invocation);
      case "mcp": {
        const connector = nodeById(invocation.topology, source.nodeId, "connector");
        if (!connector) throw new Error("Connector is no longer part of the topology.");
        const outcome = await this.mcp.callTool(connector, source.toolName, asRecord(args), invocation.signal);
        return outcome;
      }
      case "http": {
        const connector = nodeById(invocation.topology, source.nodeId, "connector");
        if (!connector) throw new Error("Connector is no longer part of the topology.");
        return this.executeHttp(descriptor, connector, args, invocation.signal);
      }
    }
  }

  private async executeStorage(
    descriptor: ToolDescriptor,
    source: Extract<ToolDescriptor["source"], { kind: "storage" }>,
    args: Record<string, unknown>,
    invocation: ToolInvocation,
  ): Promise<ToolOutcome> {
    const node = nodeById(invocation.topology, source.nodeId, "storage");
    const edge = invocation.topology.edges.find(
      (candidate: TopologyEdge) => candidate.id === source.edgeId,
    );
    if (!node || !edge) throw new Error(`Storage behind '${descriptor.name}' is no longer connected.`);
    switch (source.operation) {
      case "list":
        return { content: await this.storage.list(node, edge, stringArg(args, "path", ".")), isError: false };
      case "read":
        return { content: await this.storage.read(node, edge, stringArg(args, "path")), isError: false };
      case "write": {
        const relative = stringArg(args, "path");
        const written = await this.storage.write(node, edge, relative, stringArg(args, "content"));
        return {
          content: `Wrote ${written.bytes} bytes to ${relative}.`,
          isError: false,
          written: { storageNodeId: node.id, path: written.path, name: relative },
        };
      }
      case "search": {
        const limit = Math.max(1, Math.min(8, Number(args.limit ?? 4) || 4));
        const hits = await this.storage.searchMemory(node, edge, stringArg(args, "query"), limit);
        return {
          content: hits.length
            ? hits
                .map((hit) => `- (${hit.score}) ${hit.text}${hit.tags.length ? ` [${hit.tags.join(", ")}]` : ""}`)
                .join("\n")
            : "No relevant memory found.",
          isError: false,
        };
      }
      case "remember": {
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
        const entry = await this.storage.remember(node, edge, stringArg(args, "text"), tags, {
          runId: invocation.runId,
          workOrderId: invocation.workOrderId,
          agentId: invocation.agentId,
        });
        return {
          content: `Remembered note ${entry.id}.`,
          isError: false,
          remembered: { storageNodeId: node.id, entryId: entry.id },
        };
      }
    }
  }

  private async executeHttp(
    descriptor: ToolDescriptor,
    connector: ConnectorNode,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    const method = stringArg(args, "method", "GET").toUpperCase();
    const allowed = (descriptor.parameters.properties as { method?: { enum?: string[] } } | undefined)
      ?.method?.enum ?? ["GET"];
    if (!allowed.includes(method)) {
      throw new Error(`Topology boundary: HTTP ${method} is not allowed for '${connector.name}'.`);
    }
    const target = resolveHttpTarget(connector.config.endpoint, stringArg(args, "path"), asRecord(args.query));
    const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
    const envName = connector.config.authEnv.trim();
    if (envName) {
      const value = process.env[envName];
      if (!value) throw new Error(`Connector '${connector.name}' expects environment variable ${envName}.`);
      headers.authorization = `Bearer ${value}`;
    }
    const body = method === "GET" ? undefined : stringArg(args, "body") || undefined;
    if (body) headers["content-type"] = body.trim().startsWith("{") ? "application/json" : "text/plain";
    const timeout = AbortSignal.timeout(connector.config.timeoutMs);
    const response = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    return {
      content: truncateResult(`HTTP ${response.status}\n${text}`, connector.config.maxResultChars),
      isError: !response.ok,
    };
  }
}
