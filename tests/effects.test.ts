import { copyFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeEngine } from "../src/server/runtime.js";
import { LocalStore } from "../src/server/store.js";
import type { Run } from "../src/shared/contracts.js";
import { edge, harness, node, tempDir, terminalRun, updateTopology } from "./helpers.js";

/**
 * A real HTTP service that records every request. `hold` keeps effectful
 * requests open (after recording them) until released, so a test can stop
 * the harness while an effect is in flight.
 */
type Recorded = { method: string; path: string; idempotencyKey: string | undefined };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function service(options: { hold?: boolean; holdReads?: boolean } = {}) {
  const calls: Recorded[] = [];
  const held: Array<() => void> = [];
  let holding = Boolean(options.hold || options.holdReads);
  const server = createServer((request, response) => {
    calls.push({
      method: request.method ?? "",
      path: request.url ?? "",
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
    });
    const reply = () => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, received: calls.length }));
    };
    const holdThis = holding && (request.method === "GET" ? options.holdReads : options.hold);
    if (holdThis) held.push(reply);
    else reply();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    calls,
    count: (method: string) => calls.filter((call) => call.method === method).length,
    /** Answer held requests and stop holding new ones. */
    releaseAll: () => {
      holding = false;
      held.splice(0).forEach((reply) => reply());
    },
  };
}

async function until<T>(read: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not met before the deadline.");
}

async function connectHttp(store: LocalStore, name: string, url: string, honorsIdempotencyKey: boolean) {
  await updateTopology(store, (topology) => {
    topology.nodes.push(
      node({
        id: `connector-${name.toLowerCase()}`,
        kind: "connector",
        name,
        position: { x: 0, y: 0 },
        config: {
          connectorType: "http-api",
          endpoint: url,
          enabled: true,
          allowedMethods: ["GET", "POST", "PUT"],
          honorsIdempotencyKey,
          timeoutMs: 20_000,
        },
      }),
    );
    topology.edges.push(edge(`edge-${name}`, "agent-orchestrator", `connector-${name.toLowerCase()}`, "agent_can_use_connector"));
  });
}

const POST_ORDER = '[direct] use tool http_orders_request with {"method":"POST","path":"orders","body":"buy 1 widget"}';

/** Copy the durable state as it is *now*, i.e. what a crash at this instant would leave behind. */
async function crashImage(directory: string): Promise<string> {
  const image = await tempDir("agentic-harness-crash-");
  await mkdir(image, { recursive: true });
  await copyFile(path.join(directory, "state.json"), path.join(image, "state.json"));
  return image;
}

async function restart(directory: string): Promise<{ store: LocalStore; runtime: RuntimeEngine }> {
  const store = new LocalStore(directory);
  await store.init();
  const runtime = new RuntimeEngine(store);
  await runtime.init();
  return { store, runtime };
}

function orderCall(run: Run | null) {
  return run?.toolCalls.find((call) => call.targetName === "http_orders_request");
}

