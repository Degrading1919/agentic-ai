import { createHash, createHmac, randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CatalogTool, ConnectorCatalog, ConnectorNode } from "../shared/contracts.js";
import { connectorFingerprint } from "../shared/capabilities.js";

const CLIENT_INFO = { name: "agentic-harness", version: "0.3.0" };
const MAX_LIST_PAGES = 25;
const IDLE_CLOSE_MS = 5 * 60_000;

/** Hard limits applied to untrusted MCP servers before data is parsed, stored, or exposed. */
export const MCP_LIMITS = {
  /** One JSON-RPC message (stdio line) or one HTTP response body. */
  maxMessageBytes: 4 * 1024 * 1024,
  maxTools: 512,
  maxToolNameLength: 128,
  maxDescriptionChars: 8_000,
  maxSchemaBytes: 32 * 1024,
  maxSchemaDepth: 16,
  maxSchemaNodes: 2_000,
  /** Serialized size of all accepted tools in one catalog. */
  maxCatalogBytes: 2 * 1024 * 1024,
  maxResultParts: 256,
} as const;

const toolNamePattern = /^[A-Za-z0-9_.-]+$/;

export class McpLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpLimitError";
  }
}

export class McpDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpDriftError";
  }
}

type Connection = {
  key: string;
  client: Client;
  transport: Transport;
  lastUsed: number;
};

type Verification = {
  key: string;
  revision: string;
  verifiedAt: number;
  tools: Map<string, string>;
};

export type McpCallOutcome = { content: string; isError: boolean };

/** Canonical JSON: object keys sorted, so equal definitions hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Definition hash pinned by local trust policies. */
export function toolDefinitionHash(tool: Omit<CatalogTool, "schemaHash">): string {
  return sha256(
    canonicalJson([tool.name, tool.title, tool.description, tool.inputSchema, tool.readOnly, tool.destructive]),
  ).slice(0, 32);
}

function schemaShape(value: unknown, depth = 0, counter = { nodes: 0 }): string | null {
  counter.nodes += 1;
  if (counter.nodes > MCP_LIMITS.maxSchemaNodes) return `more than ${MCP_LIMITS.maxSchemaNodes} schema nodes`;
  if (depth > MCP_LIMITS.maxSchemaDepth) return `nested deeper than ${MCP_LIMITS.maxSchemaDepth}`;
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = schemaShape(item, depth + 1, counter);
      if (problem) return problem;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const problem = schemaShape(item, depth + 1, counter);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Validate and bound a raw tool list. Oversized or malformed tools are
 * rejected individually (recorded, never authorized) instead of poisoning
 * the whole catalog.
 */
export function boundCatalogTools(raw: unknown[]): { tools: CatalogTool[]; rejected: Array<{ name: string; reason: string }> } {
  const tools: CatalogTool[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of raw) {
    const tool = (entry ?? {}) as {
      name?: unknown;
      title?: unknown;
      description?: unknown;
      inputSchema?: unknown;
      annotations?: { title?: unknown; readOnlyHint?: unknown; destructiveHint?: unknown };
    };
    const name = typeof tool.name === "string" ? tool.name : "";
    const label = name.slice(0, 200) || "(unnamed)";
    const reject = (reason: string) => rejected.push({ name: label, reason });
    if (tools.length >= MCP_LIMITS.maxTools) {
      reject(`catalog exceeds ${MCP_LIMITS.maxTools} tools`);
      continue;
    }
    if (!name || name.length > MCP_LIMITS.maxToolNameLength || !toolNamePattern.test(name)) {
      reject("invalid tool name");
      continue;
    }
    if (seen.has(name)) {
      reject("duplicate tool name");
      continue;
    }
    const inputSchema =
      tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? (tool.inputSchema as Record<string, unknown>)
        : null;
    if (!inputSchema) {
      reject("missing or invalid input schema");
      continue;
    }
    const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), "utf8");
    if (schemaBytes > MCP_LIMITS.maxSchemaBytes) {
      reject(`input schema is ${schemaBytes} bytes (limit ${MCP_LIMITS.maxSchemaBytes})`);
      continue;
    }
    const shapeProblem = schemaShape(inputSchema);
    if (shapeProblem) {
      reject(`input schema ${shapeProblem}`);
      continue;
    }
    const rawDescription = typeof tool.description === "string" ? tool.description : "";
    const description =
      rawDescription.length > MCP_LIMITS.maxDescriptionChars
        ? `${rawDescription.slice(0, MCP_LIMITS.maxDescriptionChars - 20)} […truncated]`
        : rawDescription;
    const title =
      typeof tool.title === "string"
        ? tool.title.slice(0, 300)
        : typeof tool.annotations?.title === "string"
          ? tool.annotations.title.slice(0, 300)
          : "";
    const readOnly = tool.annotations?.readOnlyHint === true;
    const base = {
      name,
      title,
      description,
      inputSchema,
      readOnly,
      destructive: !readOnly && tool.annotations?.destructiveHint !== false,
    };
    const bytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    if (totalBytes + bytes > MCP_LIMITS.maxCatalogBytes) {
      reject(`catalog exceeds ${MCP_LIMITS.maxCatalogBytes} bytes`);
      continue;
    }
    totalBytes += bytes;
    seen.add(name);
    tools.push({ ...base, schemaHash: toolDefinitionHash(base) });
  }
  return { tools, rejected };
}

