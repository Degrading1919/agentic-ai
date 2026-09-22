# Open Architecture Decisions

Do not silently decide these during unrelated tasks.

## Inference abstraction

Undecided:

- llama.cpp
- Ollama
- LM Studio
- vLLM
- multiple backends behind an abstraction layer

Current direction: design an abstraction, implement only one backend first.

## Desktop/backend packaging

Candidate direction for early UI work:

- React + TypeScript
- `@xyflow/react` for the node canvas
- Tauri 2 for a lightweight desktop shell
- a separate local runtime service may later be introduced for Python/ML orchestration

Do not let the first UI task lock the runtime implementation to a specific inference server.

## Persistence

Storage node backends, graph persistence format, vector stores, Git-backed memory, and conversation archival formats remain open.

## A2A transport

Relationship semantics are defined conceptually, but transport/protocol adoption is still open. Evaluate the current A2A standard before implementing a custom wire protocol.
