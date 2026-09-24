# Agentic Harness runtime architecture audit

Date: 2026-09-24

Baseline: `main` at `8152d985ae18196b15fc622be910039e8f9fef9c` (local HEAD and fetched `origin/main` matched before this audit)

Scope: repository-wide review of the implemented runtime, shared contracts, UI configuration, tests, and documented Task 002 behavior.

## Decision

**Do not extend the external-capability surface or rely on the current read-only and recovery guarantees until the blocking findings below are fixed.** The capability-topology architecture is a sound basis for continued work, but its file scope, artifact visibility, connector catalog, and effect recovery boundaries currently disagree with the stated security model. Internal UI work and bounded implementation of the corrections can continue. The green test suite does not establish the missing adversarial properties.

Severity means impact in a realistic local deployment, not remote exploitability. The API is explicitly unauthenticated and intended for localhost. A topology editor is trusted to grant a root or connector; an agent and the data it consumes are not trusted to exceed the *scope* of that grant.

### Verification performed

- Inspected actual branch/status, recent history, README, AGENTS.md, both architecture documents, ADRs, Task 002, all server/shared modules, and the tests. Fetched `origin/main`; it matched `8152d98`.
- `pnpm typecheck`: passed. `pnpm test`: 61/61 passed. `pnpm build`: passed (Vite reported only a large client chunk warning).
- Ran a temporary Windows storage/state/model probe and removed it. A scoped junction allowed both an outside read and outside write. Scope `C:/Windows` read `win.ini` through a `project-files` node rooted elsewhere. A rejected `LocalStore.saveTopology` left an invalid topology in memory but not on disk. A resident model retained its prior 512 MB estimate after being invoked with a 900 MB configuration.
- Called `parseVerdict("I could not inspect the files.")`; it returned `approve` with zero findings.
- The report is audit-only; no implementation changes or failing regression tests are included.

## Blocking findings

### A1 — Critical, verified defect: storage scope can escape its node root

**Subsystem/location:** `src/server/storage.ts`, `normalizeScope` (44–50), `scopedRoot` (142–145), `resolveInside` (147–173), `read` (199–210), `write` (212–229). Existing symlink test: `tests/storage.test.ts` (45–61).

**Fault:** The scope itself is resolved with `path.resolve(rootFor(node), scope)` without checking it remains under the node root. On Windows, `normalizeScope("C:/Windows")` leaves a drive-qualified path, and `path.resolve` replaces the node root. Separately, when the scope directory is a junction to an outside directory, the symlink check compares the real target against the real *scope* root, which is already outside; it never checks against the storage node's physical root.

**Impact/scenario:** A graph may appear to grant `/link` within a project folder while `link` points elsewhere. The connected agent can read and write outside that folder. The temporary probe created a junction `<workspace>/files/link -> <temp>/outside`; `read(..., scope="/link", "secret.txt")` returned `OUTSIDE SECRET`, and `write(..., "created.txt")` created an outside file. A second probe with `scope="C:/Windows"` read `C:\Windows\win.ini`. This is a concrete failure of the topology's filesystem permission boundary, including on the host platform.

**Correction:** Validate scope as a relative path before joining; reject drive prefixes, UNC/device paths, empty-root surprises, and traversal. Resolve the storage node root and the scope against its canonical root, then require containment of both the scope and target. Use handle-relative or otherwise race-resistant operations where possible; recheck after parent creation and before open/rename. Add Windows junction/drive-scope and root-symlink tests that fail rather than silently skip when the platform supports them. **Blocks further storage-capability development.** The canonical path and race design requires high-judgment engineering; the lexical drive rejection is bounded.

### A2 — High, verified defect: `read_artifact` bypasses work-order visibility

**Subsystem/location:** `src/shared/capabilities.ts` `metaToolDefinitions` (502–515); `src/server/runtime.ts` `handleToolCall` (1646–1647) and `readArtifact` (1705–1722).

