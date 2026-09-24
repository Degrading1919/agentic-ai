import type { ModelNode, ModelRuntimeState } from "../shared/contracts.js";
import { stableHash } from "../shared/capabilities.js";
import { requestLlamaSwapUnload } from "./providers.js";

type TransitionHandler = (state: ModelRuntimeState) => void | Promise<void>;

type Waiter = () => void;

type Entry = {
  state: ModelRuntimeState;
  /** Configuration the accounting (and any physical residency) describes. */
  loaded: ModelNode;
  /** Latest configuration requested for this key. */
  desired: ModelNode;
};

/** Residency is tracked per topology and model node. */
export function modelPoolKey(topologyId: string, modelId: string): string {
  return `${topologyId}/${modelId}`;
}

/** Identity of everything that changes what a resident model is or costs. */
export function modelConfigKey(model: ModelNode): string {
  const { provider, modelId, baseUrl, lifecycle, contextWindow, parallelSlots, estimatedMemoryMb, estimatedVramMb, artifact } =
    model.config;
  return stableHash(
    JSON.stringify([provider, modelId, baseUrl, lifecycle, contextWindow, parallelSlots, estimatedMemoryMb, estimatedVramMb, artifact.path, artifact.gpuLayers, artifact.adapters]),
  );
}

function cloneState(state: ModelRuntimeState): ModelRuntimeState {
  return structuredClone(state);
}

const occupiesMemory = (state: ModelRuntimeState) => !["unloaded", "failed"].includes(state.state);

function residencyControl(model: ModelNode): ModelRuntimeState["residencyControl"] {
  if (model.config.provider === "mock") return "simulated";
  return model.config.lifecycle === "llama-swap" ? "llama-swap" : "logical";
}

/**
 * Deterministic model residency scheduler.
 *
 * - Residency is keyed by topology + model node and versioned by a
 *   configuration key. A saved change re-accounts an idle model at once and
 *   a busy one as soon as its in-flight requests (made with the old
 *   configuration) drain; new requests never run under stale accounting.
 * - Each model has `parallelSlots` concurrent request slots; extra requests
 *   queue FIFO on that model.
 * - Loading a model must fit the RAM budget and, when known, the VRAM
 *   budget. An unknown VRAM estimate on a GPU-capable model is accounted as
 *   the whole VRAM budget (exclusive GPU) rather than as zero.
 * - Idle models are evicted least-recently-used first. If nothing can be
 *   evicted the request waits for capacity instead of failing.
 * - `residencyControl` says what the harness actually controls: physical
 *   load/unload for llama-swap, logical demand only for externally managed
 *   servers, simulation for the demo model.
 */
export class ModelPool {
  private readonly entries = new Map<string, Entry>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly slotWaiters = new Map<string, Waiter[]>();
  private capacityWaiters: Waiter[] = [];
  private poolLock = Promise.resolve();

  constructor(
    readonly memoryBudgetMb: number,
    private readonly onTransition?: TransitionHandler,
    public vramBudgetMb: number | null = null,
  ) {}

  snapshot(): ModelRuntimeState[] {
    return [...this.entries.values()].map((entry) => cloneState(entry.state));
  }

  isLoaded(key: string): boolean {
    const state = this.entries.get(key)?.state;
    return Boolean(state && ["resident", "executing", "idle", "loading"].includes(state.state));
  }

