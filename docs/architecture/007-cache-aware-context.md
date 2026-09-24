# ADR 007: Cache-Aware Prompts and Observable Context

## Status

Accepted and implemented.

## Context

Model context is a resource like RAM or VRAM. Backends such as llama.cpp reuse KV cache for a repeated prompt prefix, but only when the prefix is byte-identical. Unstable ordering, timestamps, or dynamic data placed early in the prompt defeat that reuse. Users also cannot optimize a topology they cannot measure.

## Decision

- Split every request into a **stable prefix** built only from topology-derived inputs (sorted by ID) and a **dynamic payload** built from the work order and run state. The same builder feeds the Configure footprint estimate, so what the UI shows is what the runtime sends.
- Record a **context frame** for every model call: estimated tokens per segment, stable-prefix size, prefix/tools hashes, prefix reuse against the previous call to the same model, exposure details, and server-reported prompt and cached tokens.
- Fit dynamic content to the model window deterministically, preferring compact summaries plus `read_artifact` references over truncation. Fail with a descriptive error when the stable prefix alone cannot fit.
- Replace transcript replay with structured state: phases on work orders, extractive summaries, thread digests, retrieved memory, and inbox reports.

## Consequences

- Plan, execute, integrate, and tool-loop calls from one agent share a system prefix. The tools payload differs only between schema-constrained calls (planning, review) and tool-enabled calls.
- Token counts before a request are estimates from a tokenizer-free heuristic; provider-reported usage is shown alongside when available.
- Context frames are bounded per run (400) and store no prompt text.
