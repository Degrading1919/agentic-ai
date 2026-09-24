import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError, z } from "zod";
import { connectorFingerprint } from "../shared/capabilities.js";
import {
  createRunRequestSchema,
  topologySchema,
  type ConnectorNode,
  type ModelNode,
} from "../shared/contracts.js";
import { createDemoTopology } from "../shared/demo-topology.js";
import { estimateAgentFootprint } from "../shared/prompt.js";
import { validateTopology } from "../shared/topology.js";
import { inspectGguf } from "./gguf.js";
import { generateLlamaSwapConfig } from "./llama-swap.js";
import { testModelConnection } from "./providers.js";
import { RuntimeEngine } from "./runtime.js";
import { LocalStore } from "./store.js";

const host = process.env.AGENTIC_HARNESS_HOST ?? "127.0.0.1";
const port = Number(process.env.AGENTIC_HARNESS_PORT ?? 8787);
const store = new LocalStore();
await store.init();
const runtime = new RuntimeEngine(store);
await runtime.init();

const app = Fastify({
  logger: {
    level: process.env.AGENTIC_HARNESS_LOG_LEVEL ?? "info",
  },
  bodyLimit: 5 * 1024 * 1024,
});

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    void reply.status(400).send({
      error: "Invalid request",
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    return;
  }
  const normalized = error as Error & { statusCode?: number };
  const statusCode =
    normalized.statusCode && normalized.statusCode >= 400 ? normalized.statusCode : 400;
  void reply.status(statusCode).send({ error: normalized.message ?? String(error) });
});

app.get("/api/health", async () => ({
  ok: true,
  service: "agentic-harness",
  dataDir: store.dataDir,
  time: new Date().toISOString(),
}));

app.get("/api/topologies", async () => ({
  activeTopologyId: store.snapshot().activeTopologyId,
  topologies: store.listTopologies(),
}));

app.get<{ Params: { topologyId: string } }>(
  "/api/topologies/:topologyId",
  async (request, reply) => {
    const topology = store.getTopology(request.params.topologyId);
    if (!topology) return reply.status(404).send({ error: "Topology not found" });
    return { topology, issues: validateTopology(topology) };
  },
);

app.put<{ Params: { topologyId: string }; Body: unknown }>(
  "/api/topologies/:topologyId",
  async (request) => {
    const topology = topologySchema.parse(request.body);
    if (topology.id !== request.params.topologyId) {
      throw new Error("Topology ID in the URL and request body must match.");
    }
    topology.updatedAt = new Date().toISOString();
    const saved = await store.saveTopology(topology);
    // Model edits re-account residency immediately (or once in-flight requests drain).
    await runtime.onTopologySaved(saved);
    return { topology: saved, issues: validateTopology(saved) };
  },
);

// Adds a fresh copy of the example topology without touching existing ones.
app.post("/api/topologies/example", async (_request, reply) => {
  const topology = createDemoTopology();
  const existing = new Set(store.listTopologies().map((item) => item.id));
  let suffix = 1;
  while (existing.has(`${topology.id}-${suffix}`)) suffix += 1;
  topology.id = existing.has(topology.id) ? `${topology.id}-${suffix}` : topology.id;
  topology.name = existing.size ? `${topology.name} (example)` : topology.name;
  const saved = await store.saveTopology(topology);
  return reply.status(201).send({ topology: saved, issues: validateTopology(saved) });
});

// `view=summary` drops heavy per-run detail; clients fetch one run in full when it changes.
app.get<{ Querystring: { limit?: string; view?: string } }>("/api/runs", async (request) => {
  const limit = Math.max(1, Math.min(200, Number(request.query.limit ?? 50) || 50));
  return { runs: request.query.view === "summary" ? store.listRunSummaries(limit) : store.listRuns(limit) };
});

app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
  const run = store.getRun(request.params.runId);
  if (!run) return reply.status(404).send({ error: "Run not found" });
  return { run };
});

app.post<{ Body: unknown }>("/api/runs", async (request, reply) => {
  const payload = createRunRequestSchema.parse(request.body);
  const run = await runtime.createRun(payload);
  return reply.status(202).send({ run });
});