describe("external effects across restarts (audit A3)", () => {
  it("does not repeat a non-idempotent effect after a crash; it asks for reconciliation", async () => {
    const orders = await service({ hold: true });
    const { store, runtime, directory } = await harness();
    await connectHttp(store, "Orders", orders.url, false);
    const created = await runtime.createRun({ topologyId: "topology-local-studio", entryAgentId: "agent-orchestrator", objective: POST_ORDER });

    // The POST reached the service: the effect happened, but the order has not completed.
    await until(() => orders.count("POST") === 1);
    await until(() => orderCall(store.getRun(created.id))?.status === "started");
    const image = await crashImage(directory);
    orders.releaseAll();

    const recovered = await restart(image);
    try {
      const run = recovered.store.getRun(created.id)!;
      expect(run.status).toBe("paused");
      expect(orderCall(run)).toMatchObject({ status: "indeterminate", effect: "effectful" });
      expect(run.workOrders[0]?.status).toBe("awaiting_reconciliation");
      await expect(recovered.runtime.resumeRun(created.id)).rejects.toThrow(/Reconcile 1 tool call/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(orders.count("POST")).toBe(1);

      // A human confirms the order exists; the worker continues from that outcome.
      await recovered.runtime.reconcileToolCall(created.id, orderCall(run)!.id, { applied: true, note: "Order #1 exists." });
      await recovered.runtime.resumeRun(created.id);
      const finished = await terminalRun(recovered.store, created.id);
      expect(finished.status).toBe("completed");
      expect(orderCall(finished)?.status).toBe("reconciled_applied");
      expect(finished.result).toContain("Order #1 exists.");
      expect(orders.count("POST")).toBe(1);
    } finally {
      await recovered.runtime.shutdown();
    }
  }, 30_000);

  it("reports a reconciled 'not applied' effect to the worker instead of silently retrying", async () => {
    const orders = await service({ hold: true });
    const { store, runtime, directory } = await harness();
    await connectHttp(store, "Orders", orders.url, false);
    const created = await runtime.createRun({ topologyId: "topology-local-studio", entryAgentId: "agent-orchestrator", objective: POST_ORDER });
    await until(() => orderCall(store.getRun(created.id))?.status === "started" && orders.count("POST") === 1);
    const image = await crashImage(directory);
    orders.releaseAll();

    const recovered = await restart(image);
    try {
      const record = orderCall(recovered.store.getRun(created.id))!;
      await recovered.runtime.reconcileToolCall(created.id, record.id, { applied: false, note: "No order was created." });
      await recovered.runtime.resumeRun(created.id);
      const finished = await terminalRun(recovered.store, created.id);
      expect(finished.status).toBe("completed");
      expect(orderCall(finished)?.status).toBe("reconciled_not_applied");
      expect(finished.result).toContain("did not take effect and was not retried automatically");
      expect(orders.count("POST")).toBe(1);
    } finally {
      await recovered.runtime.shutdown();
    }
  }, 30_000);

  it("retries an idempotent effect with the same operation ID and idempotency key", async () => {
    const orders = await service({ hold: true });
    const { store, runtime, directory } = await harness();
    await connectHttp(store, "Orders", orders.url, true);
    const created = await runtime.createRun({ topologyId: "topology-local-studio", entryAgentId: "agent-orchestrator", objective: POST_ORDER });
    await until(() => orderCall(store.getRun(created.id))?.status === "started" && orders.count("POST") === 1);
    const image = await crashImage(directory);
    orders.releaseAll();

    const recovered = await restart(image);
    try {
      const finished = await terminalRun(recovered.store, created.id);
      expect(finished.status).toBe("completed");
      const record = orderCall(finished)!;
      expect(record).toMatchObject({ status: "succeeded", effect: "idempotent", attempts: 2 });
      const posts = orders.calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts[0]?.idempotencyKey).toBe(record.id);
      expect(posts[1]?.idempotencyKey).toBe(record.id);
    } finally {
      await recovered.runtime.shutdown();
    }
  }, 30_000);

  it("does not repeat tool calls whose results were checkpointed before the crash", async () => {
    const orders = await service({ hold: true });
    const { store, runtime, directory } = await harness();
    await connectHttp(store, "Orders", orders.url, true);
    await connectHttp(store, "Catalog", orders.url, false);
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: `[direct] use tool http_catalog_request with {"method":"GET","path":"items"} use tool http_orders_request with {"method":"POST","path":"orders","body":"buy"}`,
    });
    await until(() => orderCall(store.getRun(created.id))?.status === "started" && orders.count("POST") === 1);
    expect(orders.count("GET")).toBe(1);
    const image = await crashImage(directory);
    orders.releaseAll();

    const recovered = await restart(image);
    try {
      const finished = await terminalRun(recovered.store, created.id);
      expect(finished.status).toBe("completed");
      // The GET's result was in the checkpoint: it is not re-issued. The idempotent POST is retried once.
      expect(orders.count("GET")).toBe(1);
      expect(orders.count("POST")).toBe(2);
      expect(finished.events.some((item) => item.message.includes("resumed its tool loop from a checkpoint"))).toBe(true);
    } finally {
      await recovered.runtime.shutdown();
    }
  }, 30_000);
});

