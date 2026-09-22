# Agentic Harness

Working title for a local-first visual agent orchestration IDE.

## Product thesis

Agentic Harness is a desktop-oriented local AI environment with two primary views:

- **Work**: a simple ChatGPT/Claude-style interface for giving work to the configured system.
- **Configure**: a Blender Shader Editor-style node canvas that defines which models, agents, tools, skills, MCP servers, APIs, storage systems, and other resources may interact.

The graph is a **capability topology**, not a workflow DAG. An edge means that a capability, resource, storage target, or agent relationship is available. It does not prescribe execution order.

The system is designed around small, heavily specialized local models, dynamic model loading/unloading, hard capability boundaries, structured agent-to-agent work orders, and consumer hardware.

## Primary hardware targets

- Baseline: ~16 GB system RAM / 8 GB VRAM
- Mid-tier: 32 GB system RAM / 12-16 GB VRAM
- Higher-end systems should gain concurrency and speed without requiring a different saved topology.

## Core principles

1. **Local first**: model execution and orchestration run locally.
2. **Capability graph, not workflow graph**: connections grant access; agents decide when to use available capabilities.
3. **Hard boundaries**: disconnected tools, agents, and storage are unavailable to that agent.
4. **Specialization over parameter count**: favor fine-tuned 2-5B specialist models where practical.
5. **Structured workers, not personalities**: agents exchange structured work orders.
6. **Human-directed optimization**: the harness exposes performance and hardware data; agents do not autonomously redesign the topology.
7. **Deterministic scheduling**: model residency and resource scheduling are controlled by software, not an LLM.
8. **Model-agnostic architecture**: custom fine-tuned models must be first-class citizens.

## Current status

Concept definition complete enough to begin a UI/runtime architecture vertical slice.

See `tasks/001-configure-work-shell.md` for the first implementation task.
