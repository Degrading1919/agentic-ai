# AGENTS.md

## Project purpose

You are working on Agentic Harness, a local-first visual agent orchestration IDE.

The most important architectural rule is:

> The configure graph is a capability topology, not a workflow DAG.

Do not implement graph connections as prescribed execution order unless a future specification explicitly introduces a distinct execution-edge type.

## Product behavior

The application has two primary views:

1. **Work view**
   - Minimal AI chat/work interface.
   - Intended to hide orchestration complexity during normal use.

2. **Configure view**
   - Node-based visual editor inspired by Blender's Shader Editor.
   - Represents models, agents, capabilities, skills, storage, APIs, MCP servers, connectors, and agent relationships.

## Node semantics

Initial conceptual node classes:

- Model
- Agent
- Capability / Tool
- Skill
- MCP / Connector / API
- Storage

Agents are specialized workers. An agent is a model-backed worker capable of recognizing when and how to use the resources connected to it.

Models and agents are distinct concepts. A custom fine-tuned model artifact may be attached to one or more agent configurations.

## Edge semantics

Connections are permissions/availability relationships.

Examples:

- Agent -> Tool: tool is available to the agent.
- Agent -> Storage: agent may access that storage according to edge permissions.
- Agent -> Agent: structured A2A collaboration is permitted.

Initial A2A relationship types:

- Delegate
- Consult
- Review
- Report
- Handoff

Storage edges will eventually support permissions such as read, write, and scoped write.

## Runtime principles

- Hardware-aware but deterministic scheduler.
- Models load only when needed and unload when idle.
- Low-memory systems may execute mostly sequentially.
- Higher-memory systems may keep more models resident and run compatible work concurrently.
- Pausing a task must eventually allow topology changes without discarding completed work.
- Conversation persistence is configurable per agent/storage relationship; disabled means transient conversation state may be discarded.

## Model strategy

The product must support custom user-trained/fine-tuned models as first-class artifacts.

Expected model development pattern:

Foundation model -> specialist fine-tune -> optional adapter(s) -> quantized deployment artifact

Typical specialist target: ~2-5B parameters.

Do not assume one inference backend. Inference abstraction will be designed separately. Do not lock Task 001 to Ollama, llama.cpp, LM Studio, vLLM, or another backend.

## Hardware targets

Baseline design target:
- ~16 GB RAM
- ~8 GB VRAM

Mid-tier target:
- ~32 GB RAM
- ~12-16 GB VRAM

Avoid architecture choices that require multiple large models to remain resident simultaneously.

## Engineering guidance

- Prefer clear typed schemas over free-form dictionaries.
- Separate UI graph state from runtime execution state.
- Keep node/edge semantics extensible.
- Avoid premature inference, training, MCP, A2A transport, or scheduler implementation before their contracts are defined.
- Preserve local-first operation.
- Document architectural decisions that affect later runtime design.
- Add tests for graph-domain behavior as soon as non-trivial logic appears.
