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

Descriptors are sorted by node ID and tool name, so edge insertion order never changes the prompt. `read-only` access (consult and review orders) removes write tools, non-GET HTTP methods, and MCP tools the server does not mark `readOnlyHint`.

`planToolExposure` then chooses:

- **eager**: every schema is sent natively (small tool sets; `auto` uses at most `eagerToolLimit` tools and ≈1,200 schema tokens);
- **deferred**: the prefix carries a compact catalog (one line per tool, or grouped counts above 40 tools) plus two stable harness tools, `find_tools` and `call_tool`.

Deferred loading never changes the `tools` payload. `find_tools` returns schemas as a tool result in the dynamic tail, and `call_tool` dispatches by name. The request prefix stays byte-identical as tools are discovered, which matters because many chat templates, llama.cpp's included, render tool schemas into the prompt prefix. A `call_tool` for a tool whose schema has not been loaded returns the schema instead of executing, so the model must see a schema before using it.

Other harness tools appear only when the topology makes them meaningful: `load_skill` (on-demand skills), `consult_agent` (consult edges), `handoff_work` (handoff edges), and `read_artifact` (fetch a full result that the context carried only as a summary).

## Cache-aware prompt construction

Every request has two parts:

1. **Stable prefix** (system message + tools): harness rules, worker instructions, always-on skills, the on-demand skill catalog, collaborators with relationship semantics, connected resources, the deferred tool catalog, and tool schemas. `buildStablePrefix` accepts only topology-derived inputs. It never sees objectives, run IDs, timestamps, or results, so plan, execute, integrate, and tool-loop calls from one agent share an identical prefix.
2. **Dynamic payload** (user message): the work-order envelope, thread digest, retrieved memory, inbox reports, dependencies (specialist outputs, advice, verdicts, revision requests), and the growing tool loop.

Each request records a **context frame**: token estimates per segment (stable or dynamic, trimmed or not), prefix and tools hashes, whether the prefix matched the previous request to the same model, exposure mode, authorized versus exposed schemas, and server-reported prompt tokens and cache hits (`usage.prompt_tokens_details.cached_tokens`, or llama.cpp `timings.cache_n`). Frames store sizes, never prompt text.

The Configure view uses the same `buildStablePrefix` through `estimateAgentFootprint`, so the canvas badge and inspector bar match what the runtime sends.

## Context lifecycle

- **Packing.** `packContext` reserves the agent's output budget, then fits dynamic segments to the model window in a deterministic order: compact forms first (summaries plus `read_artifact` references instead of full results), then truncation by priority. The work order is never dropped. If the stable prefix alone does not fit, the run fails with `ContextBudgetError` naming the heaviest segments, so the human can reduce tools, skills, or instructions.
- **Summaries.** Every completed order stores an extractive summary (no extra inference), used when full results do not fit and in reports and digests.
- **Threads.** A follow-up run (`previousRunId`) inherits the thread and receives a digest of up to three prior runs (objective, outcome summary, result reference), not their transcripts.
- **Memory.** Agents with read access to a `memory` store receive the top BM25 matches for their objective. Entry agents with write access record a run summary on completion.
- **Resume.** Orders persist a `phase` (`plan`, `execute`, `integrate`, `done`). Resuming rebuilds the smallest context for the current phase from structured state; it never replays message logs.

## Relationship semantics

| Relationship | Runtime behaviour |
| --- | --- |
| **Delegate** | A child order with `ownerAgentId` = the sender's owner. The sender waits, then integrates. Revisions re-issue the order to the same agent and supersede the previous version. |
| **Consult** | Read-only, non-blocking advice. It can be planned up front or run inline through `consult_agent`. The requester stays the owner, and a failed consultation never fails the requester. |
| **Review** | A read-only order that depends on the work it evaluates and returns a structured verdict (`approve`/`revise`/`reject` + findings). `revise` triggers bounded revisions (`maxRevisions` on the review edge). A reviewed direct draft that is approved is finalized without another model call. |
| **Handoff** | The source order becomes `handed_off`. A successor takes over the objective with a handoff packet (reason, progress, remaining work), becomes the owner, and inherits the parent and return path. Root handoffs move `rootOrderId`. Handing work back into its own chain is refused as a recoverable tool error. |
| **Report** | When an agent's order finishes, a status report is delivered to each `reports to` target's inbox. No inference runs; the target sees unread reports the next time it executes in that run. |

