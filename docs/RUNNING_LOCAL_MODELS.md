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

## Custom model artifacts

Each Model node has an **artifact** section for fine-tuned specialists: GGUF path, architecture, base model / lineage, parameter label, quantization, version, GPU layers, and LoRA adapters with scales.

**Inspect GGUF** reads the file's metadata header without loading weights (large arrays such as the tokenizer vocabulary are streamed past). It fills architecture, parameter label, quantization, trained context length, and base model, and it estimates resident memory as:

```text
weights (file size) + f16 KV cache for the node's context window + ~256 MB overhead
KV cache = 2 × layers × context × kv_heads × head_dim × 2 bytes
```

Grouped-query attention (`head_count_kv`) is taken into account. The inspection uses the node's GPU layers and parallel slots: offloaded layers' weights and KV cache count as VRAM (plus a compute buffer), the rest as host RAM. GPU layers `-1` (server default) is treated as full offload, the conservative assumption for VRAM. The KV cache covers window × parallel slots. Both **Est. RAM MB** and **Est. VRAM MB** are filled, and the assumptions are shown.

Leave **Est. VRAM MB** empty when you do not know it: the scheduler then reserves the whole VRAM budget for that model rather than assuming it needs none. Enter `0` only for CPU-only models.

## Generate a llama-swap config

With Model nodes set to **llama-swap managed** and an artifact path, the **llama-swap** button in Configure produces a `config.yaml`:

```yaml
models:
  runtime-coder:
    cmd: |
      llama-server --port ${PORT} -m /models/runtime-coder.Q4_K_M.gguf -c 16384 --parallel 2 --alias runtime-coder -ngl 99 --lora-scaled /models/style.lora.gguf 0.5
    ttl: 120
```

The command uses the node's context window, parallel slots, alias, GPU layers, and adapters; `ttl` comes from the idle TTL. Because llama-server divides `-c` among `--parallel` slots, `-c` is the window multiplied by the slot count so that every slot gets the node's full window. Start llama-swap with it and point the Model nodes at llama-swap's `/v1` URL.

## Parallel slots and concurrency

Set **Parallel slots** to match llama.cpp's `--parallel`. Saving a changed model re-accounts its residency immediately when it is idle (for llama-swap, the previously loaded model is unloaded), or as soon as its in-flight requests finish. The scheduler sends up to that many concurrent requests to one model and queues the rest. Independent work orders that use different models run concurrently only when both fit the RAM and VRAM budgets; otherwise they run one after another with idle models evicted in between. `AGENTIC_HARNESS_MAX_PARALLEL_ORDERS` caps overlap per run.

## Prompt caching

Requests keep a byte-stable prefix per agent (see `docs/ARCHITECTURE.md`), so llama.cpp's prompt cache (`cache_prompt`, on by default) can reuse it across an agent's calls. When the server reports `timings.cache_n` or `usage.prompt_tokens_details.cached_tokens`, Work shows cached tokens per call and a run-level cache hit rate. Running one agent per model slot improves reuse further.

## API keys

If the endpoint requires a bearer token, put the token in an environment variable before starting Agentic Harness. Store only that variable's name in **API key environment variable** on the Model node.

PowerShell example:

```powershell
$env:LOCAL_MODEL_API_KEY = "replace-me"
pnpm start
```

The runtime reads the value per request and does not persist it.

## Memory budgeting

The deterministic model pool uses each Model node's estimated RAM and VRAM to decide whether another model can become resident. It evicts the least-recently-used idle model when needed. When nothing can be evicted because other models are busy, the request waits for capacity. If one model exceeds a whole budget, the run fails with an actionable error rather than overcommitting silently.

The RAM budget defaults to 50% of system memory. The VRAM budget defaults to 90% of the largest GPU reported by `nvidia-smi`, and is not enforced when no GPU telemetry is available. Override either:

```powershell
$env:AGENTIC_HARNESS_MEMORY_BUDGET_MB = "12288"
$env:AGENTIC_HARNESS_VRAM_BUDGET_MB = "7168"
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

The runtime validates requested collaborator IDs and relationships against connected edges. An unparsable plan falls back to a deterministic plan that picks only collaborators whose role matches the objective, or none. An unparsable review verdict is inferred from its text.

### A run fails with "needs ≈N tokens of stable context"

The agent's configuration alone does not fit the model window. The message names the heaviest segments. Switch the agent to deferred tool exposure, move rarely used skills to on-demand, trim instructions, or use a model with a larger context.
