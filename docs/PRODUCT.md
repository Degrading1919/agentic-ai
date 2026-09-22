# Product Definition

## Problem

General-purpose local AI systems often waste compute and context by giving large models broad knowledge, broad tool access, and persistent residency even when a task needs only a narrow specialist.

Agentic Harness explores the opposite design:

- smaller specialist models,
- explicit capability boundaries,
- structured delegation,
- dynamic loading/unloading,
- human-controlled topology optimization,
- and model-agnostic local storage/memory.

## User

Initial user: project owner / technical power user.

Possible future distribution: open-source GitHub project for technical users.

## Primary workflow

1. User opens Configure.
2. User adds/imports models, agents, tools, skills, connectors, and storage nodes.
3. User connects only the resources each agent is permitted to use.
4. User defines A2A relationship types between collaborating agents.
5. User saves the topology as a reusable template.
6. User switches to Work.
7. User gives a task to the orchestrator.
8. Runtime dispatches structured work orders to specialists as needed.
9. Scheduler loads/unloads models according to demand and hardware constraints.
10. User may pause, inspect, edit topology/prompting, and resume.

## First flagship use case

Build a separate small software application/game through a team of local specialist workers, for example:

- Orchestrator
- Runtime coder
- UI designer
- Game-systems/formula specialist
- 3D modeling specialist
- Reviewer/test specialist

The orchestrator should excel at planning, decomposition, dependency management, delegation, status tracking, and integration rather than being the strongest specialist in every domain.

## Quality evaluation

Potential external evaluation methods include:

- task-specific tests,
- human review/RLHF-style preference data,
- external judge models such as GPT-5.6 Sol that are not directly connected to the local application,
- artifact correctness checks,
- tool execution success/failure.

Automatic topology optimization is explicitly out of scope for the initial product philosophy.
