import type {
  AgentNode,
  CapabilityNode,
  ConnectorCatalog,
  ConnectorNode,
  StorageNode,
  ToolDefinition,
  TopologyEdge,
} from "./contracts.js";
import { estimateJsonTokens } from "./tokens.js";

/**
 * Capability resolution is split in two deliberate steps:
 *
 * 1. Authorization: which tools an agent may invoke. Derived only from the
 *    agent's edges (plus the access mode of the current work order).
 * 2. Exposure: which of those tools are placed in the model's context and how.
 *    Exposure never widens authorization; it only controls context cost.
 */

export type AccessMode = "full" | "read-only";

export type ToolSource =
  | { kind: "builtin"; nodeId: string; capabilityId: CapabilityNode["config"]["capabilityId"] }
  | {
      kind: "storage";
      nodeId: string;
      edgeId: string;
      operation: "list" | "read" | "write" | "search" | "remember";
    }
  | { kind: "mcp"; nodeId: string; toolName: string }
  | { kind: "http"; nodeId: string };

export type ToolDescriptor = {
  /** Model-facing function name, unique within one agent context. */
  name: string;
  /** Catalog group, e.g. `mcp:GitHub` or `storage:Run artifacts`. */
  group: string;
  summary: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  source: ToolSource;
};

export type AgentCapabilityInput = {
  agent: AgentNode;
  capabilities: CapabilityNode[];
  connectors: ConnectorNode[];
  storage: Array<{ node: StorageNode; edge: TopologyEdge }>;
};

const MAX_TOOL_NAME = 64;

export function slugify(value: string, maxLength = 24): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
    .replace(/_+$/g, "");
  return slug || "resource";
}

/** FNV-1a; stable across browser and Node, used for fingerprints and hashes. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
}

export function firstSentence(text: string, maxLength = 110): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentence = clean.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? clean;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1).trimEnd()}…` : sentence;
}

/** Identity of a connector configuration; a catalog is stale when it changes. */
export function connectorFingerprint(connector: ConnectorNode): string {
  const { connectorType, transport, endpoint, command, args } = connector.config;
  return stableHash(JSON.stringify([connectorType, transport, endpoint, command, args]));
}

export function catalogFor(
  connector: ConnectorNode,
  catalogs: ConnectorCatalog[],
): ConnectorCatalog | null {
  // Catalogs are keyed by connector and configuration, so a changed endpoint
  // or command never reuses tools discovered from a different server.
  const fingerprint = connectorFingerprint(connector);
  return (
    catalogs.find(
      (candidate) => candidate.connectorId === connector.id && candidate.fingerprint === fingerprint,
    ) ?? null
  );
}

export const calculatorTool = {
  name: "calculator_evaluate",
  description:
    "Evaluate a finite arithmetic expression containing numbers, parentheses, +, -, *, /, %, and ^.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      expression: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["expression"],
  },
} as const;

function uniqueName(base: string, used: Set<string>): string {
  let name = sanitizeToolName(base);
  if (used.has(name)) {
    const suffix = `_${stableHash(base).slice(0, 4)}`;
    name = `${name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

function storageDescriptors(
  entry: { node: StorageNode; edge: TopologyEdge },
  mode: AccessMode,
  used: Set<string>,
): ToolDescriptor[] {
  const { node, edge } = entry;
  const permissions = edge.permissions ?? { read: false, write: false, scope: "/" };
  const canWrite = permissions.write && mode === "full";
  const slug = slugify(node.name, 20);
  const group = `storage:${node.name}`;
  const scope = permissions.scope || "/";
  const descriptors: ToolDescriptor[] = [];
  const source = (operation: Extract<ToolSource, { kind: "storage" }>["operation"]) =>
    ({ kind: "storage", nodeId: node.id, edgeId: edge.id, operation }) as const;

  if (node.config.storageType === "vector-store") return [];

  if (node.config.storageType === "memory") {
    if (permissions.read) {
      descriptors.push({
        name: uniqueName(`memory_${slug}_search`, used),
        group,
        summary: `Search ${node.name} for relevant remembered notes.`,
        description: `Search the ${node.name} memory (scope ${scope}) and return the most relevant remembered notes with their sources.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            limit: { type: "integer", minimum: 1, maximum: 8 },
          },
          required: ["query"],
        },
        readOnly: true,
        source: source("search"),
      });
    }
    if (canWrite) {
      descriptors.push({
        name: uniqueName(`memory_${slug}_remember`, used),
        group,
        summary: `Store a durable note in ${node.name}.`,
        description: `Store a concise, durable note (decision, fact, or outcome) in the ${node.name} memory for later retrieval.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: 4_000 },
            tags: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 8 },
          },
          required: ["text"],
        },
        readOnly: false,
        source: source("remember"),
      });
    }
    return descriptors;
  }

  if (permissions.read) {
    descriptors.push(
      {
        name: uniqueName(`fs_${slug}_list`, used),
        group,
        summary: `List files in ${node.name}.`,
        description: `List files and folders in ${node.name} under scope ${scope}. Paths are relative to the scope root.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", maxLength: 500 } },
        },
        readOnly: true,
        source: source("list"),
      },
      {
        name: uniqueName(`fs_${slug}_read`, used),
        group,
        summary: `Read a text file from ${node.name}.`,
        description: `Read a UTF-8 text file from ${node.name} under scope ${scope}. Large files are truncated.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 500 } },
          required: ["path"],
        },
        readOnly: true,
        source: source("read"),
      },
    );
  }
  if (canWrite) {
    descriptors.push({
      name: uniqueName(`fs_${slug}_write`, used),
      group,
      summary: `Write a text file to ${node.name}.`,
      description: `Create or replace a UTF-8 text file in ${node.name} under scope ${scope}.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
          content: { type: "string", maxLength: 262_144 },
        },
        required: ["path", "content"],
      },
      readOnly: false,
      source: source("write"),
    });
  }
  return descriptors;
}

