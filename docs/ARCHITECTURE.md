# Architecture

This document describes the current runtime. The original MVP design is preserved in [MVP_ARCHITECTURE.md](MVP_ARCHITECTURE.md); accepted decisions live in [`docs/architecture`](architecture).

## Three boundaries from one graph

The Configure graph is a capability topology, not a workflow DAG. Every edge starts at an agent and grants something. The same edges act as three boundaries:

| Boundary | What the edge controls | Enforced by |
| --- | --- | --- |
| Security | Which tools, storage scopes, connectors, and collaborators an agent may use | `resolveToolDescriptors`, storage adapters, permission re-checks before each call |
| Hallucination | What the model is told exists | The stable prefix lists only connected resources; unknown tool names return a boundary error |
| Context budget | How much of the model window the agent's configuration consumes | Exposure planning, the context packer, and per-call context frames |

Authorization and exposure are separate. An edge authorizes a tool; exposure planning decides whether its full schema is sent with every request or discovered on demand.

## Module map

```text
src/shared/                      (used by server and Configure UI)
  contracts.ts     typed schemas (Zod) for topology, work orders, runs, frames, catalogs
  topology.ts      edge legality, validation, agent context, relationship semantics
  capabilities.ts  authorization → tool descriptors; exposure planning; meta tools
  prompt.ts        deterministic stable prefix; per-agent footprint estimates
  tokens.ts        tokenizer-free estimator, truncation

src/server/
  runtime.ts          scheduler, work-order lifecycle, relationship semantics, tool loop
  planner.ts          plan schema, validation against edges, relevance fallback
  context-builder.ts  budget-aware packing, context frames, extractive summaries
  capability-executor.ts  dispatch to calculator, storage, MCP, HTTP API
  mcp.ts              MCP client sessions (official SDK; stdio + Streamable HTTP)
  storage.ts          filesystem and memory adapters with scope enforcement
  model-pool.ts       residency, parallel slots, RAM/VRAM budgets, eviction, waiting
  hardware.ts         CPU/RAM, nvidia-smi GPU telemetry, budgets
  providers.ts        OpenAI-compatible transport, cache-hit capture
  mock-provider.ts    deterministic offline simulator used by the demo and tests
  gguf.ts             GGUF metadata reader and memory estimate
  llama-swap.ts       llama-swap config generation
  store.ts            single-document durable state with atomic writes
```

## Capability resolution and exposure

`resolveToolDescriptors(context, catalogs, accessMode)` turns an agent's edges into tool descriptors:

- **Capability** nodes → built-in tools (the safe calculator).
- **Storage** edges → `fs_<name>_list/read/write` or `memory_<name>_search/remember`, generated only for granted permissions.
- **MCP connectors** → one descriptor per discovered tool, filtered by the connector's allowlist.
- **HTTP API connectors** → one request tool restricted to the base URL and allowed methods.

Descriptors are sorted by node ID and tool name, so edge insertion order never changes the prompt. `read-only` access (consult and review orders) removes write tools, non-GET HTTP methods, and every MCP tool that is not marked read-only by a *local* trust policy pinned to its current definition hash. Server annotations such as `readOnlyHint` are advisory and never grant read-only access by themselves.

Each descriptor also carries an effect class (`none`, `idempotent`, `effectful`) that decides recovery after an interruption (see [ADR 009](architecture/009-effect-recovery-and-quiescence.md)).

`planToolExposure` then chooses:

- **eager**: every schema is sent natively (small tool sets; `auto` uses at most `eagerToolLimit` tools and ≈1,200 schema tokens);
- **deferred**: the prefix carries a compact catalog (one line per tool, or grouped counts above 40 tools) plus two stable harness tools, `find_tools` and `call_tool`.

