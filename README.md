# Agentic Harness

Agentic Harness is a local-first visual orchestration IDE for teams of specialized AI workers. It pairs a focused chat-style **Work** view with a node-based **Configure** editor.

The graph is a **capability topology, not a workflow DAG**. An edge grants access to a model, tool, skill, connector, storage target, or another agent. Canvas position never grants permission and never defines execution order.

The same edges form three boundaries at once:

- **Security**: an agent can use only what is connected to it, re-checked before every call.
- **Hallucination**: a model is told only about what it can actually use.
- **Context budget**: connecting a resource authorizes it, but does not automatically put its full definition into every prompt.

## What works

**Topology and workers**
- Visual topology editing with React Flow: models, agents, capabilities, skills, MCP/HTTP connectors, and storage.
- Separate model artifacts and agent configurations, including lineage metadata for custom fine-tunes.
- Typed relationships with distinct runtime behaviour. **Delegate** keeps ownership, **consult** returns read-only advice, **review** returns structured verdicts and drives bounded revisions, **handoff** transfers ownership and the return path, and **report** delivers status to an inbox with no inference.
- Planning that invokes only collaborators who add value: plans are validated against edges and capped, and skipped collaborators are shown.

**Context efficiency**
- Deferred capability discovery: large tool sets become a compact catalog plus `find_tools`/`call_tool`, so a 150-tool MCP server costs about a thousand tokens instead of about twenty thousand.
- On-demand skills that cost one catalog line until a worker loads them.
- A deterministic, cache-friendly prompt prefix per agent, with dynamic work-order data kept after it.
- Per-agent context footprints in Configure, plus per-call context frames in Work: tokens by segment, prefix reuse, and server-reported cache hits.
- Budget-aware packing with summaries and `read_artifact` references, thread digests and retrieved memory instead of transcript replay, and phase-based resume.

**Capabilities and storage**
- MCP client over stdio and Streamable HTTP (official SDK), with tool discovery, cached catalogs, per-tool allowlists, and read-only filtering.
- HTTP API connector confined to its base URL and allowed methods.
- Storage adapters for artifact stores and project folders with scope and symlink-escape enforcement, plus a local BM25 memory store.

**Runtime and hardware**
- OpenAI-compatible local inference (llama.cpp, llama-swap, Ollama-compatible, LM Studio, vLLM) and a deterministic offline demo model.
- Deterministic scheduling: per-model parallel slots, RAM and VRAM budgets, LRU eviction, waiting for capacity instead of failing, and overlapping independent work when models fit.
- NVIDIA GPU telemetry via `nvidia-smi`, alongside CPU and RAM.
- GGUF inspection with KV-cache memory estimates, and llama-swap config generation.
- Durable runs, pause/resume with completed work preserved, and recovery after a restart.

## Quick start

Requirements:

- Node.js 22 or newer
- pnpm 11 or newer

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The development command starts the API on port `8787` and Vite on port `5173`.

For a production-style local run:

```bash
pnpm build
pnpm start
```

