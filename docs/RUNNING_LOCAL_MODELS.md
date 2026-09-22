# Running Local Models

Agentic Harness treats model artifacts and agents as separate concepts. One Model node may serve several agents, and an agent can switch model versions without changing its collaboration or resource edges.

## OpenAI-compatible contract

The MVP provider calls:

- `GET <base-url>/models` for connection testing
- `POST <base-url>/chat/completions` for planning and worker execution

The request may include `tools` and `response_format.type = json_schema`. If a server rejects schema-constrained output with HTTP 400, 404, or 422, the planner retries without that field and validates or falls back locally.

The base URL should include `/v1`, for example `http://127.0.0.1:8080/v1`.

## llama.cpp

A minimal local launch looks like:

```bash
llama-server \
  -m /absolute/path/to/model.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --alias specialist
```

Useful llama.cpp controls for consumer hardware include:

- `--ctx-size` for context allocation
- `--n-gpu-layers` for GPU offload
- `--parallel` for server slots
- `--flash-attn` where supported
- KV-cache type options for memory tradeoffs

Choose values for the actual model and machine. A topology's estimated memory is an admission and eviction hint; it does not configure llama.cpp itself.

Configure the node with Model ID `specialist`, Base URL `http://127.0.0.1:8080/v1`, and logical lifecycle.

## llama-swap

llama-swap routes a model ID to a configured local server command, loads on demand, and can unload by TTL. Point the Model node to llama-swap's `/v1` endpoint and choose the `llama-swap` lifecycle option.

Agentic Harness will:

1. mark the scheduler intent as loading and resident;
2. send the first chat request, which causes llama-swap to load the model;
3. track executing and idle states;
4. call `POST /api/models/unload/<model-id>` after the node's idle TTL.

The llama-swap server remains the authority on physical process state. Its `/running`, `/logs`, `/metrics`, and UI remain useful for lower-level inspection.

## API keys

If the endpoint requires a bearer token, put the token in an environment variable before starting Agentic Harness. Store only that variable's name in **API key environment variable** on the Model node.

PowerShell example:

```powershell
$env:LOCAL_MODEL_API_KEY = "replace-me"
pnpm start
```

The runtime reads the value per request and does not persist it.

## Memory budgeting

The deterministic model pool uses each Model node's estimated memory to decide whether another model can become resident. It evicts the least-recently-used idle model when needed. If one model exceeds the whole budget, the run fails with an actionable error rather than overcommitting silently.

Set an explicit budget when system RAM is not a useful proxy for the inference device:

```powershell
$env:AGENTIC_HARNESS_MEMORY_BUDGET_MB = "7168"
pnpm start
```

For an externally managed server, idle eviction is logical. For llama-swap, it also triggers a physical unload request.

## Troubleshooting

### Test says the endpoint is healthy but the model is not listed

Confirm the node's Model ID matches the ID returned by `/v1/models`. Some servers still accept an alias that they omit from the list, so the UI reports this as a warning rather than treating the endpoint as offline.

### Planning works but tool calls do not

Confirm the model and chat template support tool calling and that the Capability node is connected to the executing agent. The runtime never exposes a disconnected tool, even if another agent can use it.

### A run pauses during a request

Pause aborts the in-flight HTTP request and returns that work order to queued state. Resume retries the incomplete order using the currently saved topology. Already completed work is not repeated.

### Schema output is unreliable on a small model

The runtime validates requested collaborator IDs against connected edges. Invalid or unparsable plans fall back to a deterministic plan containing only connected collaborators.
