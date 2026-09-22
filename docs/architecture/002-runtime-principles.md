# ADR 002: Runtime Principles

## Status

Accepted concept decision; implementation deferred.

## Scheduler

The scheduler is deterministic software, not an LLM agent.

Responsibilities will include:

- model load requests,
- model unload requests,
- residency state,
- CPU/RAM/VRAM awareness,
- execution queues,
- concurrency limits,
- idle eviction,
- process health,
- pause/resume coordination.

## Expected residency states

- Unloaded
- Loading
- Resident
- Executing
- Idle
- Unloading
- Failed

## Low-memory behavior

A baseline 8 GB VRAM machine may execute approximately:

Orchestrator -> checkpoint/unload -> Specialist -> persist result/unload -> Orchestrator reload

A larger machine may keep compatible models resident concurrently.

The saved topology must not depend on one specific hardware configuration.