Then open [http://127.0.0.1:8787](http://127.0.0.1:8787).

The first start creates a runnable **Local product studio** topology: an Orchestrator that can delegate to a Builder, consult an Architect, and request reviews from a Reviewer. It also has a calculator, an on-demand skill, team memory, a project workspace, and a disabled MCP connector. Its built-in demo model is deterministic and offline. If you already have saved state from an earlier version, add the example with the **+** button next to the topology selector.

## Use the product

### Configure

1. Add nodes from the library.
2. Draw **from an agent** to another node to grant access.
3. Select an agent-to-agent edge to choose delegate, consult, review, report, or handoff; the inspector explains what each does at runtime.
4. Select a storage edge to set read, write, and scope permissions.
5. Select an agent to see its **stable context per request** and to set tool exposure, fan-out, and iteration limits. The canvas badge turns amber above 25% of the model window and red above 50%.
6. Select a connector to discover MCP tools and choose which ones are authorized.
7. Save the topology. Invalid drafts may be saved, but Work refuses to run them until blocking issues are fixed.

Each agent must have exactly one model edge. At least one agent must be marked **Available in Work**.

### Work

1. Choose an entry agent and submit a task. Select a finished run and keep **Continue thread** checked to follow up; the new run gets a digest of prior work, not its transcript.
2. **Delegation decisions** show which collaborators were selected and which were skipped.
3. The **work-order tree** shows ownership, phase, verdicts, revisions, handoffs, and advisory consults. Select an order to see its context per model call.
4. The run summary shows agents used, model calls, context sent, cache hits, and prefix reuse.
5. Pause an active run before changing execution boundaries or instructions, save, and resume. Completed orders remain intact; queued work whose relationship was removed is blocked.

Try: `Calculate 72 * 18, build the implementation plan, and review its risks.`

## Connect llama.cpp

```bash
llama-server -m /absolute/path/to/model.gguf --host 127.0.0.1 --port 8080 --alias specialist --parallel 2
```

In Configure, select a Model node and set Provider `OpenAI compatible`, Model ID `specialist`, Base URL `http://127.0.0.1:8080/v1`, Parallel slots `2`, and Lifecycle `Externally managed / logical`. Save and use **Test connection**.

## Connect llama-swap

Point the Model node at llama-swap's `/v1` base URL, set Lifecycle to `llama-swap managed`, and set the artifact path. **Inspect GGUF** fills in quantization, lineage, and a memory estimate. The **llama-swap** button in Configure generates a `config.yaml` for every managed artifact, including context size, parallel slots, GPU layers, and LoRA adapters.

See [Running local models](docs/RUNNING_LOCAL_MODELS.md).

## Connect MCP servers

Add a Connector node, choose Streamable HTTP or a local stdio command, enable it, connect it to the agents that may use it, and click **Discover tools**. See [Connecting MCP servers and APIs](docs/CONNECTORS.md).

## Local data and environment

By default, state is stored in `.agentic-harness/` under the directory where the server starts:

```text
.agentic-harness/
├── state.json                  topologies, runs, cached connector catalogs
├── storage/<location>/…        artifact-store nodes (run archives land in the entry agent's scope)
├── memory/<location>/memory.jsonl
└── workspace/<location>/…      project-files nodes with a relative location
```

Writes use a temporary file followed by an atomic rename. State from earlier versions loads unchanged.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTIC_HARNESS_HOST` | `127.0.0.1` | API/static server bind address |
| `AGENTIC_HARNESS_PORT` | `8787` | API/static server port |
| `AGENTIC_HARNESS_DATA_DIR` | `./.agentic-harness` | Durable state directory |
| `AGENTIC_HARNESS_WORKSPACE_DIR` | `<data dir>/workspace` | Root for project-files storage with relative locations |
| `AGENTIC_HARNESS_MEMORY_BUDGET_MB` | 50% of system RAM | Model residency RAM budget |
| `AGENTIC_HARNESS_VRAM_BUDGET_MB` | 90% of largest GPU | Model residency VRAM budget (unenforced when unknown) |
| `AGENTIC_HARNESS_MAX_CONCURRENT_RUNS` | `1` | Concurrent run limit, capped at 8 |
| `AGENTIC_HARNESS_MAX_PARALLEL_ORDERS` | `4` | Work orders that may overlap within one run |
| `AGENTIC_HARNESS_GPU_TELEMETRY` | on | Set to `off` to skip `nvidia-smi` |
| `AGENTIC_HARNESS_LOG_LEVEL` | `info` | Fastify log level |

Model API keys and connector tokens are referenced by environment-variable name. Secret values are never written into topology state. The server has no authentication and should stay bound to localhost.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The suite (123 tests) covers topology validity, stable-prefix determinism, deferred exposure at 150 tools, context packing and per-call tool-loop fitting on small windows, storage containment against drive-qualified, UNC, and device scopes and Windows junctions, transactional state writes under injected failures, the artifact information-flow policy, fail-closed reviews and review after handoff, effect recovery from crash images against a real HTTP service (non-idempotent reconciliation, idempotent retry keys, checkpoint non-replay), pause as a quiescence barrier, MCP credential rotation, definition drift, TTL expiry and hostile payload limits on live SDK servers, residency re-accounting and VRAM estimation, every relationship semantic, thread continuation, GGUF parsing, llama-swap config generation, GPU telemetry parsing, and migration of earlier state.

The [2026-09-24 audit remediation report](docs/audits/2026-09-24-sol-high-remediation.md) maps each audit finding to its fix and regression tests.

## Architecture

```text
React Work / Configure UI ──── shared: contracts · topology · capabilities · prompt · tokens
           │
           ▼
      Local Fastify API
           │
    ┌──────┴─────────┐
    ▼                ▼
Topology guard   Durable store (state.json, catalogs)
    │
    ▼
Work-order runtime ── planner (edge-validated, bounded fan-out)
    │                 context builder (stable prefix · packing · frames)
    ├── relationship semantics: delegate · consult · review · handoff · report
    ├── capability executor ── calculator · storage adapters · MCP (SDK) · HTTP API
    ├── model pool: slots · RAM/VRAM budgets · eviction · affinity
    └── providers: OpenAI-compatible · deterministic demo
```

The scheduler, not an LLM, owns queueing, legality checks, context assembly, model residency, and recovery. See [Architecture](docs/ARCHITECTURE.md) and the decisions in [`docs/architecture`](docs/architecture).

## Extension points

- Inference providers: `src/server/providers.ts`.
- Built-in capabilities: `src/shared/capabilities.ts` (descriptor) and `src/server/capability-executor.ts` (execution).
- Storage adapters: `src/server/storage.ts`, keyed by storage type.
- Node and edge schemas: `src/shared/contracts.ts`; edge legality: `src/shared/topology.ts`.
- Context segments and prompt order: `src/shared/prompt.ts` and `src/server/context-builder.ts`.

## Safety and recovery

- **Filesystem scopes** never follow links or junctions and reject drive-qualified, UNC, device, and traversal paths.
- **Artifacts** are readable only through work-order relationships (dependency, subject, child, revision, handoff, own tool results, root-chain thread history).
- **External effects** are recorded in a durable ledger. After a crash or pause, retry-safe calls repeat with the same operation ID (`Idempotency-Key`); others pause the run until a human records whether they took effect. Nothing is blindly replayed.
- **Pause** returns once no model call or tool effect is in flight.
- **Reviews** fail closed: malformed or missing verdicts mark results unreviewed, never approved.
- **MCP trust** is local: read-only and retry-safe decisions are pinned to tool definitions, catalogs are re-verified per credential and TTL, and untrusted payloads are size-bounded.

## Current limits

- Pre-request token counts are estimates; server-reported usage is recorded alongside them, and cache hits are shown only when the server reports them.
- Idempotent effects are at-least-once under a stable key and effectful ones at-most-once with human reconciliation; exactly-once is not claimed. A local process that swaps storage directories for links during an operation is outside the storage threat model.
- GPU telemetry is NVIDIA-only. `vector-store` has no adapter yet (use `memory`); `git` storage reads and writes files without committing.
- MCP support covers tools (not resources, prompts, or OAuth). A2A is implemented in-process; no cross-process A2A transport yet.
- The store is a single JSON document for a single process.

## Upstream work

The implementation uses React Flow and the official MCP TypeScript SDK directly, and follows integration patterns studied in Langflow, llama.cpp, llama-swap, Open WebUI, MCP, and A2A. See [Third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
