# AGENTS.md

## Project purpose

You are working on Agentic Harness, a local-first visual agent orchestration IDE.

The most important architectural rule is:

> The configure graph is a capability topology, not a workflow DAG.

Connections represent availability, permission, storage access, model assignment, or agent collaboration. They do not prescribe a fixed execution sequence.

## Product behavior

The application has two primary views:

1. **Work view**
   - Simple ChatGPT/Claude-style interface for giving work to the configured system.
   - Orchestration complexity should remain mostly behind the scenes during normal use.

2. **Configure view**
   - Node-based visual editor inspired by Blender's Shader Editor.
   - Represents models, agents, capabilities, skills, storage, APIs, MCP servers, connectors, and A2A relationships.

## Core semantics

Conceptual node classes include:

- Model
- Agent
- Capability / Tool
- Skill
- MCP / Connector / API
- Storage

Agents are specialized workers. An agent is a model-backed worker capable of recognizing when and how to use the resources connected to it.

Models and agents are distinct concepts. A custom fine-tuned model artifact may be attached to one or more agent configurations.

Agent-to-agent collaboration should support defined relationship semantics such as:

- Delegate
- Consult
- Review
- Report
- Handoff

Storage relationships must eventually support explicit permissions such as read, write, and scoped write.

## Runtime principles

- Hardware-aware deterministic scheduling.
- Models load when needed and unload when idle.
- Low-memory systems may execute mostly sequentially.
- Higher-memory systems may keep more models resident and run compatible work concurrently.
- Pausing work should allow topology or instruction changes without discarding completed results.
- Conversation persistence is configurable through connected storage.
- The human controls topology optimization; agents do not redesign the graph autonomously.

## Context efficiency principles

- An edge **authorizes** a resource; it does not mean its full definition enters every prompt. Keep authorization (`resolveToolDescriptors`) separate from exposure (`planToolExposure`).
- The topology is a security, hallucination, and context-budget boundary at once.
- Keep the stable prompt prefix deterministic: topology-derived content only, sorted by ID, no timestamps or run data. Dynamic work-order content goes after it.
- Treat context as a measured resource: every model call records a context frame, and Configure shows per-agent footprints computed by the same builder the runtime uses.
- Invoke collaborators only when they add value; plans are validated against edges and capped.
- Prefer structured state (work orders, summaries, verdicts, artifacts, memory) over replaying transcripts.

## Model strategy

Custom user-trained/fine-tuned models are first-class artifacts.

Expected development pattern:

Foundation model -> specialist fine-tune -> optional adapter(s) -> quantized deployment artifact

Typical specialist target: roughly 2-5B parameters.

Keep inference and model storage modular enough that the application is not permanently coupled to one serving backend.

## Hardware targets

Baseline:
- ~16 GB RAM
- ~8 GB VRAM

Mid-tier:
- ~32 GB RAM
- ~12-16 GB VRAM

The same saved topology should remain usable across both classes of machine, with concurrency adapting to available resources.

## Development mandate

Build toward a coherent end-to-end working product rather than stopping after isolated scaffolds.

Use existing open-source implementations where appropriate instead of recreating mature infrastructure. Study Langflow, XYFlow/React Flow, llama.cpp, llama-swap, Open WebUI, MCP, A2A, and other relevant projects. Reuse or integrate code only when license-compatible and preserve required attribution.

Make reasonable engineering decisions independently. Do not pause for routine architecture choices, minor ambiguities, or approval after each milestone. Continue through the next logical implementation work unless genuinely blocked.

Prefer clear typed schemas, modular boundaries, tests around non-trivial domain logic, local-first operation, and practical consumer-hardware efficiency.
