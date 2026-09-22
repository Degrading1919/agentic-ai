# Task 001: Build the End-to-End MVP

## Objective

Take the current Agentic Harness concept and build the first coherent, usable end-to-end version of the software.

Do not stop at a UI mockup or architecture scaffold. The goal is to make the concept real enough that the full loop can be exercised locally.

## Product concept

The application is a local-first visual agent orchestration environment with two views:

- **Work**: a familiar AI chat/work interface.
- **Configure**: a visual capability-topology editor.

The Configure graph defines which agents can access which models, tools, skills, MCP/API/connector resources, storage systems, and other agents. Edges are permissions/capabilities/relationships, not prescribed execution order.

Agents are specialized workers that communicate through structured work orders. Models and agents are separate concepts so custom user-trained models can be swapped and reused.

The runtime should be designed for consumer hardware, including machines around 16 GB RAM / 8 GB VRAM, by loading models only when needed, unloading idle models, queuing work, and allowing sequential operation when concurrency is not practical.

## Required MVP capabilities

Build enough of the system that a user can:

- install and run the application locally;
- switch between Work and Configure;
- create, edit, connect, save, and reload a capability topology;
- represent Models, Agents, Tools/Capabilities, Skills, MCP/API/Connector resources, and Storage;
- define typed A2A relationships such as delegate, consult, review, report, and handoff;
- enforce hard topology boundaries so disconnected capabilities are unavailable;
- configure an agent with a model and permitted resources;
- connect at least one practical local inference path;
- send a task from Work into the configured system;
- create and route structured work orders;
- execute at least a basic orchestrator-to-specialist flow;
- persist useful task state and outputs;
- demonstrate model lifecycle/resource handling appropriate to local hardware;
- inspect runtime state sufficiently to understand what the system is doing;
- pause/resume work in a way that preserves completed state;
- document how to run, configure, and extend the MVP.

Use the simplest robust implementation that proves the complete concept. It is acceptable for some integrations or advanced options to remain extensible rather than exhaustive, but the main user journey must actually work.

## Reuse existing work

Before reinventing infrastructure, study and use established open-source projects where appropriate:

- https://github.com/langflow-ai/langflow
- https://github.com/xyflow/xyflow
- https://github.com/ggml-org/llama.cpp
- https://github.com/mostlygeek/llama-swap
- https://github.com/open-webui/open-webui

Also use existing MCP/A2A standards and libraries where they fit.

Respect all licenses and attribution requirements.

## Working style

Drive this task to completion without pausing after every subsystem.

Make reasonable architecture and implementation decisions yourself. Research dependencies as needed. Add tests and documentation as the product develops. If one approach proves unsuitable, adjust and continue.

Only ask for user input when a genuine blocker cannot be resolved responsibly from the repository context, available open-source references, or sound engineering judgment.

The definition of done is a coherent local MVP demonstrating the full concept, not merely a completed checklist of isolated components.

## Implementation status

Completed on 2026-09-22. The repository now includes the visual Configure editor, Work console, durable local runtime, structured orchestrator-to-specialist execution, topology enforcement, model lifecycle scheduling, pause/resume support, tests, and local-inference documentation described above. The deterministic mock provider keeps the full flow runnable without external services; an OpenAI-compatible provider and llama-swap lifecycle hooks support practical local models.
