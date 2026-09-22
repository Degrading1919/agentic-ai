# Agentic Harness

Agentic Harness is a local-first visual orchestration IDE for teams of specialized AI workers. It pairs a focused chat-style **Work** view with a node-based **Configure** editor.

The graph is a **capability topology, not a workflow DAG**. An edge grants access to a model, tool, skill, connector, storage target, or another agent. Canvas position never grants permission and never defines execution order.

## What works in the MVP

- Visual topology editing with React Flow
- Models, agents, capabilities, skills, MCP/API connectors, and storage nodes
- Typed agent relationships: delegate, consult, review, report, and handoff
- Structural validation and hard runtime boundary checks
- Separate model artifacts and agent configurations
- OpenAI-compatible local inference for llama.cpp, llama-swap, Ollama-compatible endpoints, and similar servers
- A deterministic built-in provider for trying the entire product without downloading a model
- Structured, persisted work orders for lead-to-specialist execution
- Connected tool calling with a safe calculator example
- Durable run state, final artifacts, and optional conversation archives
- Pause/resume with completed work preserved and current topology applied on resume
- Deterministic model residency states, memory budgeting, idle eviction, and llama-swap unload calls
- Live CPU/RAM, queue, model state, token, timing, and tool-call telemetry
- Recovery of queued work after a local runtime restart

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

The first start creates a runnable **Local product studio** topology. Its built-in demo model is deterministic and offline, so the full lead → builder/reviewer → synthesis loop works immediately.

## Use the product

### Configure

1. Add nodes from the library.
2. Draw **from an agent** to another node to grant access.
3. Select an agent-to-agent edge to choose delegate, consult, review, report, or handoff.
4. Select a storage edge to set read, write, and scope permissions.
5. Select nodes to edit worker instructions, model endpoints, persistence behavior, and resource settings.
6. Save the topology. Invalid drafts may be saved, but Work refuses to run them until blocking issues are fixed.

Each MVP agent must have exactly one model edge. At least one agent must be marked **Available in Work**.

### Work

1. Choose an entry agent in the composer.
2. Submit a task.
3. Inspect the structured work orders and live runtime panel.
4. Pause an active run before changing execution boundaries or worker instructions.
5. Save the updated topology and resume. Completed orders remain intact; remaining work is checked against the current topology.

When an entry agent has write access to storage and conversation persistence is enabled, the runtime writes `final.md` and `conversation.json` for the run.

## Connect llama.cpp

Start an OpenAI-compatible llama.cpp server. A typical command is:

```bash
llama-server -m /absolute/path/to/model.gguf --host 127.0.0.1 --port 8080 --alias specialist
```

In Configure, select a Model node and use:

- Provider: `OpenAI compatible`
- Model ID: `specialist`
- Base URL: `http://127.0.0.1:8080/v1`
- Lifecycle: `Externally managed / logical`

Save, then use **Test connection**. Connect the model node to any agent that should be allowed to use it.

llama.cpp currently exposes OpenAI-compatible chat completions, schema-constrained JSON, function calling, parallel slots, and continuous batching. Agentic Harness uses chat completions, optional JSON schema output for delegation planning, tool calls, and usage data when the server returns it.

## Connect llama-swap

Point the Model node at llama-swap's OpenAI-compatible `/v1` base URL and set:

- Model ID to the configured llama-swap model name
- Lifecycle to `llama-swap managed`
- Estimated memory and idle TTL to values appropriate for the artifact

llama-swap performs physical on-demand loading when the request arrives. Agentic Harness exposes the scheduler's logical state and calls llama-swap's model unload endpoint after the configured idle TTL.

See [Running local models](docs/RUNNING_LOCAL_MODELS.md) for configuration details and troubleshooting.

## Local data and environment

By default, state is stored in `.agentic-harness/` under the directory where the server starts:

```text
.agentic-harness/
├── state.json
└── artifacts/
    └── <run-id>/
        ├── final.md
        └── conversation.json
```

Writes use a temporary file followed by an atomic rename.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTIC_HARNESS_HOST` | `127.0.0.1` | API/static server bind address |
| `AGENTIC_HARNESS_PORT` | `8787` | API/static server port |
| `AGENTIC_HARNESS_DATA_DIR` | `./.agentic-harness` | Durable state directory |
| `AGENTIC_HARNESS_MEMORY_BUDGET_MB` | 50% of system RAM | Advisory model residency budget |
| `AGENTIC_HARNESS_MAX_CONCURRENT_RUNS` | `1` | Concurrent run limit, capped at 8 |
| `AGENTIC_HARNESS_LOG_LEVEL` | `info` | Fastify log level |

Model API keys are referenced by environment-variable name in the topology. Secret values are never written into topology state.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The test suite covers topology validity, model assignment, hard capability boundaries, safe arithmetic, an end-to-end structured delegation run, durable artifacts, and pause/resume recovery.

## Architecture

The runtime is deliberately split into deterministic control software and model-driven worker execution:

```text
React Work / Configure UI
           │
           ▼
      Local Fastify API
           │
    ┌──────┴─────────┐
    ▼                ▼
Topology guard   Durable store
    │                │
    ▼                ▼
Work-order runtime ─ artifacts
    │
    ├── deterministic queue + pause/resume
    ├── model residency pool + memory budget
    ├── topology-bounded tool registry
    └── mock or OpenAI-compatible provider
```

The scheduler—not an LLM—owns queueing, legality checks, model state, and recovery. Models plan and execute only inside the exact context derived from their connected edges.

See [MVP architecture](docs/MVP_ARCHITECTURE.md) and the accepted decisions in [`docs/architecture`](docs/architecture).

## Current extension points

- Add inference providers behind `src/server/providers.ts`.
- Register built-in capabilities in `src/server/tools.ts`; definitions are exposed only when the capability node is connected.
- Extend node schemas in `src/shared/contracts.ts` and legal edge rules in `src/shared/topology.ts`.
- Add physical storage adapters behind the existing storage edge permission model.
- Implement MCP discovery/invocation without changing the topology boundary contract.
- Map internal work orders to an A2A transport when cross-process agents are introduced.

The MVP intentionally does not autonomously alter topology, execute arbitrary code, manage model downloads, provide a full MCP client, or claim GPU telemetry when the host cannot supply it.

## Upstream work

The implementation uses React Flow directly and follows integration patterns studied in Langflow, llama.cpp, llama-swap, Open WebUI, MCP, and A2A. No source code from those studied projects is vendored. See [Third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT. See [LICENSE](LICENSE).
