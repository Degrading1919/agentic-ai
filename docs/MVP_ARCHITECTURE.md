# MVP Architecture

> Historical. This describes the first MVP. The current design, including capability exposure, context lifecycle, and relationship semantics, is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Boundary model

Topology nodes are discriminated typed objects. Edges are directional grants whose source is always an Agent:

| Edge | Legal target | Runtime meaning |
| --- | --- | --- |
| `agent_uses_model` | Model | The only model the agent may invoke |
| `agent_can_use_capability` | Capability | Callable tools exposed to the agent |
| `agent_can_use_skill` | Skill | Instructions injected into worker context |
| `agent_can_use_connector` | Connector | Declared integration availability |
| `agent_can_access_storage` | Storage | Explicit read/write/scope grant |
| `agent_can_*_to_agent` | Agent | Legal structured collaboration relationship |

Every execution context is reconstructed from the saved topology. Work orders carry an allowed-resource snapshot for observability, but the runtime checks the current graph again immediately before execution.

## Run lifecycle

1. Work creates a root work order for an entry agent.
2. The topology guard verifies the agent, its single model edge, and the whole topology.
3. A lead agent with connected collaborators receives a bounded candidate list and returns a structured delegation plan.
4. Requested collaborator IDs are filtered against the actual edges. Invalid output falls back to a deterministic connected-only plan.
5. Child work orders execute through their own model, skill, capability, connector, and storage context.
6. The root work order resumes after children reach a terminal state and synthesizes their results.
7. State is checkpointed throughout. A writable connected storage edge enables final and conversation artifacts.

Child workers do not recursively delegate in this MVP. This prevents accidental cycles while the topology remains free to represent cyclic collaboration relationships.

## Pause and resume

Pause sets durable run state before aborting an in-flight provider request. The executing work order returns to `queued`; completed work orders remain `completed`.

Resume does not replay completed orders. It reloads the topology before the next order, so instruction changes take effect. A queued order whose collaboration edge was removed becomes `blocked` and emits a topology-boundary event.

## Model lifecycle

The model pool exposes these states:

```text
unloaded → loading → resident → executing → idle → unloading → unloaded
                                      └──────────────→ failed
```

Residency estimates are deterministic configuration, not LLM judgment. Before loading, the pool evicts least-recently-used idle models until the estimate fits the configured budget. Idle TTL is per Model node.

For llama-swap, loading occurs physically on the first proxied request and unloading uses its API. For other OpenAI-compatible servers, the states express harness demand while the external process owns physical residency.

## Persistence

`LocalStore` keeps one versioned JSON document and serializes mutations through a write chain. Each write goes to `state.json.next` and is atomically renamed. Startup validates the entire document with Zod and refuses to overwrite malformed state.

Run state is always durable because pause/resume and crash recovery require it. Conversation archival is separate: `conversationPersistence = connected-storage` plus a writable storage edge writes the portable archive.

## Provider and tool boundary

`providers.ts` contains inference transport. `tools.ts` contains trusted local capability implementations. The model receives function definitions only for connected, enabled Capability nodes. The executor checks the topology-derived capability list again before every call.

The calculator uses a small recursive-descent parser and never evaluates JavaScript.

## Runtime observability

The runtime API reports:

- active and queued run IDs;
- model residency, active run, request counts, memory estimates, and last errors;
- CPU load, system/process RAM, and configured memory budget;
- persisted run events, structured work orders, model and tool call counts, token usage, and elapsed time.

GPU data is reported as unavailable instead of fabricating a value. A future hardware adapter can add vendor-specific telemetry without changing scheduling contracts.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Local service health and data directory |
| `GET` | `/api/topologies` | List saved topology documents |
| `GET` | `/api/topologies/:id` | Read topology and validation issues |
| `PUT` | `/api/topologies/:id` | Validate schema and save a topology draft |
| `POST` | `/api/topologies/:id/models/:modelId/test` | Test model discovery |
| `GET` | `/api/runs` | List persisted runs |
| `GET` | `/api/runs/:id` | Read one complete run snapshot |
| `POST` | `/api/runs` | Create a run |
| `POST` | `/api/runs/:id/pause` | Preserve and pause remaining work |
| `POST` | `/api/runs/:id/resume` | Resume from the checkpoint |
| `GET` | `/api/runtime` | Scheduler, model, and hardware snapshot |

## Deliberate MVP limits

- Connector nodes are modeled and enforced as boundaries, but MCP discovery and invocation are not yet implemented.
- Work orders are compatible with an eventual A2A mapping but currently remain in-process persisted domain objects.
- The local store is single-process; multi-process writers need a database adapter.
- GPU metrics and process-level model health need backend-specific adapters.
- Tool execution includes only the safe calculator example; arbitrary shell execution is intentionally absent.
- Topology templates, import/export, undo history, and multiple saved topologies are natural UI extensions.
