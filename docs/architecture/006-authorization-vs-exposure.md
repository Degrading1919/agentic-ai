# ADR 006: Capability Authorization Is Separate From Context Exposure

## Status

Accepted and implemented.

## Context

An edge from an agent to a connector authorizes every tool that connector offers. Injecting every authorized schema into every request makes large MCP servers unusable for small local models: 150 tools can cost more than 20,000 tokens before any work begins, and irrelevant schemas increase tool-selection errors.

## Decision

Resolve capabilities in two steps:

1. **Authorization** (`resolveToolDescriptors`): the set of tools an agent may invoke, derived only from its edges, connector allowlists, and the access mode of the current order.
2. **Exposure** (`planToolExposure`): how those tools enter context: `eager` (full schemas) or `deferred` (a compact catalog plus stable `find_tools` / `call_tool` harness tools). Agents choose `auto`, `eager`, or `deferred`.

Deferred loading returns schemas as tool results and dispatches through `call_tool`, so the request's `tools` payload never changes mid-task. Calling a tool whose schema has not been loaded returns the schema instead of executing.

Every invocation is re-authorized against the current saved topology immediately before execution, independent of exposure.

## Consequences

- The topology is simultaneously a security, hallucination, and context-budget boundary.
- Small models see a short catalog instead of hundreds of schemas; the cost is one extra round trip for each newly needed tool.
- Deferred calls go through a generic dispatcher, so servers cannot apply native constrained decoding to those arguments. Agents that need native tool calling for a few critical tools can use `eager` exposure.
