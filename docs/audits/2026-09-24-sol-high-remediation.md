# Remediation of the 2026-09-24 Sol High runtime audit

Audit: [`2026-09-24-sol-high-runtime-architecture-audit.md`](2026-09-24-sol-high-runtime-architecture-audit.md) (baseline `8152d98`).

Remediation branch: `fix/sol-audit-remediation`.

## Verification of the audit's claims

Before changing anything, the audit's probes were reproduced on the baseline (Windows 11, Node 25):

| Claim | Reproduced |
| --- | --- |
| A1: junction scope reads and writes outside the node root | Yes: read returned `OUTSIDE SECRET`, write created an outside file |
| A1: scope `C:/Windows` reads `win.ini` | Yes |
| A4: `parseVerdict("I could not inspect the files.")` approves | Yes |
| A6: resident model keeps a 512 MB estimate after reconfiguration to 900 MB | Yes |
| B3: rejected `saveTopology` leaves the invalid topology in live state | Yes |

The same probe also established that Node reports Windows directory junctions as symbolic links through `lstat`, which the A1 fix relies on.

## Findings

Each finding is marked **resolved**. Every one has regression tests that failed on the baseline behavior and pass now.

### A1 — Storage scope escape — resolved

**Cause.** The scope was joined to the root without validation, and link checks compared against the real scope, not the node root.

