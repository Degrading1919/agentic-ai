# ADR 009: Effect Recovery and Pause Quiescence

## Status

Accepted and implemented. Resolves audit findings A3 and B4.

## Context

Tool calls can change the world: HTTP POSTs, MCP tools, file writes, memory appends. The MVP ran the tool loop in memory. After a crash or pause the whole phase was replayed, so an effect that had already happened could happen again. Pause aborted the model request, but a tool effect could still be dispatched afterwards.

## Decision

1. **Ledger.** Every tool call gets a durable record with an operation ID and an *effect class*. The status is persisted before the effect (`started`) and after it (`succeeded`/`failed`).
2. **Checkpoint.** Each order's tool loop (assistant tool-call turns and tool results) is stored on the work order. Resuming continues from the checkpoint; recorded results are never re-issued.
3. **Effect classes are decided locally**, never by the model:
   - `none`: calculator, reads, GET, locally trusted read-only MCP tools.
   - `idempotent`: storage writes (whole-file replace), memory appends keyed by operation ID, HTTP PUT/DELETE, HTTP POST/PATCH when the connector declares that the server honours `Idempotency-Key`, and MCP tools locally marked retry-safe.
   - `effectful`: everything else, including every unreviewed MCP tool.
4. **Recovery.** A call found `started` after a crash or pause is retried with the same operation ID if it is `none` or `idempotent`. Otherwise it becomes `indeterminate`, its order `awaiting_reconciliation`, and the run pauses. A human records `applied` (with a note returned to the worker as the tool result) or `not applied` (the worker is told the effect did not happen and decides whether to call again).
5. **Pause is a barrier.** Dispatch checks the abort signal before every effect. Pause cancels in-flight provider, MCP and HTTP requests, waits for the run's worker to drain, and records `quiescedAt`. Resume is refused while any call is `indeterminate`.

## Consequences

- The runtime is honest: idempotent effects are at-least-once under a stable key, effectful ones are at-most-once automatically, and unknown outcomes are surfaced rather than guessed. Exactly-once is not claimed.
- The operation ID is sent as `Idempotency-Key` (HTTP) and in MCP `_meta`, so servers that support deduplication can provide stronger guarantees.
- Checkpoints make long tool loops resumable after restarts and topology edits, at the cost of a larger state document. The checkpoint is cleared when the order completes.
- A non-cancellable effect can delay quiescence; the UI shows "pausing…" until the worker exits.