Deferred loading never changes the `tools` payload. `find_tools` returns schemas as a tool result in the dynamic tail, and `call_tool` dispatches by name. The request prefix stays byte-identical as tools are discovered, which matters because many chat templates, llama.cpp's included, render tool schemas into the prompt prefix. A `call_tool` for a tool whose schema has not been loaded returns the schema instead of executing, so the model must see a schema before using it.

Other harness tools appear only when the topology makes them meaningful: `load_skill` (on-demand skills), `consult_agent` (consult edges), `handoff_work` (handoff edges), and `read_artifact` (fetch a full result that the context carried only as a summary).

## Cache-aware prompt construction

Every request has two parts:

1. **Stable prefix** (system message + tools): harness rules, worker instructions, always-on skills, the on-demand skill catalog, collaborators with relationship semantics, connected resources, the deferred tool catalog, and tool schemas. `buildStablePrefix` accepts only topology-derived inputs. It never sees objectives, run IDs, timestamps, or results, so plan, execute, integrate, and tool-loop calls from one agent share an identical prefix.
2. **Dynamic payload** (user message): the work-order envelope, thread digest, retrieved memory, inbox reports, dependencies (specialist outputs, advice, verdicts, revision requests), and the growing tool loop.

Each request records a **context frame**: token estimates per segment (stable or dynamic, trimmed or not, including the JSON response schema), a hash of the actual serialized request prefix (provider, endpoint, model, system message, tools sent, response schema), `localPrefixMatch` (that prefix equals the previous request *dispatched* to the same model — a local equality signal, not a cache measurement), how many tool results were elided to fit, exposure mode, authorized versus exposed schemas, and server-reported prompt tokens and cache hits (`usage.prompt_tokens_details.cached_tokens`, or llama.cpp `timings.cache_n`). Measured tokens and cache hits are counted only when the server reports them; otherwise the UI shows "n/a". Frames store sizes, never prompt text.

The Configure view uses the same `buildStablePrefix` through `estimateAgentFootprint`, so the canvas badge and inspector bar match what the runtime sends.

## Context lifecycle

- **Packing.** `packContext` reserves the agent's output budget, then fits dynamic segments to the model window in a deterministic order: compact forms first (summaries plus `read_artifact` references instead of full results), then truncation by priority. The work order is never dropped. If the stable prefix alone does not fit, the run fails with `ContextBudgetError` naming the heaviest segments, so the human can reduce tools, skills, or instructions.
- **Summaries.** Every completed order stores an extractive summary (no extra inference), used when full results do not fit and in reports and digests.
- **Threads.** A follow-up run (`previousRunId`) inherits the thread and receives a digest of up to three prior runs (objective, outcome summary, result reference), not their transcripts.
- **Memory.** Agents with read access to a `memory` store receive the top BM25 matches for their objective. Entry agents with write access record a run summary on completion.
- **Tool loops.** Before *every* model call the accumulated tool turns are refitted (`fitToolTail`): older results become `read_artifact("tool:<id>")` references, the newest are truncated, the oldest turns are dropped behind a note naming their references, and an unfittable call raises `ContextBudgetError` instead of overflowing the provider. Each result is also capped relative to the remaining budget; the full (connector-bounded) result stays in the tool-call ledger.
- **Resume.** Orders persist a `phase` (`plan`, `execute`, `integrate`, `done`) and, during tool loops, a durable checkpoint of assistant turns and tool results. Resuming continues from the checkpoint for the current phase and never re-issues recorded tool calls.
- **Artifact access.** `read_artifact` follows the information-flow policy in [ADR 010](architecture/010-artifact-information-flow.md); knowing an ID is not authorization.

## Relationship semantics