**Planning.** An agent with `autoDelegate` and collaborators plans once per order (depth < 2). The plan is JSON-schema constrained, validated against real edges, and capped by `maxDelegations`. Agents on the order's own responsibility chain are never candidates. When a model cannot produce a valid plan, the fallback ranks collaborators by lexical relevance and defaults to direct work, rather than invoking everyone. Each plan records selected and available collaborators, so skipped workers are visible.

## Scheduling and residency

The scheduler is deterministic software:

- **Run level.** Ready orders (all dependencies terminal) start by priority. A second order runs concurrently only if its model can accept a request now (a free slot, or it fits the budget after evicting idle models). Among equal priorities, orders whose model is already loaded go first. The cap is `AGENTIC_HARNESS_MAX_PARALLEL_ORDERS`.
- **Model level.** `ModelPool` enforces per-model `parallelSlots`, a RAM budget, and a VRAM budget (explicit, or 90% of the largest GPU reported by `nvidia-smi`). It evicts the least recently used idle model. When nothing can be evicted, requests wait for capacity instead of failing. A model larger than the budget fails fast with guidance.
- **Lifecycle.** For llama-swap, idle TTL triggers the unload API. For other servers, residency is logical.

On a baseline 8 GB VRAM machine this degrades to sequential execution with swaps; larger machines overlap independent work. The saved topology is the same on both.

## Connectors

`McpManager` pools one MCP client session per connector (stdio process or Streamable HTTP), re-creates it when the configuration fingerprint changes, and closes it after five idle minutes. Catalogs are cached in state by connector ID and fingerprint, so estimates and runs work without a live connection. They are discovered lazily before an agent needs them, or explicitly from Configure. Tool results are truncated to the connector's `maxResultChars`.

## Storage

| Type | Adapter | Root |
| --- | --- | --- |
| `artifact-store` | filesystem | `<data dir>/storage/<location>` |
| `project-files`, `git` | filesystem (no commits) | absolute `location`, or `<workspace>/<location>` |
| `memory` | JSONL + BM25 | `<data dir>/memory/<location>` |
| `vector-store` | none yet (validation warning) | — |

The edge scope is a sub-path of the root. Paths must be relative. Traversal and symlink or junction escapes are rejected after resolving real paths. Writes are atomic and capped at 256 KB; reads are truncated at 64 KB. Run archives (`final.md`, `conversation.json`) go through the same adapter, into the entry agent's first writable file-backed storage.

## Persistence

`LocalStore` keeps one versioned JSON document and serializes mutations through a write chain with atomic rename. New fields are additive with Zod defaults, so MVP state loads unchanged (covered by `tests/migration.test.ts`). The run list API returns summaries; clients fetch a run's full detail only when its `updatedAt` changes.

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
| `POST` | `/api/runs/:id/pause`, `/resume` | Pause or resume |
| `GET` | `/api/runtime` | Scheduler, models, hardware, budgets |

## Known limits

- Token counts before a request are estimates; server-reported usage is recorded alongside them.
- The state store is a single JSON document for a single process; very long histories should move to a database adapter.
- GPU telemetry is NVIDIA-only (`nvidia-smi`); other vendors report "unavailable".
- The `git` storage type reads and writes files but does not commit; `vector-store` has no adapter yet.
- A2A remains an in-process domain model; no cross-process A2A transport is exposed yet.
- The server binds to localhost and has no authentication. Do not expose it to a network.
