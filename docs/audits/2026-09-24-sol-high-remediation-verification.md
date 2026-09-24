# Independent verification of the Sol High remediation

Date: 2026-09-24

Remediation baseline: `fix/sol-audit-remediation` at `77c304c` (`6d51dcd`, `22581e9`, `4664e15`, `77c304c` on `main` at `ccc41e6`).
Scope: the twelve findings in [`2026-09-24-sol-high-runtime-architecture-audit.md`](2026-09-24-sol-high-runtime-architecture-audit.md). This is an audit of the committed remediation, not a review of concurrent uncommitted work.

## Decision

**Do not merge until specified blockers are fixed.** The remediation closes several original boundary failures, but five independently reproduced interactions remain: an effect that succeeded remotely can be recorded as failed, a paused run can resume before its worker drains, idle MCP close retains catalog verification, a queued model reconfiguration can skip physical unload, and a complete oversized stdio message bypasses the byte limit. The first two affect external-effect integrity; the third affects connector trust; the fourth defeats the llama-swap residency contract; the fifth defeats an untrusted-input resource limit.

## Method and result by original finding

I verified Git status, branch ancestry, the original audit and remediation report, the four remediation commits, relevant implementation paths, and new regression tests. I used a separate clean worktree at `77c304c` because the connected checkout acquired unrelated uncommitted production edits during verification. Temporary adversarial tests were removed after collecting their output. No production code was changed.

| Finding | Status | Verification | Residual risk |
| --- | --- | --- | --- |
| **A1 — storage scope escape** | **Resolved** | `storage.ts` rejects drive-qualified/relative, UNC/device, traversal, ADS, reserved-name and absolute inputs for both reads and writes; canonical root, component `lstat`, read-handle identity, and write-parent/destination checks cover the original Windows junction attacks. `storage.test.ts` exercises real junctions for scope, nested parent, destination, and trusted root. | A local process able to replace directories between the final check and syscall can race Node's path-based operations on Windows. Harness storage tools do not create links; this is accurately documented and outside the original agent-only escape scenario. |
| **A2 — artifact information flow** | **Resolved** | `artifact-policy.ts` authorizes from the requesting order and relationship, including dependency, review subject, revision, handoff predecessor, terminal child, own tool result and root-only prior-run root. Tests deny known sibling IDs, child-to-parent, unrelated/running output, another order's tool result and prior-run internal work. | Relationship policy remains security-sensitive when new relationship types are added. No current ID-only read path found. |
| **A3 — external-effect recovery** | **Partially resolved** | Durable `planned`/`started`/terminal ledger, stable operation IDs and checkpoint replay pass crash/restart tests for safe and non-idempotent operations. An adversarial real POST completed its effect and then timed out; the run completed with ledger `failed` and no reconciliation (`count:1`, `effect:effectful`, timeout error). | A user or agent can interpret the effect as unapplied and issue it again. Timeout/connection failure after dispatch is not proof of non-application. **Blocker.** |
| **A4 — fail-closed review** | **Resolved** | `parseVerdict` accepts only valid approve/revise/reject JSON; malformed prose, empty/truncated output and invalid verdict return null. Review retries are bounded and end `indeterminate`; runtime tests distinguish valid approval from failed review. Provider failure flows through failed review, not approval. | Provider timeout/error has no dedicated adversarial test, but the error path does not synthesize approval. |
| **A5 — MCP identity, freshness, trust** | **Partially resolved** | Session key includes config and a keyed digest of credential identity; TTL, schema hash and local trust checks cover ordinary drift. Forced idle close of a verified live stdio fixture yielded `connected:false, verified:true`; reconnect can use the old verification without discovery. | A replacement server at the same connector identity can receive calls authorized by a definition verified on the closed session until TTL expiry. Read-only annotations are correctly treated as advisory; hard read-only still requires restricted credentials/server. **Blocker.** |
| **A6 — model residency/accounting** | **Partially resolved** | Config-key accounting, idle unload, separate RAM/VRAM and unknown-VRAM reservation are implemented and tested. With a busy old llama-swap model and a queued new configuration, both requests completed with **zero** `/api/models/unload/old` calls, while the pool recorded the new config key. | The pool can claim new logical configuration while old physical model remains resident. The existing active-request test checks estimates only. **Blocker.** |
| **B1 — tool-result context fitting** | **Resolved** | `fitToolTail` runs before each subsequent loop call, replaces older results with `read_artifact` references, includes the reference note in budgeting, and throws a bounded context error if the newest turn cannot fit. Existing large-result tests exercise multiple tool turns. | Very small windows or many reference IDs can end in a bounded context-budget failure; no infinite compaction/retrieval loop found. |
| **B2 — review after handoff** | **Resolved** | Handoff rewrites nonterminal dependency and subject references; dependency resolution follows handoff chains. Integration test checks delegate → handoff → successor → review and inspects successor work. | Chained handoff lacks its own regression test; the same resolution loop supports it within the configured limit. |
| **B3 — transactional persistence** | **Resolved** | `LocalStore.commit` clones, validates, writes by atomic replacement, then publishes live state. Tests inject schema, callback and file-write failures plus queued mutations, and compare live/durable state. | Rename failure is not separately injected, but occurs before publication in the same commit path. |
| **B4 — pause/quiescence** | **Partially resolved** | Ordinary in-flight HTTP cancellation and pause-before-dispatch tests pass. Held an already-dispatched effect beyond the actual 15-second pause deadline: `pauseRun` returned `quiescedAt:null`, yet `resumeRun` returned `queued` while the ledger remained `started`. | Resume can overlap an active effect with restarted work and bypass the intended reconciliation gate. **Blocker.** |
| **B5 — cache/context telemetry** | **Partially resolved** | Provider-reported prompt/cached usage is separated from estimates and local prefix equality; mock/demo use is not counted as measured. However OpenAI-compatible completion retries without `response_format` on 400/404/422 while the recorded request-prefix hash/frame still describes the original schema request. | On fallback the local equality field can describe a prefix not sent in the successful request. It is labeled local equality, not a cache hit. Non-blocking telemetry correction. |
| **B6 — connector resource limits** | **Partially resolved** | Catalog count/schema and HTTP body limits, result truncation and stdio buffering limits are present. A 4,195,402-byte *complete* JSON-RPC line (4,194,304-byte cap) was delivered to `onmessage` with zero errors. | A server can force oversized JSON parsing/SDK delivery by ending the line in the same chunk; the test sends an incomplete line and misses this route. **Blocker.** |

