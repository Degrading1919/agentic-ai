# Task 002: Context-Efficient Capability Runtime

## Objective

Continue from the MVP toward the full product, applying harness-efficiency lessons: separate capability authorization from context exposure, make context observable and cache-friendly, make relationship semantics operational, and make MCP, storage, scheduling, hardware telemetry, and custom models practical.

## Delivered

- **Authorization vs. exposure.** Edge-derived tool descriptors; eager or deferred exposure with `find_tools`/`call_tool`; on-demand skills; read-only narrowing for consult and review (ADR 006).
- **Cache-aware prompts and observability.** Deterministic stable prefix shared by runtime and Configure; per-call context frames with segment tokens, prefix reuse, and server cache hits; per-agent footprints and canvas badges (ADR 007).
- **Context lifecycle.** Budget-aware packing with compact fallbacks, extractive summaries, `read_artifact`, thread digests, retrieved memory, inbox reports, and phase-based resume.
- **Relationship semantics.** Delegate, consult, review (with bounded revisions), handoff (ownership transfer), and report (zero-inference inbox), plus bounded, edge-validated planning (ADR 008).
- **MCP.** Official SDK client over stdio and Streamable HTTP; discovery, cached catalogs keyed by configuration fingerprint, allowlists, annotations.
- **Storage.** Filesystem adapters with scope and symlink-escape enforcement; BM25 memory; run archives written through the granted storage edge.
- **Scheduling.** Parallel slots, RAM/VRAM budgets, wait-for-capacity, affinity-aware overlapping of independent work orders.
- **Hardware and models.** nvidia-smi telemetry; GGUF inspection with KV-cache estimates; llama-swap config generation; artifact lineage on Model nodes.
- **Fixes.** Artifacts are written before a run is marked completed; a resume landing during pause unwinding is no longer dropped.

## Verification

`pnpm typecheck`, `pnpm test` (61 tests), `pnpm build`, and browser runs of the production build: legacy state migration, MCP discovery of a 154-tool stdio server from Configure, a deferred MCP run with delegation and review, thread follow-up with digest and memory, GPU telemetry, and the llama-swap dialog.

## Suggested next work

- Cross-process A2A transport mapping work orders to A2A tasks and artifacts.
- MCP resources/prompts and OAuth; embedding-backed vector storage; Git commit semantics.
- Exact token counts via backend tokenize endpoints; llama.cpp slot pinning per agent for cache affinity.
- Database-backed state store for long histories; topology import/export and undo.
- Evaluation harness for specialist models (task tests, external judges) tied to model artifact versions.