| Relationship | Runtime behaviour |
| --- | --- |
| **Delegate** | A child order with `ownerAgentId` = the sender's owner. The sender waits, then integrates. Revisions re-issue the order to the same agent and supersede the previous version. |
| **Consult** | Read-only, non-blocking advice. It can be planned up front or run inline through `consult_agent`. The requester stays the owner, and a failed consultation never fails the requester. |
| **Review** | A read-only order that depends on the work it evaluates and returns a schema-valid verdict (`approve`/`revise`/`reject` + findings). Invalid output is retried a bounded number of times, then the review is `indeterminate`: it never approves by default. Owners record `reviewOutcome` (`approved`, `revise_unresolved`, `rejected`, `indeterminate`); only `approved` finalizes a draft as reviewed. `revise` triggers bounded revisions (`maxRevisions` on the review edge). If the subject hands off, the review is retargeted to the successor's work. |
| **Handoff** | The source order becomes `handed_off`. A successor takes over the objective with a handoff packet (reason, progress, remaining work), becomes the owner, and inherits the parent and return path. Root handoffs move `rootOrderId`. Handing work back into its own chain is refused as a recoverable tool error. |
| **Report** | When an agent's order finishes, a status report is delivered to each `reports to` target's inbox. No inference runs; the target sees unread reports the next time it executes in that run. |

**Planning.** An agent with `autoDelegate` and collaborators plans once per order (depth < 2). The plan is JSON-schema constrained, validated against real edges, and capped by `maxDelegations`. Agents on the order's own responsibility chain are never candidates. When a model cannot produce a valid plan, the fallback ranks collaborators by lexical relevance and defaults to direct work, rather than invoking everyone. Each plan records selected and available collaborators, so skipped workers are visible.

## Scheduling and residency

The scheduler is deterministic software:

- **Run level.** Ready orders (all dependencies terminal) start by priority. A second order runs concurrently only if its model can accept a request now (a free slot, or it fits the budget after evicting idle models). Among equal priorities, orders whose model is already loaded go first. The cap is `AGENTIC_HARNESS_MAX_PARALLEL_ORDERS`.
- **Model level.** `ModelPool` enforces per-model `parallelSlots`, a RAM budget, and a VRAM budget (explicit, or 90% of the largest GPU reported by `nvidia-smi`). Residency is keyed per topology and model node and versioned by a configuration key: saving a changed model re-accounts it at once when idle (unloading the previously loaded llama-swap model) or after its in-flight requests drain; no request runs under stale accounting. An unknown VRAM estimate (`null`) on a GPU-capable model reserves the whole VRAM budget; `0` means CPU-only. It evicts the least recently used idle model. When nothing can be evicted, requests wait for capacity instead of failing. A model larger than the budget fails fast with guidance.
- **What is controlled.** Each model reports `residencyControl`: physical for llama-swap, logical only for externally managed servers (the harness tracks demand, not processes), simulated for the demo model. The runtime panel shows accounted usage next to OS and `nvidia-smi` observations.
- **Lifecycle.** For llama-swap, idle TTL triggers the unload API. For other servers, residency is logical.

On a baseline 8 GB VRAM machine this degrades to sequential execution with swaps; larger machines overlap independent work. The saved topology is the same on both.

## Connectors

`McpManager` pools one MCP client session per connector (stdio process or Streamable HTTP), keyed by the configuration fingerprint plus an in-memory HMAC of the credential value, so a changed endpoint, command, or rotated token never reuses a session. Sessions close after five idle minutes or when the transport closes.

Catalogs are cached in state by connector ID and fingerprint (for Configure estimates), but a worker only sees MCP tools from a catalog *verified in this process* for the current credential within `catalogTtlMs`; otherwise the catalog is re-listed and drift is recorded. Each tool definition has a SHA-256 hash; a call is refused if the verified definition differs from the one the worker was shown. Local `trustPolicies` pinned to those hashes decide read-only access and retry safety.

Untrusted payloads are bounded before parsing: a bounded stdio transport and bounded fetch cap each message (4 MB), catalogs are limited (512 tools, name pattern, 32 KB / depth 16 / 2,000 nodes per schema, 2 MB total; offending tools are rejected individually), result parts are capped, and results are truncated to `maxResultChars`.