## Material residual defects

### 1. High — effectful transport failure is recorded as definite failure (A3)

**Location:** `src/server/runtime.ts`, `invokeDescriptor` around lines 2224–2283 and `executeRecorded` around lines 2090–2130; `src/server/capability-executor.ts`, HTTP dispatch. The transport error becomes a tool `isError` outcome, then a terminal `failed` ledger row. This bypasses the `started` → `indeterminate` recovery rule because the worker remains alive long enough to record the error.

**Reproduction:** A real local HTTP server increments a counter on POST and delays its response for 1.8 seconds; connector timeout is 1 second, method is POST, `honorsIdempotencyKey:false`. A direct run finished with `count:1`, `run:"completed"`, `record:"failed"`, `effect:"effectful"`, `error:"ERROR: The operation was aborted due to timeout"`. The external effect occurred. A connection reset after server commit or MCP timeout has the same uncertainty class.

**Impact and correction:** The failed ledger is presented as a known negative result, allowing a later duplicate purchase/write. Once dispatch of a non-idempotent effect starts, transport failure without an authoritative application result must become indeterminate and require reconciliation. Preserve definite pre-dispatch denials separately. Test timeout/reset after the server commits, then reconcile both outcomes. This blocks merge.

### 2. High — resume accepts a run whose pause barrier has not drained (B4)

**Location:** `src/server/runtime.ts`, `pauseRun` lines 445–469, `resumeRun` lines 471–495, `pump` finalization around lines 555–582.

**Reproduction:** A real POST completed, while an instrumented capability executor held its returned result without honoring abort. `pauseRun` waited the configured 15 seconds and returned `quiescedAt:null`. Before releasing that executor, `resumeRun` returned `queued`; the tool ledger still said `started`. The existing tests cover cancellable HTTP and immediate pause, not this deadline path.

**Impact and correction:** Resumption can be queued while the prior worker still owns an effect. `pump` later detects a queued run, but it skips the paused-run quiescence/`flagInterruptedEffects` path, so reconciliation is not established at the barrier. Refuse resume while `quiescedAt` is null or a worker remains active; finish draining and classify the started effect first. Add a deadline-path test. This blocks merge.

### 3. High — queued llama-swap reconfiguration skips physical unload (A6)

**Location:** `src/server/model-pool.ts`, `reconfigure` lines 265–272, `withModel` lines 356–386, `unloadLocked` lines 426–445.