**Fault:** Every agent receives `read_artifact`. Its implementation accepts any order ID in the current run and in every run of the thread. It has no caller work-order ID, dependency check, collaboration relationship check, or storage-read check. The error says “visible from this work order,” but visibility is not calculated. It also returns a draft, result, or error from an order that is still running if the ID is known.

**Impact/scenario:** A consultant given only a narrow question can supply the ID of a sibling specialist's output (for example, learned through an untrusted report, result, or prompt) and retrieve the full text despite no data-flow relationship. A follow-up thread can similarly retrieve older order results across agents. UUIDs make blind guessing hard, but IDs are routinely present in work-order and compact-reference text, so they are not an authorization mechanism. The method signature itself makes enforcement impossible. **Blocks treating the topology as an information boundary.**

**Correction:** Pass the requesting order into artifact resolution. Define allowed references explicitly: the order's own prior revision, its declared dependencies/subjects, its children returned to it, and specifically authorized thread history. Resolve each reference through that policy and capture a stable content version for review. Test a known sibling ID, an unrelated prior-run ID, and an allowed dependency reference. High-judgment policy work.

### A3 — High, verified defect: recovered orders can repeat external effects

**Subsystem/location:** `src/server/runtime.ts` `init` (200–219), `executeWorkOrder` (556–625), `runAgentLoop` (1467–1529), `invokeDescriptor` (1657–1703); `src/server/capability-executor.ts` (70–96, 152–187).

**Fault:** Startup resets every persisted `running` order to `queued` and restarts its phase. Tool-loop messages and completed tool-call IDs are held in a local `messages` array, not a durable execution checkpoint. A tool response is logged, but the restarted loop does not use that log to avoid another call. No idempotency key is supplied to HTTP or MCP tools. Pausing an order follows the same queued replay model, and ordinary file/memory tool effects have no abort or transaction coordination.

**Impact/scenario:** An HTTP `POST` or effectful MCP tool succeeds, then the process dies before `completeOrder`. Recovery asks the model to execute the order again; it may issue the same purchase, publish, delete, or memory append twice. The 61 tests exercise arithmetic, mock responses, and an echo-like MCP server; they cannot detect duplicated side effects after an interrupted call. **Blocks exposing effectful connectors as safely recoverable work.**

**Correction:** Specify at-least-once semantics honestly and add a durable tool-call ledger with stable operation IDs, result checkpoints, and provider-specific idempotency where supported. For non-idempotent tools without idempotency support, stop for reconciliation instead of automatically reissuing. Test a tool that records invocations, interrupt after its effect but before order completion, then recover. High-judgment engineering.

### A4 — High, verified defect: malformed review output silently approves work

**Subsystem/location:** `src/server/runtime.ts` `parseVerdict` (128–140), `runReview` (1170–1219), `integrate` (998–1113).

**Fault:** When structured JSON parsing fails, `parseVerdict` defaults to `approve` unless the free text happens to contain a reject/revise keyword. A model failure such as “I could not inspect the files” therefore becomes an approval. The probe returned `{"verdict":"approve","summary":"I could not inspect the files.","findings":[]}`. An approved direct draft is finalized without another model call.

**Impact/scenario:** A small local model or a provider that rejects/ignores JSON-schema mode returns an apology, partial response, or tool failure explanation. The runtime records a successful review verdict and can publish the draft as reviewed. This undermines the semantic Review relationship. **Blocks relying on review gates for correctness.**

**Correction:** Parse only a valid verdict schema. On invalid output, retry a bounded number of times or mark the review failed/indeterminate and surface it to the owner. Never infer approval from unconstrained prose. A bounded implementation with focused tests.

### A5 — High, verified defect and trust risk: stale MCP identity/catalog can widen read-only access

**Subsystem/location:** `src/shared/capabilities.ts` `connectorFingerprint` (87–90), `catalogFor` (92–103), `connectorDescriptors` (280–304); `src/server/mcp.ts` `connection` (126–145), `discover` (147–182); `src/server/runtime.ts` `ensureCatalogs` (661–689), `invokeDescriptor` (1657–1670).