## Storage

| Type | Adapter | Root |
| --- | --- | --- |
| `artifact-store` | filesystem | `<data dir>/storage/<location>` |
| `project-files`, `git` | filesystem (no commits) | absolute `location`, or `<workspace>/<location>` |
| `memory` | JSONL + BM25 | `<data dir>/memory/<location>` |
| `vector-store` | none yet (validation warning) | — |

The edge scope is a sub-path of the root. Scopes and paths are validated lexically on every platform (no drive letters, UNC/device paths, `..`, colons, control characters, reserved device names, or trailing dots/spaces). Below the canonicalized node root, every component is walked with `lstat`: symlinks and junctions are never followed, and each existing component's real path must equal its lexical path. Reads re-validate the opened handle's identity; writes use an exclusive temp file and re-validate the parent before rename. Writes are capped at 256 KB; reads are truncated at 64 KB. Run archives (`final.md`, `conversation.json`) go through the same adapter, into the entry agent's first writable file-backed storage.

## Persistence

`LocalStore` keeps one versioned JSON document and serializes mutations through a write chain. Each mutation is a transaction: the changed entity is copied, mutated, validated with its schema, the next document is persisted with an atomic rename, and only then is it published as live state. A validation error, a throwing callback, or a failed write leaves live state equal to durable state. New fields are additive with Zod defaults, so MVP state loads unchanged (covered by `tests/migration.test.ts`). The run list API returns summaries; clients fetch a run's full detail only when its `updatedAt` changes.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health and data directory |
| `GET` | `/api/topologies` | List topologies |
| `POST` | `/api/topologies/example` | Add a copy of the example topology |
| `GET`/`PUT` | `/api/topologies/:id` | Read or save a topology with validation issues |
| `GET` | `/api/topologies/:id/footprint` | Per-agent stable context estimates |
| `GET` | `/api/topologies/:id/llama-swap-config` | Generated llama-swap `config.yaml` |
| `POST` | `/api/topologies/:id/models/:modelId/test` | Test a model endpoint |
| `POST` | `/api/topologies/:id/connectors/:connectorId/discover` | Discover and cache MCP tools |
| `GET` | `/api/catalogs` | Cached connector catalogs |
| `POST` | `/api/models/inspect` | Read GGUF metadata and estimate memory |
| `GET` | `/api/runs?view=summary` | Run list (summaries) |
| `GET` | `/api/runs/:id` | Full run: orders, plans, frames, reports, artifacts |
| `POST` | `/api/runs` | Create a run (optionally `previousRunId`) |
| `POST` | `/api/runs/:id/pause`, `/resume` | Pause (returns after the run drains) or resume |
| `POST` | `/api/runs/:id/tool-calls/:operationId/reconcile` | Record whether an uncertain effect happened |
| `GET` | `/api/runtime` | Scheduler, models, hardware, budgets |

## Effects and recovery

Every tool call is recorded in a durable ledger before and after its effect, and each order's tool loop is checkpointed. After a crash or pause, calls classified `none` or `idempotent` are retried with the same operation ID (sent as `Idempotency-Key` or MCP `_meta`); `effectful` calls with an unknown outcome pause the run for human reconciliation. Pause is a quiescence barrier: no effect starts after it, in-flight requests are cancelled, and `quiescedAt` is recorded once nothing is in flight. See [ADR 009](architecture/009-effect-recovery-and-quiescence.md).

## Known limits

- Token counts before a request are estimates; server-reported usage is recorded alongside them.
- The state store is a single JSON document for a single process; very long histories should move to a database adapter.
- GPU telemetry is NVIDIA-only (`nvidia-smi`); other vendors report "unavailable".
- The `git` storage type reads and writes files but does not commit; `vector-store` has no adapter yet.
- A2A remains an in-process domain model; no cross-process A2A transport is exposed yet.
- The server binds to localhost and has no authentication. Do not expose it to a network.
