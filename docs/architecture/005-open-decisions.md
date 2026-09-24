# Open Architecture Decisions

Do not silently decide these during unrelated tasks.

## Inference abstraction

Decided for now: an OpenAI-compatible transport (`providers.ts`) serves llama.cpp, llama-swap, Ollama-compatible servers, LM Studio, and vLLM. llama-swap is the recommended process manager for local artifacts; the harness generates its configuration rather than managing llama-server processes itself.

Still open: native adapters for backends whose OpenAI compatibility lacks features the harness wants (tokenize endpoints for exact counts, slot pinning for cache affinity).

## Desktop/backend packaging

Candidate direction:

- React + TypeScript
- `@xyflow/react` for the node canvas
- Tauri 2 for a lightweight desktop shell
- a separate local runtime service may later be introduced for Python/ML orchestration

The runtime currently ships as a local Fastify service serving the built UI.

## Persistence

Decided: storage adapters for artifact store, project files, and a local BM25 memory store (see the Storage section of `docs/ARCHITECTURE.md`).

Still open: a database-backed state store for long histories, an embedding-based vector adapter, and Git commit semantics for the `git` storage type.

## MCP

Decided: the official MCP TypeScript SDK as the client, with stdio and Streamable HTTP transports, cached catalogs, and deferred exposure (ADR 006).

Still open: MCP resources and prompts (tools only today), OAuth-based server authorization, and sampling requests from servers.

## A2A transport

Decided: relationship semantics are implemented in-process on structured work orders (ADR 008).

Still open: exposing agents or accepting remote agents over the Agent2Agent protocol. Work orders, verdicts, and artifacts were shaped to map onto A2A tasks and artifacts when that transport is added.
