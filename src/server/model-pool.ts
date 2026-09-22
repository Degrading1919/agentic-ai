import type { ModelNode, ModelRuntimeState } from "../shared/contracts.js";
import { requestLlamaSwapUnload } from "./providers.js";

type TransitionHandler = (state: ModelRuntimeState) => void | Promise<void>;

function cloneState(state: ModelRuntimeState): ModelRuntimeState {
  return structuredClone(state);
}

export class ModelPool {
  private readonly states = new Map<string, ModelRuntimeState>();
  private readonly models = new Map<string, ModelNode>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly modelLocks = new Map<string, Promise<void>>();
  private poolLock = Promise.resolve();

  constructor(
    readonly memoryBudgetMb: number,
    private readonly onTransition?: TransitionHandler,
  ) {}

  snapshot(): ModelRuntimeState[] {
    return [...this.states.values()].map(cloneState);
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
        loadedAt: null,
        lastUsedAt: null,
        requestCount: 0,
        lastError: null,
      };
      this.states.set(model.id, state);
    }
    state.modelName = model.name;
    state.provider = model.config.provider;
    state.estimatedMemoryMb = model.config.estimatedMemoryMb;
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

  private residentMemoryMb(): number {
    return [...this.states.values()]
      .filter((state) => !["unloaded", "failed"].includes(state.state))
      .reduce((sum, state) => sum + state.estimatedMemoryMb, 0);
  }

  private async ensureCapacity(model: ModelNode): Promise<void> {
    if (model.config.estimatedMemoryMb > this.memoryBudgetMb) {
      throw new Error(
        `Model '${model.name}' estimates ${model.config.estimatedMemoryMb} MB, above the configured ${this.memoryBudgetMb} MB residency budget. Increase AGENTIC_HARNESS_MEMORY_BUDGET_MB or use a smaller quantization.`,
      );
    }

    while (this.residentMemoryMb() + model.config.estimatedMemoryMb > this.memoryBudgetMb) {
      const candidate = [...this.states.values()]
        .filter((state) => state.state === "idle" || state.state === "resident")
        .sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""))[0];
      if (!candidate) {
        throw new Error(
          `No idle model can be evicted to load '${model.name}' within the ${this.memoryBudgetMb} MB residency budget.`,
        );
      }
      await this.unload(candidate.modelId);
    }
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

  private async load(model: ModelNode): Promise<ModelRuntimeState> {
    return this.withPoolLock(async () => {
      const state = this.stateFor(model);
      if (!["unloaded", "failed"].includes(state.state)) return state;
      await this.ensureCapacity(model);
      await this.transition(state, "loading", { lastError: null });
      // llama-swap performs the physical load when the first request reaches it.
      // This transition still exposes the scheduler's deterministic intent.
      await new Promise((resolve) =>
        setTimeout(resolve, model.config.provider === "mock" ? 25 : 0),
      );
      const now = new Date().toISOString();
      await this.transition(state, "resident", { loadedAt: now, lastUsedAt: now });
      return state;
    });
  }

  async withModel<T>(
    model: ModelNode,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.modelLocks.get(model.id) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.modelLocks.set(model.id, queued);
    await previous;

    try {
      return await this.executeWithModel(model, runId, operation);
    } finally {
      release();
      if (this.modelLocks.get(model.id) === queued) this.modelLocks.delete(model.id);
    }
  }

  private async executeWithModel<T>(
    model: ModelNode,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const timer = this.idleTimers.get(model.id);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(model.id);

    const state = await this.load(model);
    await this.transition(state, "executing", {
      activeRunId: runId,
      requestCount: state.requestCount + 1,
      lastUsedAt: new Date().toISOString(),
    });

    try {
      return await operation();
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      await this.transition(state, "idle", {
        activeRunId: null,
        lastUsedAt: new Date().toISOString(),
      });
      this.scheduleUnload(model);
    }
  }

  private scheduleUnload(model: ModelNode): void {
    const timer = setTimeout(() => void this.unload(model.id), model.config.idleTtlMs);
    timer.unref();
    this.idleTimers.set(model.id, timer);
  }

  async unload(modelId: string): Promise<void> {
    const state = this.states.get(modelId);
    const model = this.models.get(modelId);
    if (!state || !model || ["unloaded", "unloading"].includes(state.state)) return;
    if (state.state === "executing") return;

    const timer = this.idleTimers.get(modelId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(modelId);

    await this.transition(state, "unloading");
    try {
      await requestLlamaSwapUnload(model);
      await this.transition(state, "unloaded", {
        activeRunId: null,
        loadedAt: null,
      });
    } catch (error) {
      await this.transition(state, "failed", {
        activeRunId: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