**Reproduction:** Hold an old llama-swap request, save a new model ID, enqueue the new request, then release the old request. A local mock llama-swap endpoint recorded no unload request before the new operation ran; the pool nevertheless held the new config key. `withModel` increments `waitingRequests` before slot acquisition. On old-request release, `reconfigure` calls `unloadLocked`, which returns because that waiter exists, then `account` records the new config unconditionally. The same can occur when the waiter itself calls `reconfigure` while other waiters remain.

**Impact and correction:** Physical residency and resource accounting diverge. On 8–16 GB VRAM this can induce OOM or dispatch against the wrong loaded model. Reserve the reconfiguration transition so waiters cannot suppress its required unload, and only publish new accounting after successful physical transition. Test an actual queued waiter with unload-order assertions. This blocks merge.

### 4. Medium — idle MCP close retains verification across sessions (A5)

**Location:** `src/server/mcp.ts`, `open` `onclose` handler around lines 408–419 and `closeIdle` lines 539–548.

**Reproduction:** Discover a live stdio fixture, force its `lastUsed` past the idle threshold, call `closeIdle`, and query `isVerified`. Result: `connected:false`, `verified:true`. `closeIdle` removes the map entry before `client.close`; `onclose` only clears verification when the map still points to that connection. `callTool` checks the retained verification before opening the new connection.

**Impact and correction:** A restarted or replaced same-name server can be called under the prior session's reviewed catalog. Clear verification on every session close, including idle and unexpected termination, and bind a verification to the exact live session. Add an idle-close/reconnect drift test. This blocks merge because it crosses the documented trust boundary.

### 5. Medium — complete oversized stdio message bypasses the limit (B6)

**Location:** `src/server/mcp.ts`, `BoundedStdioTransport.receive` lines 293–312.

**Reproduction:** Feed a single 4,195,402-byte JSON-RPC response line (including newline) to `receive` with `MCP_LIMITS.maxMessageBytes = 4,194,304`. It invokes `onmessage` once and `onerror` zero times. The loop parses every complete line before checking only the leftover buffer length. The current test uses a line without a newline until the buffer exceeds the cap, so it cannot catch this case.

**Impact and correction:** Untrusted stdio output can consume memory/CPU above the per-message cap and reach SDK handling. Enforce the cap before UTF-8 decoding and JSON parsing for every complete line; bound incoming chunk processing and close the session on violation. Add a single-chunk newline-terminated oversized-line test. This blocks merge.

### 6. Low — fallback request can make local prefix telemetry inaccurate (B5)

**Location:** `src/server/providers.ts`, `openAICompatibleCompletion` lines 101–111 and `requestPrefixHash` lines 157–169; `src/server/runtime.ts` `completeForOrder` around lines 2350–2355.

The hash includes `jsonSchema`, but a 400/404/422 retry omits its `response_format`; the frame and hash are not updated. This is a code-path verification, not a measured cache-hit failure. Record the actual successful request variant (and both attempts where useful), then compare its true prefix. This is a non-blocking correction.

## Verification limits and regression-test interpretation

- `pnpm typecheck`, `pnpm test`, and `pnpm build` passed on the committed remediation: **123 tests in 15 files**. The count matches the remediation report. The adversarial probes were run separately and intentionally failed, then removed.
- The original storage attacks are directly covered by Windows junction and path tests; the remaining local-actor TOCTOU cannot be made impossible with the current Node path APIs and was not treated as an agent escape.
- The A3 restart tests prove that an interrupted `started` non-idempotent call pauses for reconciliation, but they do not cover a live transport error *after* an external commit. The B4 tests use promptly cancellable HTTP; the 15-second fallback is untested. The A6 active-edit test checks revised estimates, while only an idle edit checks llama-swap unload. The B6 oversize fixture is incomplete until its cap is exceeded, while a complete line is parsed first.
- A2's pure-policy and live-run tests, A4's strict parser/integration tests, B2's successor review test, and B3's injected write-failure tests support the resolved classifications. I found no material regression in those paths.
- GPU telemetry and actual GGUF/llama-swap residency were not available on this host. The report's A6 defect is established with a real HTTP unload endpoint and the pool's actual queue; no physical GPU claim is inferred.

**Correction order:** (1) A3 uncertainty and B4 quiescence as one effect-state design, (2) A5 session-bound verification, (3) A6 queued physical transition, (4) B6 per-message input bound, then (5) B5 telemetry variant. A3/B4 and A6 require high-judgment concurrency and state-machine work. A5/B6 and B5 are bounded implementation and regression-test work once their invariants are stated.