function connectorDescriptors(
  connector: ConnectorNode,
  catalogs: ConnectorCatalog[],
  mode: AccessMode,
  used: Set<string>,
): ToolDescriptor[] {
  if (!connector.config.enabled) return [];
  const slug = slugify(connector.name, 18);
  const group = `${connector.config.connectorType}:${connector.name}`;

  if (connector.config.connectorType === "http-api") {
    const methods = connector.config.allowedMethods.filter(
      (method) => mode === "full" || method === "GET",
    );
    if (methods.length === 0 || !connector.config.endpoint) return [];
    return [
      {
        name: uniqueName(`http_${slug}_request`, used),
        group,
        summary: `Call the ${connector.name} HTTP API (${methods.join(", ")}).`,
        description: `Send an HTTP request to ${connector.name}. The path is resolved under ${connector.config.endpoint}; other hosts are refused.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            method: { type: "string", enum: methods },
            path: { type: "string", maxLength: 1_000 },
            query: { type: "object", additionalProperties: { type: "string" } },
            body: { type: "string", maxLength: 65_536 },
          },
          required: ["method", "path"],
        },
        readOnly: methods.every((method) => method === "GET"),
        source: { kind: "http", nodeId: connector.id },
      },
    ];
  }

  const catalog = catalogFor(connector, catalogs);
  if (!catalog) return [];
  const allowlist = new Set(connector.config.toolAllowlist);
  return [...catalog.tools]
    .filter((tool) => allowlist.size === 0 || allowlist.has(tool.name))
    // Read-only work (consult, review) may use only tools the server marks read-only.
    .filter((tool) => mode === "full" || tool.readOnly)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: uniqueName(`mcp_${slug}__${tool.name}`, used),
      group,
      summary: firstSentence(tool.description || tool.title || tool.name),
      description: tool.description || tool.title || tool.name,
      parameters:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} },
      readOnly: tool.readOnly,
      source: { kind: "mcp", nodeId: connector.id, toolName: tool.name },
    }));
}

/**
 * Every tool an agent is authorized to invoke for a given access mode, in a
 * deterministic order that does not depend on edge insertion order.
 */
export function resolveToolDescriptors(
  input: AgentCapabilityInput,
  catalogs: ConnectorCatalog[],
  mode: AccessMode = "full",
): ToolDescriptor[] {
  const used = new Set<string>(metaToolNames);
  const descriptors: ToolDescriptor[] = [];

  for (const capability of [...input.capabilities].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!capability.config.enabled) continue;
    if (capability.config.capabilityId === "calculator" && !used.has(calculatorTool.name)) {
      used.add(calculatorTool.name);
      descriptors.push({
        name: calculatorTool.name,
        group: `capability:${capability.name}`,
        summary: "Evaluate bounded arithmetic safely.",
        description: calculatorTool.description,
        parameters: structuredClone(calculatorTool.parameters) as Record<string, unknown>,
        readOnly: true,
        source: { kind: "builtin", nodeId: capability.id, capabilityId: "calculator" },
      });
    }
  }

  for (const entry of [...input.storage].sort(
    (a, b) => a.node.id.localeCompare(b.node.id) || a.edge.id.localeCompare(b.edge.id),
  )) {
    descriptors.push(...storageDescriptors(entry, mode, used));
  }

  for (const connector of [...input.connectors].sort((a, b) => a.id.localeCompare(b.id))) {
    descriptors.push(...connectorDescriptors(connector, catalogs, mode, used));
  }

  return descriptors;
}

export const metaToolNames = [
  "find_tools",
  "call_tool",
  "load_skill",
  "consult_agent",
  "handoff_work",
  "read_artifact",
] as const;

export type MetaToolName = (typeof metaToolNames)[number];

export function isMetaTool(name: string): name is MetaToolName {
  return (metaToolNames as readonly string[]).includes(name);
}

export type ExposurePlan = {
  mode: "eager" | "deferred" | "none";
  /** Descriptors whose full schema is sent with every request. */
  native: ToolDescriptor[];
  /** Descriptors reachable only through find_tools / call_tool. */
  deferred: ToolDescriptor[];
  schemaTokens: number;
};

export const AUTO_EAGER_SCHEMA_TOKEN_LIMIT = 1_200;

export function toolDefinition(descriptor: ToolDescriptor): ToolDefinition {
  return {
    type: "function",
    function: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
    },
  };
}

export function planToolExposure(agent: AgentNode, descriptors: ToolDescriptor[]): ExposurePlan {
  if (descriptors.length === 0) return { mode: "none", native: [], deferred: [], schemaTokens: 0 };
  const schemaTokens = descriptors.reduce(
    (sum, descriptor) => sum + estimateJsonTokens(toolDefinition(descriptor)),
    0,
  );
  const preference = agent.config.toolExposure;
  const eager =
    preference === "eager" ||
    (preference === "auto" &&
      descriptors.length <= agent.config.eagerToolLimit &&
      schemaTokens <= AUTO_EAGER_SCHEMA_TOKEN_LIMIT);
  return eager
    ? { mode: "eager", native: descriptors, deferred: [], schemaTokens }
    : { mode: "deferred", native: [], deferred: descriptors, schemaTokens };
}

export type MetaToolOptions = {
  deferred: boolean;
  onDemandSkills: string[];
  consultAgents: Array<{ id: string; name: string }>;
  handoffAgents: Array<{ id: string; name: string }>;
};

/**
 * Harness tools. Their schemas depend only on topology-derived inputs, so
 * they stay byte-identical across requests for the same agent and mode.
 */
export function metaToolDefinitions(options: MetaToolOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (options.deferred) {
    tools.push(
      {
        type: "function",
        function: {
          name: "find_tools",
          description:
            "Search your authorized tool catalog. Returns full schemas for up to 5 matching tools and loads them for call_tool. Use exact names from the catalog when known.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string", maxLength: 300 },
              names: { type: "array", items: { type: "string" }, maxItems: 5 },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "call_tool",
          description:
            "Invoke a tool previously returned by find_tools. Arguments must match that tool's schema.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              arguments: { type: "object" },
            },
            required: ["name", "arguments"],
          },
        },
      },
    );
  }
  if (options.onDemandSkills.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "load_skill",
        description: "Load the full instructions for one on-demand skill from your skill catalog.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string", enum: [...options.onDemandSkills].sort() } },
          required: ["name"],
        },
      },
    });
  }
  if (options.consultAgents.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "consult_agent",
        description:
          "Ask a connected consultant for advice. You keep ownership of the task; the consultant answers with read-only access.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentId: { type: "string", enum: options.consultAgents.map((agent) => agent.id).sort() },
            question: { type: "string", minLength: 1, maxLength: 4_000 },
          },
          required: ["agentId", "question"],
        },
      },
    });
  }
  if (options.handoffAgents.length > 0) {
    tools.push({
      type: "function",
      function: {
        name: "handoff_work",
        description:
          "Transfer responsibility for this unfinished task to a connected agent. Your turn ends; the receiver owns the outcome.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentId: { type: "string", enum: options.handoffAgents.map((agent) => agent.id).sort() },
            reason: { type: "string", maxLength: 2_000 },
            progress: { type: "string", maxLength: 8_000 },
            remainingWork: { type: "string", maxLength: 4_000 },
          },
          required: ["agentId", "reason", "remainingWork"],
        },
      },
    });
  }
  tools.push({
    type: "function",
    function: {
      name: "read_artifact",
      description:
        "Read the full content of a work result or artifact referenced by id in your work order when its summary is not enough.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["id"],
      },
    },
  });
  return tools;
}

/** Rank catalog entries against a free-text query (deterministic lexical score). */
export function searchDescriptors(
  descriptors: ToolDescriptor[],
  query: string,
  names: string[] = [],
  limit = 5,
): ToolDescriptor[] {
  const exact = names
    .map((name) => descriptors.find((descriptor) => descriptor.name === name))
    .filter((descriptor): descriptor is ToolDescriptor => Boolean(descriptor));
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1);
  const scored = descriptors
    .filter((descriptor) => !exact.includes(descriptor))
    .map((descriptor) => {
      const haystack = `${descriptor.name} ${descriptor.group} ${descriptor.description}`.toLowerCase();
      const nameHaystack = descriptor.name.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (nameHaystack.includes(term)) score += 3;
        else if (haystack.includes(term)) score += 1;
      }
      if (query && nameHaystack === query.toLowerCase()) score += 10;
      return { descriptor, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.descriptor.name.localeCompare(b.descriptor.name))
    .map((entry) => entry.descriptor);
  return [...exact, ...scored].slice(0, limit);
}