describe("pause as a quiescence barrier (audit B4)", () => {
  it("drains an in-flight effect, flags it, and refuses to resume until reconciled", async () => {
    const orders = await service({ hold: true });
    const { store, runtime } = await harness();
    await connectHttp(store, "Orders", orders.url, false);
    const created = await runtime.createRun({ topologyId: "topology-local-studio", entryAgentId: "agent-orchestrator", objective: POST_ORDER });
    await until(() => orders.count("POST") === 1);

    const paused = await runtime.pauseRun(created.id);
    // pause returned only after the worker drained (the HTTP request was cancelled).
    const settled = await until(() => {
      const run = store.getRun(created.id);
      return run?.quiescedAt ? run : null;
    });
    expect(paused.status).toBe("paused");
    expect(orderCall(settled)).toMatchObject({ status: "indeterminate" });
    expect(settled.events.some((item) => item.type === "run_quiesced")).toBe(true);
    await expect(runtime.resumeRun(created.id)).rejects.toThrow(/Reconcile/);

    orders.releaseAll();
    await runtime.reconcileToolCall(created.id, orderCall(settled)!.id, { applied: true, note: "Confirmed in the order system." });
    await runtime.resumeRun(created.id);
    const finished = await terminalRun(store, created.id);
    expect(finished.status).toBe("completed");
    expect(orders.count("POST")).toBe(1);
  }, 30_000);

  it("starts no effect after pause, and runs it exactly once after resume", async () => {
    const orders = await service();
    const { store, runtime } = await harness();
    await connectHttp(store, "Orders", orders.url, false);
    const created = await runtime.createRun({ topologyId: "topology-local-studio", entryAgentId: "agent-orchestrator", objective: POST_ORDER });
    // Pause immediately, while the first model call is still in flight.
    const paused = await runtime.pauseRun(created.id);
    expect(paused.quiescedAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(orders.count("POST")).toBe(0);
    expect(store.getRun(created.id)!.toolCalls.some((call) => call.status === "started")).toBe(false);

    await runtime.resumeRun(created.id);
    const finished = await terminalRun(store, created.id);
    expect(finished.status).toBe("completed");
    expect(orders.count("POST")).toBe(1);
    expect(orderCall(finished)?.status).toBe("succeeded");
  }, 30_000);

  it("retries a read that was interrupted by a crash without asking for reconciliation", async () => {
    const catalog = await service({ holdReads: true });
    const { store, runtime, directory } = await harness();
    await connectHttp(store, "Catalog", catalog.url, false);
    const created = await runtime.createRun({
      topologyId: "topology-local-studio",
      entryAgentId: "agent-orchestrator",
      objective: '[direct] use tool http_catalog_request with {"method":"GET","path":"items"}',
    });
    const read = (run: Run | null) => run?.toolCalls.find((call) => call.targetName === "http_catalog_request");
    await until(() => read(store.getRun(created.id))?.status === "started" && catalog.count("GET") === 1);
    const image = await crashImage(directory);
    catalog.releaseAll();

    const recovered = await restart(image);
    try {
      expect(recovered.store.getRun(created.id)?.status).not.toBe("paused");
      const finished = await terminalRun(recovered.store, created.id);
      expect(finished.status).toBe("completed");
      expect(read(finished)).toMatchObject({ status: "succeeded", effect: "none", attempts: 2 });
      expect(catalog.count("GET")).toBe(2);
      expect(finished.toolCalls.some((call) => call.status === "indeterminate")).toBe(false);
    } finally {
      await recovered.runtime.shutdown();
    }
  }, 30_000);
});