**Fault:** Fingerprints include transport/endpoint/command/args, but omit `authEnv` and its current principal. A changed token identity can reuse both the old MCP session and catalog. A server-side tool/schema/annotation change at the same endpoint never invalidates a successful catalog: `ensureCatalogs` returns immediately on a matching cached fingerprint. Read-only authorization is based solely on the cached, server-supplied `readOnlyHint` flag; execution calls the current tool by name without validating its current behavior or schema.

**Impact/scenario:** A connector changes from a high-privilege to low-privilege token, yet the pooled session may still send the old token; or a previously read-only tool becomes effectful on the server and a consultant may still invoke it under the stale `readOnly` catalog. A malicious MCP server can simply lie in its annotation. The code enforces *the cached declaration*, not a hard read-only sandbox. **Blocks claiming deterministic read-only enforcement for untrusted MCP connectors.**

**Correction:** Include identity/configuration changes in session invalidation without storing secret values; explicitly close sessions on credential changes. Give catalogs a revision/TTL/refresh policy, and validate the selected tool against a fresh catalog before sensitive use. Treat annotations as advisory: use a locally owned per-tool approval policy or separate read-only credentials/server for hard guarantees. Test token rotation and annotation drift with a live SDK fixture. High-judgment connector policy work.

### A6 — High, verified defect: residency accounting diverges after model edits, and VRAM defaults to zero

**Subsystem/location:** `src/server/model-pool.ts` `stateFor` (54–83), `usage` (95–104), `canStartNow` (145–159), `ensureLoaded` (193–222); `src/shared/contracts.ts` (100–105); `src/client/components/Inspector.tsx` (177–185, 232–233); `src/server/gguf.ts` `inspectGguf` (273–309).

**Fault:** `stateFor` updates a resident state's memory estimates only when it is unloaded or failed. It does update its model configuration and slot count, so subsequent requests can use a changed endpoint/model while accounting remains on the old estimate. The temporary probe loaded a 512 MB model, called the same node with a 900 MB estimate, and the resident state still reported 512 MB. Also, `estimatedVramMb` defaults to zero; GGUF inspection updates RAM estimate but never computes/sets VRAM. Thus the VRAM budget does not constrain newly inspected GPU-offloaded models unless the user supplies a separate estimate.

**Impact/scenario:** On a 16 GB RAM / 8 GB VRAM machine, editing a resident model or inspecting GPU models can lead the scheduler to start combinations that exceed the actual budget. The model state displayed in Work can be stale. The runtime's states are logical for external providers, but this numerical divergence is internal and avoidable. **Blocks making hardware-fit guarantees or adding parallel model orchestration based on these numbers.**

**Correction:** Version residency by immutable configuration identity; unload/reaccount before using a changed model. Derive conservative RAM/VRAM estimates from artifact, offload settings, context, and parallel slots, or require explicit nonzero estimates before enforcing a GPU budget. Observe physical usage for diagnostic comparison without claiming process control of externally managed servers. High-judgment sizing and lifecycle work.

## Other material findings

### B1 — Medium, verified defect: tool follow-ups are not fitted to the context window

**Subsystem/location:** `src/server/context-builder.ts` `packContext` (58–123), `toolTailTokens` (125–130); `src/server/runtime.ts` `runAgentLoop` (1467–1529), `callModel` (1724–1777).

`packContext` fits only the initial system/user messages. Each tool response is appended to `messages` without repacking, and the next model call goes directly to the provider. A 12,000-character result can consume roughly 3,000 estimated tokens; several such calls exceed a 4,096-token local model window even when the initial frame fitted. The frame records tail tokens after the fact, so it is observable but not prevented. This can turn deferred discovery into extra calls and a provider context error, especially on the baseline hardware. Repack/summarize/evict old tool turns before every call, reserve tool-call headroom, and test a multi-result loop against a small window. **Address before broad deferred-tool rollout.** Bounded implementation with careful provider formatting.

