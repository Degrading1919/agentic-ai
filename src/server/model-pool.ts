import type { ModelNode, ModelRuntimeState } from "../shared/contracts.js";
import { requestLlamaSwapUnload } from "./providers.js";

type TransitionHandler = (state: ModelRuntimeState) => void | Promise<void>;

type Waiter = () => void;

function cloneState(state: ModelRuntimeState): ModelRuntimeState {
  return structuredClone(state);
}

const occupiesMemory = (state: ModelRuntimeState) => !["unloaded", "failed"].includes(state.state);

/**
 * Deterministic model residency scheduler.
 *
 * - Each model has `parallelSlots` concurrent request slots (llama.cpp
 *   `--parallel`); extra requests queue FIFO on that model.
 * - Loading a model must fit the RAM budget and, when known, the VRAM budget.
 *   Idle models are evicted least-recently-used first. If nothing can be
 *   evicted the request waits for capacity instead of failing, which turns a
 *   small machine into a sequential executor rather than an error.
 * - A model larger than the budget on its own fails fast with guidance.
 */
export class ModelPool {
  private readonly states = new Map<string, ModelRuntimeState>();
  private readonly models = new Map<string, ModelNode>();
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
    return [...this.states.values()].map(cloneState);
  }

  isLoaded(modelId: string): boolean {
    const state = this.states.get(modelId);
    return Boolean(state && ["resident", "executing", "idle", "loading"].includes(state.state));
  }

  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const modelId of [...this.states.keys()]) await this.unload(modelId);
  }

  private stateFor(model: ModelNode): ModelRuntimeState {
    this.models.set(model.id, structuredClone(model));
    let state = this.states.get(model.id);
    if (!state) {
      state = {
        modelId: model.id,
        modelName: model.name,
        state: "unloaded",
        provider: model.config.provider,
        activeRunId: null,
        estimatedMemoryMb: model.config.estimatedMemoryMb,
        estimatedVramMb: model.config.estimatedVramMb,
        parallelSlots: model.config.parallelSlots,
        activeRequests: 0,
        waitingRequests: 0,
        loadedAt: null,
        lastUsedAt: null,
        requestCount: 0,
        lastError: null,
      };
      this.states.set(model.id, state);
    }
    state.modelName = model.name;
    state.provider = model.config.provider;
    if (!occupiesMemory(state)) {
      state.estimatedMemoryMb = model.config.estimatedMemoryMb;
      state.estimatedVramMb = model.config.estimatedVramMb;
    }
    state.parallelSlots = model.config.parallelSlots;
    return state;
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
    for (const state of this.states.values()) {
      if (!occupiesMemory(state)) continue;
      ramMb += state.estimatedMemoryMb;
      vramMb += state.estimatedVramMb;
    }
    return { ramMb, vramMb };
  }

  private evictable(): ModelRuntimeState[] {
    return [...this.states.values()]
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
    const vramFits =
      this.vramBudgetMb === null ||
      usage.vramMb + model.config.estimatedVramMb <= this.vramBudgetMb;
    return ramFits && vramFits;
  }

  private assertFitsAlone(model: ModelNode): void {
    if (model.config.estimatedMemoryMb > this.memoryBudgetMb) {
      throw new Error(
        `Model '${model.name}' estimates ${model.config.estimatedMemoryMb} MB, above the configured ${this.memoryBudgetMb} MB residency budget. Increase AGENTIC_HARNESS_MEMORY_BUDGET_MB or use a smaller quantization.`,
      );
    }
    if (this.vramBudgetMb !== null && model.config.estimatedVramMb > this.vramBudgetMb) {
      throw new Error(
        `Model '${model.name}' estimates ${model.config.estimatedVramMb} MB of VRAM, above the ${this.vramBudgetMb} MB VRAM budget. Offload fewer layers or use a smaller quantization.`,
      );
    }
  }

  /**
   * Whether a request for this model could start now without waiting for a
   * slot or for another model to finish. Used for affinity scheduling.
   */
  canStartNow(model: ModelNode): boolean {
    const state = this.states.get(model.id);
    if (state && ["resident", "executing", "idle", "loading"].includes(state.state)) {
      return state.activeRequests < model.config.parallelSlots;
    }
    if (state?.state === "unloading") return false;
    const usage = this.usage();
    for (const candidate of this.evictable()) {
      if (this.fits(model, usage)) break;
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

  private async ensureLoaded(model: ModelNode, state: ModelRuntimeState, signal?: AbortSignal) {
    this.assertFitsAlone(model);
    while (true) {
      const outcome = await this.withPoolLock(async () => {
        if (!["unloaded", "failed"].includes(state.state)) return "ready" as const;
        const usage = this.usage();
        for (const candidate of this.evictable()) {
          if (this.fits(model, usage)) break;
          await this.unloadLocked(candidate.modelId);
          const refreshed = this.usage();
          usage.ramMb = refreshed.ramMb;
          usage.vramMb = refreshed.vramMb;
        }
        if (!this.fits(model, usage)) return "wait" as const;
        await this.transition(state, "loading", {
          lastError: null,
          estimatedMemoryMb: model.config.estimatedMemoryMb,
          estimatedVramMb: model.config.estimatedVramMb,
        });
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

  private async acquireSlot(model: ModelNode, state: ModelRuntimeState, signal?: AbortSignal) {
    while (state.activeRequests >= model.config.parallelSlots || state.state === "unloading") {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Run paused", "AbortError"));
        const waiters = this.slotWaiters.get(model.id) ?? [];
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
        this.slotWaiters.set(model.id, waiters);
      });
    }
    state.activeRequests += 1;
  }

  private releaseSlot(model: ModelNode, state: ModelRuntimeState): void {
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    const next = this.slotWaiters.get(model.id)?.shift();
    next?.();
  }

  async withModel<T>(
    model: ModelNode,
    runId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const state = this.stateFor(model);
    const timer = this.idleTimers.get(model.id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(model.id);

    state.waitingRequests += 1;
    try {
      await this.acquireSlot(model, state, signal);
    } finally {
      state.waitingRequests -= 1;
    }

    try {
      await this.ensureLoaded(model, state, signal);
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
      this.releaseSlot(model, state);
      if (state.activeRequests === 0 && occupiesMemory(state) && state.state !== "unloading") {
        await this.transition(state, "idle", {
          activeRunId: null,
          lastUsedAt: new Date().toISOString(),
        });
        this.scheduleUnload(model);
      }
      this.wakeCapacityWaiters();
    }
  }

  private scheduleUnload(model: ModelNode): void {
    const existing = this.idleTimers.get(model.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.unload(model.id), model.config.idleTtlMs);
    timer.unref();
    this.idleTimers.set(model.id, timer);
  }

  async unload(modelId: string): Promise<void> {
    await this.withPoolLock(() => this.unloadLocked(modelId));
    this.wakeCapacityWaiters();
  }

  private async unloadLocked(modelId: string): Promise<void> {
    const state = this.states.get(modelId);
    const model = this.models.get(modelId);
    if (!state || !model || ["unloaded", "unloading", "failed"].includes(state.state)) return;
    if (state.activeRequests > 0 || state.waitingRequests > 0) return;

    const timer = this.idleTimers.get(modelId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(modelId);

    await this.transition(state, "unloading");
    try {
      await requestLlamaSwapUnload(model);
      await this.transition(state, "unloaded", { activeRunId: null, loadedAt: null });
    } catch (error) {
      await this.transition(state, "failed", {
        activeRunId: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
