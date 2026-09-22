# Codex Start Prompt

Build this software end to end.

## Concept

I want a local-first visual agentic AI application that lets me design and run teams of specialized AI workers on consumer hardware.

The application should have two primary experiences:

- **Work**: a simple ChatGPT/Claude-style interface where I give the system a task and interact with the resulting work.
- **Configure**: a visual node editor similar in spirit to Blender's Shader Editor where I build the AI organization.

The Configure graph is not a normal left-to-right workflow. It defines **capabilities, permissions, resources, and collaboration relationships**.

An agent should only know about and be able to use the models, tools, skills, MCP servers, APIs, connectors, storage, and other agents that are connected to it. Connections are hard boundaries.

Agents are specialized workers, not personalities. They should exchange structured work orders and be able to collaborate through defined relationships such as delegation, consultation, review, reporting, and handoff.

Models and agents are separate concepts. I want to be able to import and use custom models that I fine-tune myself, particularly small highly specialized models in roughly the 2-5B parameter range.

The system should be designed around ordinary hardware. A baseline target is about 16 GB RAM / 8 GB VRAM, with better concurrency and speed on systems with 32 GB RAM / 12-16 GB VRAM. Models that are not being used should not need to remain loaded. The runtime should eventually load and unload models as needed, checkpoint state, queue work, and expose hardware/resource usage.

A low-memory machine should be able to run the same topology mostly sequentially. A stronger machine should be able to keep more models resident and execute compatible work concurrently.

Conversation/work persistence should be configurable. When enabled for an agent/storage relationship, useful history should be written to the connected storage in a selected format. When disabled, transient conversation state can be discarded.

Storage nodes should be usable for project files, Git repositories, vector databases, document stores, long-term memory, and other RAG sources. Storage access must respect the topology.

The user must be able to pause ongoing work, modify the topology or instructions, and resume without throwing away already completed work.

The harness should expose what is happening: active agent, model residency, task state, queue state, memory/VRAM/RAM/CPU/GPU use where available, timing, context/token usage where available, tool calls, and results. The human user controls optimization. Do not build an autonomous topology optimizer.

## Existing work to study and reuse

Do not build every subsystem from scratch when mature open-source work already exists. Study these projects closely and reuse, integrate, adapt, or borrow architectural patterns where technically appropriate and license-compatible:

- Langflow: https://github.com/langflow-ai/langflow
  - especially its visual node editor, component system, agent/tool registration, MCP integration, tracing, checkpoint/HITL concepts, and local-model provider patterns
- React Flow / XYFlow: https://github.com/xyflow/xyflow
  - for the node-based Configure interface
- llama.cpp: https://github.com/ggml-org/llama.cpp
  - for efficient local inference and model lifecycle capabilities
- llama-swap: https://github.com/mostlygeek/llama-swap
  - for on-demand model loading/unloading and multi-model local serving ideas
- Open WebUI: https://github.com/open-webui/open-webui
  - for useful local chat/UI and local-model integration patterns
- MCP and A2A ecosystem implementations
  - use existing standards/protocols where they fit instead of inventing incompatible equivalents

Respect upstream licenses and preserve required notices/attribution. Prefer integration and adaptation over needless reinvention.

## Repository context

Read the repository documentation and architecture notes before implementation. They capture decisions already made about capability topology, model/agent separation, structured work orders, hardware-aware scheduling, and the intended product behavior.

Those documents are architectural context, not an instruction to stop after a tiny scaffold.

## Execution mandate

Take ownership of the implementation and drive it toward a **working end-to-end MVP**, not a sequence of five-minute demonstrations.

Make reasonable engineering decisions yourself. Research unfamiliar libraries or APIs when needed. Create the necessary architecture, frontend, local backend/runtime, persistence, tests, configuration, and documentation. Integrate existing open-source components when that is the better engineering choice.

Do not stop merely because one subsystem is large, because a design choice was not explicitly dictated, or because an intermediate milestone is complete. Continue through the next logical work until the application operates coherently end to end.

Only stop and ask for input when there is a genuine blocker that cannot be responsibly resolved from the product concept, repository context, existing code, or reasonable engineering judgment.

When tradeoffs are necessary, favor:
- local-first operation,
- consumer-hardware efficiency,
- modularity,
- model/backend agnosticism,
- clear hard capability boundaries,
- reuse of mature existing components,
- and a coherent working product over speculative abstractions.

Begin.
