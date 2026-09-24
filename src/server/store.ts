import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState, ConnectorCatalog, Run, Topology } from "../shared/contracts.js";
import { appStateSchema, connectorCatalogSchema, runSchema, topologySchema } from "../shared/contracts.js";
import { createDemoTopology } from "../shared/demo-topology.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Single-document durable state.
 *
 * Every mutation is transactional: the next state is built from a copy,
 * validated, persisted with an atomic rename, and only then published as the
 * live state. A validation error or a failed write leaves the live state
 * exactly equal to the durable state. Readers never observe unpersisted data.
 */
export class LocalStore {
  readonly dataDir: string;
  readonly statePath: string;
  private state: AppState | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    this.dataDir = path.resolve(
      dataDir ??
        process.env.AGENTIC_HARNESS_DATA_DIR ??
        path.join(process.cwd(), ".agentic-harness"),
    );
    this.statePath = path.join(this.dataDir, "state.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.statePath, "utf8");
      this.state = appStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new Error(
          `Unable to load local state at ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const topology = createDemoTopology();
      const initial: AppState = {
        version: 1,
        activeTopologyId: topology.id,
        topologies: [topology],
        runs: [],
        connectorCatalogs: [],
      };
      await this.writeDocument(`${JSON.stringify(initial, null, 2)}\n`);
      this.state = initial;
    }
  }

  private requireState(): AppState {
    if (!this.state) throw new Error("LocalStore.init() must be called before use.");
    return this.state;
  }

  /** Atomic replace of the state document. Overridable to inject failures in tests. */
  protected async writeDocument(content: string): Promise<void> {
    const temporaryPath = `${this.statePath}.next`;
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, this.statePath);
  }

  /**
   * Serialize a transaction: `build` returns the complete next state without
   * touching the current one; it is persisted, then published.
   */
  private commit<T>(build: (current: AppState) => { next: AppState; result: T }): Promise<T> {
    const task = this.writeChain.then(async () => {
      const { next, result } = build(this.requireState());
      await this.writeDocument(`${JSON.stringify(next, null, 2)}\n`);
      this.state = next;
      return clone(result);
    });
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  snapshot(): AppState {
    return clone(this.requireState());
  }

  /** Resolves once every queued mutation has been persisted (or rejected). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  listCatalogs(): ConnectorCatalog[] {
    return clone(this.requireState().connectorCatalogs);
  }

  async saveCatalog(catalog: ConnectorCatalog): Promise<ConnectorCatalog> {
    const valid = connectorCatalogSchema.parse(clone(catalog));
    return this.commit((state) => ({
      next: {
        ...state,
        connectorCatalogs: [
          ...state.connectorCatalogs.filter(
            (item) => !(item.connectorId === valid.connectorId && item.fingerprint === valid.fingerprint),
          ),
          valid,
        ],
      },
      result: valid,
    }));
  }

  listTopologies(): Topology[] {
    return clone(this.requireState().topologies);
  }

  getTopology(id: string): Topology | null {
    const topology = this.requireState().topologies.find((item) => item.id === id);
    return topology ? clone(topology) : null;
  }

  async saveTopology(topology: Topology): Promise<Topology> {
    const valid = topologySchema.parse(clone(topology));
    return this.commit((state) => {
      const exists = state.topologies.some((item) => item.id === valid.id);
      return {
        next: {
          ...state,
          activeTopologyId: valid.id,
          topologies: exists
            ? state.topologies.map((item) => (item.id === valid.id ? valid : item))
            : [...state.topologies, valid],
        },
        result: valid,
      };
    });
  }

  listRuns(limit = 50): Run[] {
    return clone(
      [...this.requireState().runs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    );
  }

  /**
   * List view without heavy per-run detail. Projection happens before
   * cloning, so polling does not copy every context frame and message.
   */
  listRunSummaries(limit = 50): Run[] {
    return [...this.requireState().runs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((run) =>
        clone({
          ...run,
          workOrders: [],
          messages: [],
          events: run.events.slice(-1),
          contextFrames: [],
          plans: [],
          reports: [],
          artifacts: [],
          result: null,
        }),
      );
  }

  hasRunWithStatus(status: Run["status"]): boolean {
    return this.requireState().runs.some((run) => run.status === status);
  }

  /** Runs in a thread (the thread root plus follow-ups), newest first. */
  listThread(threadId: string): Run[] {
    return clone(
      this.requireState()
        .runs.filter((run) => run.threadId === threadId || run.id === threadId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  getRun(id: string): Run | null {
    const run = this.requireState().runs.find((item) => item.id === id);
    return run ? clone(run) : null;
  }

  async createRun(run: Run): Promise<Run> {
    const valid = runSchema.parse(clone(run));
    return this.commit((state) => {
      if (state.runs.some((item) => item.id === valid.id)) {
        throw new Error(`Run '${valid.id}' already exists.`);
      }
      return { next: { ...state, runs: [...state.runs, valid] }, result: valid };
    });
  }

  async replaceRun(run: Run): Promise<Run> {
    const valid = runSchema.parse(clone(run));
    return this.commit((state) => {
      if (!state.runs.some((item) => item.id === valid.id)) throw new Error(`Run '${valid.id}' does not exist.`);
      return {
        next: { ...state, runs: state.runs.map((item) => (item.id === valid.id ? valid : item)) },
        result: valid,
      };
    });
  }

  /**
   * Mutate a copy of one run. The callback may throw to abort the
   * transaction; nothing it changed becomes visible.
   */
  async mutateRun(id: string, mutation: (run: Run) => void): Promise<Run> {
    return this.commit((state) => {
      const current = state.runs.find((item) => item.id === id);
      if (!current) throw new Error(`Run '${id}' does not exist.`);
      const draft = clone(current);
      mutation(draft);
      draft.updatedAt = new Date().toISOString();
      const valid = runSchema.parse(draft);
      return {
        next: { ...state, runs: state.runs.map((item) => (item.id === id ? valid : item)) },
        result: valid,
      };
    });
  }
}