### B2 — Medium, verified defect: review can evaluate a handoff notice instead of the successor's output

**Subsystem/location:** `src/server/runtime.ts` `createPlannedChildren` (888–902), `handoff` (1240–1295), ready dependency test (467–473), `runReview` (1170–1193).

A planned review depends on the original delegate order ID. If that delegate hands off, its status becomes terminal `handed_off`, and the successor is a new sibling order. The review becomes runnable before the successor completes and its `subjectOrderIds` still point to the original handoff notice. The parent does wait for the successor, but the recorded verdict is about the wrong subject. Rewrite review dependencies/subjects transactionally on handoff, or define a stable logical subject that resolves to the final successor. Test delegated work that hands off while a review is queued. **Fix before claiming Review covers handed-off deliverables.** Bounded state-machine work.

### B3 — Medium, verified defect: rejected store mutations can poison live state

**Subsystem/location:** `src/server/store.ts` `enqueueMutation` (63–77), `saveTopology` (113–122), `persist` (56–61).

Mutations operate on `this.state` in place, then validate and persist. If validation or the write/rename fails, the promise rejects but the live state is already changed. The temporary probe passed an invalid topology to `saveTopology`; Zod rejected it, yet `listTopologies()` returned the invalid extra item while a fresh store still saw only the original. The HTTP route parses the submitted topology first, reducing that particular external path, but disk errors and internal mutations still create memory/disk divergence; the next successful write can persist poison. Clone, mutate, validate, persist, then swap the live snapshot; preserve the previous snapshot on any failure. Test validation and injected persistence failure. **Fix before expanding durable state complexity.** Bounded implementation.

### B4 — Medium, high-confidence architectural risk: pause/reconfiguration is not a side-effect barrier

**Subsystem/location:** `src/server/runtime.ts` `pauseRun` (341–352), `runAgentLoop` (1498–1529), `invokeDescriptor` (1657–1703); `src/server/storage.ts` `write` (212–229).

Pause persists `paused` and aborts the provider controller, but a model response may already have returned. Tool calls do not check the abort before dispatch; storage operations have no signal. A topology edit can also occur after authorization is rechecked but before an asynchronous MCP/HTTP/storage effect completes. Thus “pause, edit edge, resume” is not a hard quiescence point, and a removed grant may still have an in-flight effect. This is a race inferred from the code paths; a controlled barrier test has not been run. Make pause await draining/cancellation of all in-flight orders and tool effects before reporting quiescence; define commit points and cancellation semantics for non-cancellable effects. **Address with A3.** High-judgment concurrency work.

### B5 — Medium, test/verification gap: cache and context telemetry overstate what is known

**Subsystem/location:** `src/server/context-builder.ts` `buildFrame` (132–185); `src/server/runtime.ts` `callModel` (1724–1777); `src/server/providers.ts` `fetchOpenAICompletion` (56–95).

The stable system prompt and tool list are deterministically built from sorted topology inputs, which is real progress. However `prefixReused` compares only the last completed `system` and tools hashes for the same model node. It is not a backend cache-hit measurement; concurrent requests can complete out of order. The hash omits the JSON response schema, model ID/configuration, and provider formatting even though `response_format` changes the request. Planning/review omit native tools but still build the same static footprint internally; actual server tokenization can differ. The separate server-reported `cachedPromptTokens` is the better measurement when available. Rename the estimate as local prefix equality, hash the actual serialized request prefix, and validate frame estimates against server token usage across planning, execute, review, and follow-up. **Does not block security work; fix before using telemetry to optimize deployments.** Bounded measurement work.

### B6 — Medium, test/verification gap: connector payloads lack resource caps before persistence/exposure

**Subsystem/location:** `src/server/mcp.ts` `discover` (147–182), `contentToText` (32–52), `callTool` (184–204); `src/shared/contracts.ts` `catalogToolSchema` (503–510); `src/server/store.ts` `saveCatalog` (92–102).