app.post<{ Params: { runId: string } }>("/api/runs/:runId/pause", async (request) => ({
  run: await runtime.pauseRun(request.params.runId),
}));

app.post<{ Params: { runId: string; operationId: string }; Body: unknown }>(
  "/api/runs/:runId/tool-calls/:operationId/reconcile",
  async (request) => {
    const body = z
      .object({ applied: z.boolean(), note: z.string().max(4_000).default("") })
      .parse(request.body);
    return { run: await runtime.reconcileToolCall(request.params.runId, request.params.operationId, body) };
  },
);

app.post<{ Params: { runId: string } }>("/api/runs/:runId/resume", async (request) => ({
  run: await runtime.resumeRun(request.params.runId),
}));

app.get("/api/runtime", async () => ({ runtime: runtime.snapshot() }));

app.get("/api/catalogs", async () => ({ catalogs: store.listCatalogs() }));

app.post<{ Params: { topologyId: string; connectorId: string } }>(
  "/api/topologies/:topologyId/connectors/:connectorId/discover",
  async (request, reply) => {
    const topology = store.getTopology(request.params.topologyId);
    const connector = topology?.nodes.find(
      (node): node is ConnectorNode => node.id === request.params.connectorId && node.kind === "connector",
    );
    if (!topology || !connector) return reply.status(404).send({ error: "Connector not found" });
    try {
      return { catalog: await runtime.discoverConnector(topology.id, connector.id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const catalog = await store.saveCatalog({
        connectorId: connector.id,
        fingerprint: connectorFingerprint(connector),
        fetchedAt: new Date().toISOString(),
        serverName: "",
        serverVersion: "",
        tools: [],
        error: message,
        revision: "",
        rejectedTools: [],
      });
      return reply.status(502).send({ error: message, catalog });
    }
  },
);

app.get<{ Params: { topologyId: string } }>(
  "/api/topologies/:topologyId/footprint",
  async (request, reply) => {
    const topology = store.getTopology(request.params.topologyId);
    if (!topology) return reply.status(404).send({ error: "Topology not found" });
    const catalogs = store.listCatalogs();
    return {
      footprints: topology.nodes
        .filter((node) => node.kind === "agent")
        .map((node) => estimateAgentFootprint(topology, node.id, catalogs)),
    };
  },
);

app.get<{ Params: { topologyId: string } }>(
  "/api/topologies/:topologyId/llama-swap-config",
  async (request, reply) => {
    const topology = store.getTopology(request.params.topologyId);
    if (!topology) return reply.status(404).send({ error: "Topology not found" });
    return generateLlamaSwapConfig(topology);
  },
);

app.post<{ Body: unknown }>("/api/models/inspect", async (request) => {
  const body = z
    .object({
      path: z.string().trim().min(1).max(2_000),
      contextWindow: z.number().int().min(512).optional(),
      gpuLayers: z.number().int().min(-1).optional(),
      parallelSlots: z.number().int().min(1).max(64).optional(),
    })
    .parse(request.body);
  return {
    inspection: await inspectGguf(body.path, body.contextWindow, {
      gpuLayers: body.gpuLayers,
      parallelSlots: body.parallelSlots,
    }),
  };
});

app.post<{ Params: { topologyId: string; modelId: string } }>(
  "/api/topologies/:topologyId/models/:modelId/test",
  async (request, reply) => {
    const topology = store.getTopology(request.params.topologyId);
    if (!topology) return reply.status(404).send({ error: "Topology not found" });
    const model = topology.nodes.find(
      (node): node is ModelNode => node.id === request.params.modelId && node.kind === "model",
    );
    if (!model) return reply.status(404).send({ error: "Model not found" });
    return testModelConnection(model);
  },
);

const clientRoot = path.resolve(process.cwd(), "dist", "client");
if (existsSync(clientRoot)) {
  await app.register(fastifyStatic, {
    root: clientRoot,
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      void reply.status(404).send({ error: "API route not found" });
      return;
    }
    // A missing file (e.g. a stale asset hash) must 404, not fall back to the SPA shell.
    if (/\.[a-z0-9]+(?:\?.*)?$/i.test(request.url)) {
      void reply.status(404).send("Not found");
      return;
    }
    void reply.sendFile("index.html");
  });
}

const close = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await runtime.shutdown();
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host, port });