**Change** (`src/server/storage.ts`):
- **Lexical validation on every platform, for scopes and paths.** Rejects:
  - drive-qualified paths;
  - UNC and device paths (`\\?\`, `\\.\`, `//server`);
  - `..`;
  - colons (drive letters and NTFS alternate data streams);
  - control and wildcard characters;
  - reserved device names;
  - trailing dots or spaces.
- **No links below the root.** Below the canonicalized node root, every component is walked with `lstat`, and symlinks and junctions are never followed. Each existing component's real path must equal its lexical path, which also catches mount points and other reparse points.
- **Reads** re-validate after opening and compare inode and device between the handle and the path.
- **Writes** create an exclusive temp file (`wx`), re-validate the parent chain, then rename.

**Evidence** (`tests/storage.test.ts`):
- hostile scopes (11 cases) are rejected for read, list and write;
- hostile paths (7 cases) are rejected;
- a scope that *is* a junction;
- nested junctions in read and write-parent positions;
- a link at the write destination;
- a trusted root that is itself a link.

These use real directory junctions on Windows and never skip.

**Residual risk.** Node has no `openat`/`O_NOFOLLOW` equivalent on Windows. A concurrent local process with write access to the storage root could still swap a directory for a junction between the final re-validation and the syscall. Agents cannot create links through any harness tool, so this requires an actor outside the threat model the audit states.

### A2 — `read_artifact` visibility — resolved

**Cause.** The resolver had no caller and no policy.

**Change.** A new pure policy module (`src/server/artifact-policy.ts`, documented in ADR 010) gives an order access only to:
- itself;
- its revision chain;
- its handoff predecessors;
- its dependencies and review subjects, resolved through handoffs;
- its terminal children;
- reviews of its work;
- its own tool results (`tool:<operation id>`);
- for the root chain only, the prior-run roots listed in its thread digest.

Unfinished output is never readable, except a draft that is the declared subject of a review. Denials are recorded as `topology_boundary` events.

**Evidence** (`tests/artifact-policy.test.ts`):
- denied: sibling reads with known IDs, child-to-parent reads, reads of a running order, reads of other orders' tool results, non-root thread access;
- allowed: reviewer→subject (including through a handoff), revision→previous version and review;
- a live follow-up run where a prior run's internal order is denied and its root is allowed.

### A3 — Replay of external effects — resolved

**Cause.** The tool loop lived in a local array; restart re-ran the whole phase.

**Change** (`src/server/runtime.ts`, ADR 009):
- **Durable ledger.** Each call has a ledger row carrying an operation ID and an effect class. The row is written `planned`, then `started`, then `succeeded`/`failed` around the effect.
- **Checkpoint.** Each order's tool loop is checkpointed durably, so resuming continues from the checkpoint and recorded results are never re-issued.
- **Classification on recovery.** Calls interrupted mid-effect are classified:
  - `none` and `idempotent` calls retry with the same operation ID. That ID is sent as the HTTP `Idempotency-Key`, the MCP `_meta` operation ID, or the memory entry ID.
  - `effectful` calls become `indeterminate`, and the run pauses for human reconciliation (`applied`, or `not applied` with a note shown to the worker).
- **Effect class is locally decided.**
  - Storage writes are whole-file replaces, so `idempotent`.
  - Memory appends are keyed by operation ID, so `idempotent`.
  - HTTP: GET is `none`; PUT and DELETE are `idempotent`; POST and PATCH are `idempotent` only when the connector declares that the server honours `Idempotency-Key`.
  - MCP tools are `effectful` unless locally trusted.

**Evidence** (`tests/effects.test.ts`). These use crash images: the durable state copied at the instant the effect reached a real HTTP service, then loaded by a fresh engine.
- non-idempotent POST: no replay, reconciliation required, both reconcile outcomes;
- idempotent POST: retried once with the same key;
- a checkpointed GET is not re-issued;
- an interrupted read is retried without reconciliation.

**Semantics stated honestly.** Idempotent tools are at-least-once with a stable key. Effectful tools are at-most-once automatically, with human reconciliation for unknown outcomes. Exactly-once is not claimed.

### A4 — Review failing open — resolved

**Change.**
- `parseVerdict` accepts only schema-valid JSON (fenced JSON allowed), and never the reserved `indeterminate`.
- Reviews retry up to `REVIEW_MAX_ATTEMPTS`, then fail with verdict `indeterminate`.
- Owners record a `reviewOutcome` of `approved`, `revise_unresolved`, `rejected` or `indeterminate`.
- A missing, failed or blocked review is `indeterminate`: the result is labelled "has not been independently reviewed", and integration prompts say so.
- A plan that required review whose edge was removed also produces `indeterminate`.

**Evidence** (`tests/review.test.ts`):
- strict parsing cases;
- a prose reviewer in direct work: bounded attempts, indeterminate outcome, labelled result;
- a prose reviewer of delegated work;
- a normal approval remains `approved`.

### A5 — MCP identity, freshness, and read-only trust — resolved

**Change.**
- **Session identity.** Sessions are keyed by configuration fingerprint (now including the credential variable name) plus an HMAC of the credential value under a per-process key, which is never persisted. Rotation closes the session.
- **Verification.** Catalogs must be verified in the current process for the current identity within `catalogTtlMs`; otherwise they are rediscovered, and unverified connectors expose no tools.
- **Definition hashes.** Each tool definition (name, title, description, schema, annotations) has a SHA-256 hash, and each catalog has a revision. Drift is recorded as a `catalog_changed` event.
- **Drift blocks calls.** A call is refused if the verified definition differs from the one the worker was shown.
- **Local trust.** Read-only access (consult/review) and retry safety come only from local `trustPolicies` pinned to definition hashes. A drifted definition voids the policy. Server annotations are advisory, and adopting them is an explicit UI action.

**Evidence** (`tests/mcp-trust.test.ts`, `tests/context.test.ts`), against live SDK servers over Streamable HTTP:
- credential rotation re-authenticates, and the old verification is refused;
- a server that makes a tool destructive while keeping `readOnlyHint` gets the policy voided and the call refused;
- TTL expiry with an injected clock;
- annotations alone never grant read-only access.

**Challenge to the audit's framing.** No client can make an arbitrary MCP server hard read-only: a server can change behavior without changing its advertised definition. What the harness now guarantees deterministically is narrower and exact: only tools a human reviewed as read-only, *in the definition the worker sees*, are reachable from read-only work. For a hard guarantee, use a read-only credential or a separate read-only server. `docs/CONNECTORS.md` says so.

### A6 — Residency accounting and VRAM estimation — resolved

**Change.**
- **Keys and versions.** Residency is keyed per topology and model node, and versioned by a configuration key.
- **Edits re-account.** Saving a topology re-accounts at once (`runtime.onTopologySaved`):
  - idle models are unloaded, including the *previously loaded* llama-swap model;
  - busy models are marked `reconfigurePending`, and new requests wait until old-configuration requests drain.
- **Unknown VRAM.** `estimatedVramMb` is nullable. Unknown on a GPU-capable model reserves the whole VRAM budget; `0` means explicitly CPU-only.
- **GGUF estimates.** Inspection derives RAM and VRAM from offloaded layers and a KV cache for window × parallel slots, and states its assumptions.
- **llama-swap fix.** The generated config used `-c` equal to the window, but llama-server shares `-c` across `--parallel` slots, so each slot got a fraction of the window. It now passes window × slots.
- **Control and observation.** Snapshots report `residencyControl` (physical for llama-swap, logical for external servers, simulated), and the UI compares accounted usage with the budgets beside OS and nvidia-smi observations.

**Evidence** (`tests/model-pool.test.ts`, `tests/models.test.ts`):
- idle re-accounting;
- a busy model never runs a request under stale accounting;
- two unknown-VRAM models never co-reside;
- a llama-swap unload of the old model ID, observed by a real HTTP listener;
- per-topology isolation;
- VRAM/RAM split for full, partial and CPU-only offload.

### B1 — Tool follow-ups overflowing the window — resolved

**Change.** `fitToolTail` runs before *every* call:
1. older tool results become `read_artifact("tool:<id>")` stubs;
2. the newest results are truncated;
3. the oldest turns are dropped behind a note naming their references.

It raises `ContextBudgetError` instead of sending an oversized request. Individual results are also capped relative to the remaining budget, while the full, connector-bounded result stays in the ledger.

**Evidence** (`tests/context-fit.test.ts`):
- unit fitting;
- a no-op case;
- a refusal case;
- a live run of three ~5K-token MCP results through deferred discovery on a 4K-window model, where every call fits and elision is recorded.

### B2 — Review of a handed-off subject — resolved

**Change.** A handoff retargets non-terminal orders' `dependencies` and `subjectOrderIds` from the source to the successor in the same transaction. Readiness and review subjects also resolve through handoff chains.

**Evidence.** In `tests/review.test.ts`, a delegated builder hands off while the review is queued. The review waits for the successor and evaluates its work.

### B3 — Non-transactional store — resolved

**Change.** Each mutation clones the affected entity, validates it with its schema, persists the next document atomically, and only then publishes it. `writeDocument` is overridable for fault injection.

**Evidence** (`tests/store.test.ts`):
- invalid topology;
- invalid run mutation;
- a throwing callback;
- an injected disk failure (live state stays equal to durable state, and a later write does not carry the failed change);
- queued writes where one fails.

### B4 — Pause not a quiescence barrier — resolved

**Change.**
- Tool dispatch is a commit point: nothing starts after the abort signal.
- Pause cancels in-flight provider, MCP and HTTP requests, waits for the run worker to drain, and records `quiescedAt`. Interrupted effectful calls are flagged `indeterminate`, and resume is refused until they are reconciled.
- Authorization is re-checked against the saved topology immediately before dispatch.

**Evidence** (`tests/effects.test.ts`, "pause as a quiescence barrier"):
- pause mid-POST drains, flags, blocks resume, and reconciles, with exactly one POST;
- pause before any tool call starts no effect, and resume performs exactly one.

**Residual.** An effect that ignores cancellation can outlive the 15-second drain window. In that case pause reports `quiescedAt: null` ("pausing…") until the worker exits, rather than claiming quiescence.

### B5 — Telemetry overstating certainty — resolved

**Change.**
- Frames store `requestPrefixHash`, a hash of the actual request prefix: provider, endpoint, model, system message, tools sent, and response schema.
- `localPrefixMatch` is decided at dispatch in dispatch order, and is named and documented as a local equality signal.
- Response schemas are counted as a segment.
- Measured prompt tokens and cache hits come only from server-reported usage; the counts are tracked separately (`usageReportedCalls`, `cacheReportedCalls`) and the UI shows "n/a" otherwise.
- The demo model no longer fabricates cache hits and marks its counts as estimates.

**Evidence.** In `tests/relationships.test.ts`, the frames test asserts local-match semantics, no reported usage from the simulator, and that the response-schema prefix differs.

**Residual.** Pre-request token counts remain tokenizer-free estimates. They are labelled as such.

### B6 — Unbounded connector payloads — resolved

**Change.**
- A bounded stdio transport caps each JSON-RPC line before parsing and stops the server on violation.
- A bounded fetch caps Streamable HTTP response bodies.
- Catalogs are limited: 512 tools, name pattern and length, 32 KB and depth 16 / 2,000 nodes per schema, 8,000-character descriptions, 2 MB total. Offending tools are rejected individually and listed.
- Result content parts are capped.
- HTTP API responses are read with a byte cap.
- Closed sessions are evicted, so the next use reconnects.

**Evidence** (`tests/mcp-trust.test.ts`):
- malformed and oversized tools;
- the tool-count cap;
- a live stdio server sending a 5 MB message: stopped, then a new session works;
- oversized HTTP bodies.

## Test suite

123 tests in 15 files (86 before this remediation). `pnpm typecheck`, `pnpm test` and `pnpm build` pass. The suite was run three times consecutively without flakes.

## Runtime verification

Checked on the production build in the browser:
- A POST to a local order-system stand-in was paused mid-flight. The run became quiescent, the call was flagged, and Resume was disabled.
- It was reconciled from the UI; the run completed, and the service received exactly one POST carrying an `Idempotency-Key`.
- Live MCP discovery showed local trust controls. Before explicit adoption, no tool was read-only despite server annotations.
- The context summary showed "n/a" for unreported usage, and the demo model was labelled "simulated".