  /** VRAM to account for a model; unknown estimates reserve the whole budget. */
  vramFor(model: ModelNode): { mb: number; known: boolean } {
    const estimate = model.config.estimatedVramMb;
    if (estimate !== null) return { mb: estimate, known: true };
    if (model.config.provider === "mock" || this.vramBudgetMb === null) return { mb: 0, known: false };
    return { mb: this.vramBudgetMb, known: false };
  }

  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const key of [...this.entries.keys()]) await this.unload(key);
  }

  private account(entry: Entry, model: ModelNode): void {
    const vram = this.vramFor(model);
    Object.assign(entry.state, {
      modelName: model.name,
      provider: model.config.provider,
      estimatedMemoryMb: model.config.estimatedMemoryMb,
      estimatedVramMb: vram.mb,
      vramEstimateKnown: vram.known,
      parallelSlots: model.config.parallelSlots,
      configKey: modelConfigKey(model),
      residencyControl: residencyControl(model),
      reconfigurePending: false,
    });
    entry.loaded = structuredClone(model);
  }

  private entryFor(key: string, model: ModelNode): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      const vram = this.vramFor(model);
      entry = {
        loaded: structuredClone(model),
        desired: structuredClone(model),
        state: {
          modelId: key,
          modelName: model.name,
          state: "unloaded",
          provider: model.config.provider,
          activeRunId: null,
          estimatedMemoryMb: model.config.estimatedMemoryMb,
          estimatedVramMb: vram.mb,
          vramEstimateKnown: vram.known,
          configKey: modelConfigKey(model),
          reconfigurePending: false,
          residencyControl: residencyControl(model),
          parallelSlots: model.config.parallelSlots,
          activeRequests: 0,
          waitingRequests: 0,
          loadedAt: null,
          lastUsedAt: null,
          requestCount: 0,
          lastError: null,
        },
      };
      this.entries.set(key, entry);
    }
    entry.desired = structuredClone(model);
    if (modelConfigKey(model) !== entry.state.configKey) {
      if (!occupiesMemory(entry.state) && entry.state.activeRequests === 0) this.account(entry, model);
      else entry.state.reconfigurePending = true;
    }
    return entry;
  }

  private async transition(
    state: ModelRuntimeState,
    next: ModelRuntimeState["state"],
    patch: Partial<ModelRuntimeState> = {},
  ): Promise<void> {
    Object.assign(state, patch, { state: next });
    await this.onTransition?.(cloneState(state));
  }

  private usage(): { ramMb: number; vramMb: number } {
    let ramMb = 0;
    let vramMb = 0;
    for (const { state } of this.entries.values()) {
      if (!occupiesMemory(state)) continue;
      ramMb += state.estimatedMemoryMb;
      vramMb += state.estimatedVramMb;
    }
    return { ramMb, vramMb };
  }

  private evictable(): ModelRuntimeState[] {
    return [...this.entries.values()]
      .map((entry) => entry.state)
      .filter(
        (state) =>
          ["idle", "resident"].includes(state.state) &&
          state.activeRequests === 0 &&
          state.waitingRequests === 0,
      )
      .sort(
        (a, b) =>
          (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") || a.modelId.localeCompare(b.modelId),
      );
  }

  private fits(model: ModelNode, usage: { ramMb: number; vramMb: number }): boolean {
    const ramFits = usage.ramMb + model.config.estimatedMemoryMb <= this.memoryBudgetMb;
    const vramFits = this.vramBudgetMb === null || usage.vramMb + this.vramFor(model).mb <= this.vramBudgetMb;
    return ramFits && vramFits;
  }

  private assertFitsAlone(model: ModelNode): void {
    if (model.config.estimatedMemoryMb > this.memoryBudgetMb) {
      throw new Error(
        `Model '${model.name}' estimates ${model.config.estimatedMemoryMb} MB, above the configured ${this.memoryBudgetMb} MB residency budget. Increase AGENTIC_HARNESS_MEMORY_BUDGET_MB or use a smaller quantization.`,
      );
    }
    const vram = this.vramFor(model);
    if (this.vramBudgetMb !== null && vram.known && vram.mb > this.vramBudgetMb) {
      throw new Error(
        `Model '${model.name}' estimates ${vram.mb} MB of VRAM, above the ${this.vramBudgetMb} MB VRAM budget. Offload fewer layers or use a smaller quantization.`,
      );
    }
  }

  /**
   * Whether a request for this model could start now without waiting for a
   * slot, a reconfiguration, or another model to finish.
   */
  canStartNow(model: ModelNode, key: string = model.id): boolean {
    const entry = this.entries.get(key);
    const state = entry?.state;
    if (state && modelConfigKey(model) !== state.configKey && state.activeRequests > 0) return false;
    if (state && ["resident", "executing", "idle", "loading"].includes(state.state) && modelConfigKey(model) === state.configKey) {
      return state.activeRequests < model.config.parallelSlots;
    }
    if (state?.state === "unloading") return false;
    const usage = this.usage();
    if (state && occupiesMemory(state)) {
      usage.ramMb -= state.estimatedMemoryMb;
      usage.vramMb -= state.estimatedVramMb;
    }
    for (const candidate of this.evictable()) {
      if (this.fits(model, usage)) break;
      if (candidate.modelId === key) continue;
      usage.ramMb -= candidate.estimatedMemoryMb;
      usage.vramMb -= candidate.estimatedVramMb;
    }
    return this.fits(model, usage);
  }

  private async withPoolLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.poolLock;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.poolLock = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private wakeCapacityWaiters(): void {
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const wake of waiters) wake();
  }

  private waitForCapacity(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Run paused", "AbortError"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.capacityWaiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  /** Bring accounting (and llama-swap physical state) in line with the desired config. */
  private async reconfigure(key: string, entry: Entry, model: ModelNode): Promise<void> {
    await this.withPoolLock(async () => {
      if (modelConfigKey(model) === entry.state.configKey) return;
      if (occupiesMemory(entry.state)) await this.unloadLocked(key);
      this.account(entry, model);
    });
    this.wakeCapacityWaiters();
  }

  private async ensureLoaded(key: string, entry: Entry, model: ModelNode, signal?: AbortSignal) {
    this.assertFitsAlone(model);
    const state = entry.state;
    while (true) {
      const outcome = await this.withPoolLock(async () => {
        if (!["unloaded", "failed"].includes(state.state)) return "ready" as const;
        this.account(entry, model);
        const usage = this.usage();
        for (const candidate of this.evictable()) {
          if (this.fits(model, usage)) break;
          await this.unloadLocked(candidate.modelId);
          const refreshed = this.usage();
          usage.ramMb = refreshed.ramMb;
          usage.vramMb = refreshed.vramMb;
        }
        if (!this.fits(model, usage)) return "wait" as const;
        await this.transition(state, "loading", { lastError: null });
        // llama-swap performs the physical load when the first request reaches
        // it; this transition records the scheduler's deterministic intent.
        await new Promise((resolve) => setTimeout(resolve, model.config.provider === "mock" ? 25 : 0));
        const now = new Date().toISOString();
        await this.transition(state, "resident", { loadedAt: now, lastUsedAt: now });
        return "ready" as const;
      });
      if (outcome === "ready") return;
      await this.waitForCapacity(signal);
    }
  }

  private async acquireSlot(key: string, entry: Entry, model: ModelNode, signal?: AbortSignal) {
    const state = entry.state;
    const configKey = modelConfigKey(model);
    const blocked = () =>
      state.activeRequests >= model.config.parallelSlots ||
      state.state === "unloading" ||
      // A changed configuration waits for requests made with the old one to drain.
      (state.configKey !== configKey && state.activeRequests > 0);
    while (blocked()) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Run paused", "AbortError"));
        const waiters = this.slotWaiters.get(key) ?? [];
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        // An aborted waiter must leave the queue, or it would swallow a wake-up.
        const onAbort = () => {
          const index = waiters.indexOf(wake);
          if (index >= 0) waiters.splice(index, 1);
          reject(new DOMException("Run paused", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(wake);
        this.slotWaiters.set(key, waiters);
      });
    }
    state.activeRequests += 1;
  }

  private releaseSlot(key: string, state: ModelRuntimeState): void {
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    // Wake everyone: a reconfiguration waiter may be able to proceed now.
    const waiters = this.slotWaiters.get(key) ?? [];
    this.slotWaiters.set(key, []);
    for (const wake of waiters) wake();
  }

  async withModel<T>(
    model: ModelNode,
    runId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    key: string = model.id,
  ): Promise<T> {
    const entry = this.entryFor(key, model);
    const state = entry.state;
    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);

    state.waitingRequests += 1;
    try {
      await this.acquireSlot(key, entry, model, signal);
    } finally {
      state.waitingRequests -= 1;
    }

    try {
      if (modelConfigKey(model) !== state.configKey) await this.reconfigure(key, entry, model);
      await this.ensureLoaded(key, entry, model, signal);
      await this.transition(state, "executing", {
        activeRunId: runId,
        requestCount: state.requestCount + 1,
        lastUsedAt: new Date().toISOString(),
      });
      return await operation();
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      this.releaseSlot(key, state);
      if (state.activeRequests === 0 && occupiesMemory(state) && state.state !== "unloading") {
        await this.transition(state, "idle", {
          activeRunId: null,
          lastUsedAt: new Date().toISOString(),
        });
        if (state.reconfigurePending) await this.reconfigure(key, entry, entry.desired);
        else this.scheduleUnload(key, entry.loaded);
      }
      this.wakeCapacityWaiters();
    }
  }

  /**
   * Apply a saved topology: re-account changed models (unloading the old
   * physical model when idle) and retire models that were removed.
   */
  async reconcile(topologyId: string, models: Array<{ key: string; model: ModelNode }>): Promise<void> {
    const wanted = new Map(models.map((item) => [item.key, item.model]));
    for (const [key, entry] of [...this.entries.entries()]) {
      if (!key.startsWith(`${topologyId}/`)) continue;
      const model = wanted.get(key);
      const busy = entry.state.activeRequests > 0 || entry.state.waitingRequests > 0;
      if (!model) {
        if (!busy) {
          await this.unload(key);
          this.entries.delete(key);
        }
        continue;
      }
      entry.desired = structuredClone(model);
      if (modelConfigKey(model) === entry.state.configKey) continue;
      if (busy) entry.state.reconfigurePending = true;
      else await this.reconfigure(key, entry, model);
    }
  }

  private scheduleUnload(key: string, model: ModelNode): void {
    const existing = this.idleTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.unload(key), model.config.idleTtlMs);
    timer.unref();
    this.idleTimers.set(key, timer);
  }

  async unload(key: string): Promise<void> {
    await this.withPoolLock(() => this.unloadLocked(key));
    this.wakeCapacityWaiters();
  }

  private async unloadLocked(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    const { state } = entry;
    if (["unloaded", "unloading", "failed"].includes(state.state)) return;
    if (state.activeRequests > 0 || state.waitingRequests > 0) return;

    const timer = this.idleTimers.get(key);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(key);

    await this.transition(state, "unloading");
    try {
      // Unload what is actually resident: the configuration it was loaded with.
      await requestLlamaSwapUnload(entry.loaded);
      await this.transition(state, "unloaded", { activeRunId: null, loadedAt: null });
    } catch (error) {
      await this.transition(state, "failed", {
        activeRunId: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