export function catalogRevision(tools: CatalogTool[]): string {
  return sha256(canonicalJson(tools.map((tool) => [tool.name, tool.schemaHash]).sort())).slice(0, 32);
}

function contentToText(content: unknown[], structured: unknown): string {
  const parts = content.slice(0, MCP_LIMITS.maxResultParts).map((part) => {
    const item = part as { type?: string; text?: string; uri?: string; resource?: { uri?: string; text?: string } };
    switch (item.type) {
      case "text":
        return typeof item.text === "string" ? item.text : "";
      case "image":
        return "[image content omitted]";
      case "audio":
        return "[audio content omitted]";
      case "resource":
        return typeof item.resource?.text === "string" ? item.resource.text : `[resource ${String(item.resource?.uri ?? "unknown")}]`;
      case "resource_link":
        return `[resource ${String(item.uri ?? "unknown")}]`;
      default:
        return "[unsupported content omitted]";
    }
  });
  if (content.length > MCP_LIMITS.maxResultParts) {
    parts.push(`[…${content.length - MCP_LIMITS.maxResultParts} more content parts omitted]`);
  }
  const text = parts.filter(Boolean).join("\n");
  if (text) return text;
  return structured === undefined ? "(no content)" : JSON.stringify(structured);
}

export function truncateResult(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n[…truncated ${text.length - maxChars} characters by the connector result limit]`
    : text;
}

/** fetch wrapper that aborts any response body larger than the message limit before it is parsed. */
export function boundedFetch(limitBytes: number = MCP_LIMITS.maxMessageBytes) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, init);
    if (!response.body) return response;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limitBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new McpLimitError(`MCP response of ${declared} bytes exceeds the ${limitBytes}-byte limit.`);
    }
    let seen = 0;
    const limited = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limitBytes) {
            controller.error(new McpLimitError(`MCP response exceeded the ${limitBytes}-byte limit.`));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio, with a hard cap
 * on each message. A line that grows past the cap kills the process before
 * the oversized payload is ever parsed.
 */
export class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private process: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;
  readonly stderrTail: string[] = [];

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly limitBytes: number = MCP_LIMITS.maxMessageBytes,
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.process = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => resolve());
      child.once("close", () => this.finish());
      child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail.push(chunk.toString("utf8").slice(0, 2_000));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      });
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (this.buffer.length > this.limitBytes) {
      this.buffer = Buffer.alloc(0);
      this.onerror?.(new McpLimitError(`MCP message exceeded the ${this.limitBytes}-byte limit; the server was stopped.`));
      void this.close();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.process?.stdin;
    if (!stdin || this.closed) throw new Error("MCP process is not running.");
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (child && child.exitCode === null) {
      child.stdin?.end();
      child.kill();
    }
    this.finish();
  }
}

/**
 * Pooled MCP client sessions keyed by connector configuration *and* the
 * current credential identity. Rotating a credential closes the old session.
 * Catalogs discovered here are verified for that identity and expire after
 * the connector's TTL; tools are re-checked against the verified definition
 * before each call so server-side drift is refused rather than trusted.
 */
export class McpManager {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly verifications = new Map<string, Verification>();
  private readonly idleTimer: NodeJS.Timeout;
  /** Per-process key: credential identities are comparable in memory but never persisted. */
  private readonly identityKey = randomBytes(32);
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.idleTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.idleTimer.unref();
  }

  /** Configuration fingerprint plus an in-memory digest of the credential value. */
  sessionKey(connector: ConnectorNode): string {
    const envName = connector.config.authEnv.trim();
    const value = envName ? (process.env[envName] ?? "") : "";
    const identity = createHmac("sha256", this.identityKey).update(`${envName}\u0000${value}`).digest("hex").slice(0, 24);
    return `${connectorFingerprint(connector)}:${identity}`;
  }

  private authHeaders(connector: ConnectorNode): Record<string, string> {
    const envName = connector.config.authEnv.trim();
    if (!envName) return {};
    const value = process.env[envName];
    if (!value) throw new Error(`Connector '${connector.name}' expects environment variable ${envName}.`);
    return { authorization: `Bearer ${value}` };
  }

  private createTransport(connector: ConnectorNode): Transport {
    if (connector.config.transport === "stdio") {
      if (!connector.config.command) {
        throw new Error(`Connector '${connector.name}' has no command configured.`);
      }
      const env = getDefaultEnvironment();
      const authEnv = connector.config.authEnv.trim();
      if (authEnv && process.env[authEnv]) env[authEnv] = process.env[authEnv] as string;
      return new BoundedStdioTransport(connector.config.command, connector.config.args, env);
    }
    if (!connector.config.endpoint) {
      throw new Error(`Connector '${connector.name}' has no endpoint configured.`);
    }
    return new StreamableHTTPClientTransport(new URL(connector.config.endpoint), {
      requestInit: { headers: this.authHeaders(connector) },
      fetch: boundedFetch(),
    });
  }

  private async open(connector: ConnectorNode, key: string): Promise<Connection> {
    const transport = this.createTransport(connector);
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: connector.config.timeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      const tail = transport instanceof BoundedStdioTransport ? transport.stderrTail : [];
      const detail = tail.join("").trim().split("\n").slice(-3).join(" ");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not connect to MCP connector '${connector.name}': ${message}${detail ? ` (${detail})` : ""}`,
      );
    }
    const connection: Connection = { key, client, transport, lastUsed: Date.now() };
    // A session that closes (server exit, limit violation) is evicted from the pool
    // so the next use reconnects instead of reusing a dead client.
    client.onclose = () => {
      void this.connections.get(connector.id)?.then((current) => {
        if (current === connection) {
          this.connections.delete(connector.id);
          this.verifications.delete(connector.id);
        }
      }, () => undefined);
    };
    return connection;
  }

  private async connection(connector: ConnectorNode): Promise<Connection> {
    const key = this.sessionKey(connector);
    const existing = this.connections.get(connector.id);
    if (existing) {
      const connection = await existing.catch(() => null);
      if (connection && connection.key === key) {
        connection.lastUsed = Date.now();
        return connection;
      }
      // Configuration or credential identity changed: never reuse the old session.
      await this.close(connector.id);
    }
    const pending = this.open(connector, key);
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
    const key = this.sessionKey(connector);
    const connection = await this.connection(connector);
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
        timeout: connector.config.timeoutMs,
      });
      raw.push(...result.tools.slice(0, MCP_LIMITS.maxTools + 1 - raw.length));
      cursor = result.nextCursor;
      if (!cursor || raw.length > MCP_LIMITS.maxTools) break;
    }
    const { tools, rejected } = boundCatalogTools(raw);
    const revision = catalogRevision(tools);
    this.verifications.set(connector.id, {
      key,
      revision,
      verifiedAt: this.now(),
      tools: new Map(tools.map((tool) => [tool.name, tool.schemaHash])),
    });
    const server = connection.client.getServerVersion();
    return {
      connectorId: connector.id,
      fingerprint: connectorFingerprint(connector),
      fetchedAt: new Date().toISOString(),
      serverName: String(server?.name ?? "").slice(0, 200),
      serverVersion: String(server?.version ?? "").slice(0, 100),
      tools,
      error: null,
      revision,
      rejectedTools: rejected.slice(0, 200),
    };
  }

  /**
   * Whether this process verified the connector's catalog for the current
   * configuration and credential identity within its TTL.
   */
  isVerified(connector: ConnectorNode): boolean {
    const verification = this.verifications.get(connector.id);
    return Boolean(
      verification &&
        verification.key === this.sessionKey(connector) &&
        this.now() - verification.verifiedAt < connector.config.catalogTtlMs,
    );
  }

  async callTool(
    connector: ConnectorNode,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; operationId?: string; expectedSchemaHash?: string } = {},
  ): Promise<McpCallOutcome> {
    const verification = this.verifications.get(connector.id);
    if (!verification || verification.key !== this.sessionKey(connector) || !this.isVerified(connector)) {
      throw new McpDriftError(`The ${connector.name} catalog is not verified for the current connection; rediscover before calling tools.`);
    }
    const current = verification.tools.get(toolName);
    if (!current) throw new McpDriftError(`Tool '${toolName}' is no longer offered by ${connector.name}.`);
    if (options.expectedSchemaHash && current !== options.expectedSchemaHash) {
      throw new McpDriftError(
        `Tool '${toolName}' changed on ${connector.name} since it was exposed to this worker; it will not be called until the catalog is reviewed.`,
      );
    }
    const connection = await this.connection(connector);
    const result = await connection.client.callTool(
      {
        name: toolName,
        arguments: args,
        ...(options.operationId ? { _meta: { "io.agentic-harness/operationId": options.operationId } } : {}),
      },
      undefined,
      { signal: options.signal, timeout: connector.config.timeoutMs },
    );
    connection.lastUsed = Date.now();
    const content = Array.isArray(result.content) ? result.content : [];
    return {
      content: truncateResult(contentToText(content, result.structuredContent), connector.config.maxResultChars),
      isError: result.isError === true,
    };
  }

  async close(connectorId: string): Promise<void> {
    const pending = this.connections.get(connectorId);
    this.connections.delete(connectorId);
    this.verifications.delete(connectorId);
    const connection = await pending?.catch(() => null);
    await connection?.client.close().catch(() => undefined);
  }

  private async closeIdle(): Promise<void> {
    const now = Date.now();
    for (const [connectorId, pending] of [...this.connections.entries()]) {
      const connection = await pending.catch(() => null);
      if (connection && now - connection.lastUsed > IDLE_CLOSE_MS) {
        this.connections.delete(connectorId);
        await connection.client.close().catch(() => undefined);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.connections.keys()].map((connectorId) => this.close(connectorId)));
  }
}