Result text is truncated *after* the MCP SDK has parsed and materialized it, and catalog discovery limits pages but not tools per page, aggregate schema bytes/depth, or catalog size. Each schema is saved in the single state JSON and can flow into the prompt/footprint builder. A malicious or buggy server can exhaust memory or make all state writes expensive with a large catalog/schema/result. This is a high-confidence risk from the missing bounds; no adversarial server benchmark was run. Add transport/body and catalog limits, schema complexity limits, and a bounded failure result; isolate untrusted descriptions and results as data. **Fix before recommending arbitrary third-party MCP servers.** Bounded limits plus high-judgment UX for rejected tools.

## Strengths and limits worth preserving

- The graph remains a **capability topology**, not an execution DAG. `getAgentContext`, `resolveToolDescriptors`, and `invokeDescriptor` separate edge authorization from eager/deferred schema exposure; a normal tool call re-resolves the current grant. Tests cover basic unconnected-tool denial and allowlist filtering.
- Stable prompt construction sorts by IDs and keeps work-order data in the dynamic tail. The 150-tool test shows schemas can be deferred. The measured unit should be **accepted work per model call, RAM/VRAM, and wall time**, not just schema tokens: deferred discovery currently adds tool round trips and can overflow later calls.
- Work orders, phases, relationship names, verdicts, artifacts, and context frames are explicit typed state. Bounded delegation and handoff-chain limits avoid unbounded LLM fanout. The five relationships have meaningfully different normal-path code, even though the handoff/review interaction is wrong.
- `ModelPool` has a real lock around residency decisions, per-model request slots, wait-for-capacity, and idle eviction. Tests establish basic serial and parallel slot behavior; they do not establish configuration-change safety, external physical residency, shutdown during in-flight requests, or sustained fairness.
- Provider and storage adapters are modular. The calculator does not evaluate JavaScript. MCP uses the official SDK and the HTTP connector disables automatic redirects and checks origin/path. These are good boundaries to repair rather than replace.
- Reasonable MVP limits: a single-process JSON store, NVIDIA-only telemetry, logical residency for externally managed servers, no vector adapter, no cross-process A2A, and estimated pre-request tokens. These should be documented accurately, not promoted to critical defects solely because they are incomplete.

## Test interpretation and recommended order

The suite is useful for ordinary behavior but mostly tests trusted configurations and happy-path mock providers. Storage tests check an internal symlink under `/`, not a scope that *is* a junction or a drive-qualified scope. Relationship tests cover direct review, revision, and root handoff separately, not review of a delegated handoff. MCP tests use a cooperative fixture; they do not rotate credentials, mutate annotations, return hostile schemas, or crash after an effect. Scheduler tests establish slots and simple budget waiting, not edits to resident models or replay of non-idempotent calls. Context tests compare builder output to the same builder's footprint, so they cannot prove backend cache reuse or a follow-up call fitting the window.

Recommended sequence:

1. **A1 and A2:** restore filesystem and artifact information boundaries before additional tools/storage are attached.
2. **A3 and B4:** define effect replay, pause quiescence, and recovery checkpoints before external write tools are treated as safe.
3. **A4 and B2:** make review failure closed and handoff-aware.
4. **A5:** redesign MCP identity/catalog freshness and hard read-only policy.
5. **A6, B1, B3:** make resource/context accounting and state writes consistent under edits and failures.
6. **B5 and B6:** make observations honest and bound untrusted payloads before performance tuning or broad connector onboarding.

The highest-judgment work is the artifact visibility policy, idempotent effect recovery, pause barrier, MCP trust policy, and physical/model resource estimation. The verdict parser, store transaction pattern, handoff dependency rewrite, drive-scope rejection, and follow-up context repacking are bounded implementations once those policies are set.

**Overall:** The architecture is coherent enough to continue extending *after* the blocking boundaries are repaired and verified. The current implementation is not yet a safe base for adding more effectful connectors or claiming strict scoped storage, read-only MCP access, or restart-safe external actions.
