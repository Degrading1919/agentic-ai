import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppState, ConnectorCatalog, Run, Topology } from "../shared/contracts.js";
import { appStateSchema } from "../shared/contracts.js";
import { createDemoTopology } from "../shared/demo-topology.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LocalStore {
  readonly dataDir: string;
  readonly statePath: string;
  readonly artifactDir: string;
  private state: AppState | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir?: string) {
    this.dataDir = path.resolve(
      dataDir ??
        process.env.AGENTIC_HARNESS_DATA_DIR ??
        path.join(process.cwd(), ".agentic-harness"),
    );
    this.statePath = path.join(this.dataDir, "state.json");
    this.artifactDir = path.join(this.dataDir, "artifacts");
  }

  async init(): Promise<void> {
    await mkdir(this.artifactDir, { recursive: true });
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
      this.state = {
        version: 1,
        activeTopologyId: topology.id,
        topologies: [topology],
        runs: [],
        connectorCatalogs: [],
      };
      await this.persist();
    }
  }

  private requireState(): AppState {
    if (!this.state) throw new Error("LocalStore.init() must be called before use.");
    return this.state;
  }

  private async persist(): Promise<void> {
    const state = this.requireState();
    const temporaryPath = `${this.statePath}.next`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.statePath);
  }

  private enqueueMutation<T>(mutation: (state: AppState) => T): Promise<T> {
    let resultPromise: Promise<T>;
    resultPromise = this.writeChain.then(async () => {
      const state = this.requireState();
      const result = mutation(state);
      appStateSchema.parse(state);
      await this.persist();
      return clone(result);
    });
    this.writeChain = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  snapshot(): AppState {
    return clone(this.requireState());
  }

  /** Resolves once every queued mutation has been persisted. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  listCatalogs(): ConnectorCatalog[] {
    return clone(this.requireState().connectorCatalogs);
  }

  async saveCatalog(catalog: ConnectorCatalog): Promise<ConnectorCatalog> {
    return this.enqueueMutation((state) => {
      state.connectorCatalogs = [
        ...state.connectorCatalogs.filter((item) => item.connectorId !== catalog.connectorId),
        clone(catalog),
      ];
      return catalog;
    });
  }

  listTopologies(): Topology[] {
    return clone(this.requireState().topologies);
  }

  getTopology(id: string): Topology | null {
    const topology = this.requireState().topologies.find((item) => item.id === id);
    return topology ? clone(topology) : null;
  }

  async saveTopology(topology: Topology): Promise<Topology> {
    return this.enqueueMutation((state) => {
      const next = clone(topology);
      const existingIndex = state.topologies.findIndex((item) => item.id === next.id);
      if (existingIndex >= 0) state.topologies[existingIndex] = next;
      else state.topologies.push(next);
      state.activeTopologyId = next.id;
      return next;
    });
  }

  listRuns(limit = 50): Run[] {
    return clone(
      [...this.requireState().runs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    );
  }

  getRun(id: string): Run | null {
    const run = this.requireState().runs.find((item) => item.id === id);
    return run ? clone(run) : null;
  }

  async createRun(run: Run): Promise<Run> {
    return this.enqueueMutation((state) => {
      if (state.runs.some((item) => item.id === run.id)) {
        throw new Error(`Run '${run.id}' already exists.`);
      }
      state.runs.push(clone(run));
      return run;
    });
  }

  async replaceRun(run: Run): Promise<Run> {
    return this.enqueueMutation((state) => {
      const index = state.runs.findIndex((item) => item.id === run.id);
      if (index < 0) throw new Error(`Run '${run.id}' does not exist.`);
      state.runs[index] = clone(run);
      return run;
    });
  }

  async mutateRun(id: string, mutation: (run: Run) => void): Promise<Run> {
    return this.enqueueMutation((state) => {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error(`Run '${id}' does not exist.`);
      mutation(run);
      run.updatedAt = new Date().toISOString();
      return run;
    });
  }

  async writeRunArtifact(
    runId: string,
    filename: "final.md" | "conversation.json",
    content: string,
  ): Promise<string> {
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const runDirectory = path.resolve(this.artifactDir, safeRunId);
    if (!runDirectory.startsWith(`${this.artifactDir}${path.sep}`)) {
      throw new Error("Artifact path escaped the configured data directory.");
    }
    await mkdir(runDirectory, { recursive: true });
    const artifactPath = path.join(runDirectory, filename);
    await writeFile(artifactPath, content, "utf8");
    return artifactPath;
  }
}
