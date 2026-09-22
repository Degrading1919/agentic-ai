# Task 001: Configure + Work Application Shell

## Goal

Create the first runnable application vertical slice that proves the user experience and domain semantics without implementing model inference.

## Scope

Build a local desktop-oriented frontend with two top-level views:

### Work

A minimal AI chat/work shell containing:

- conversation area,
- user input composer,
- send button,
- placeholder assistant response behavior only,
- clear indication that inference is not yet connected.

Do not integrate an LLM in this task.

### Configure

Build a node-based editor using React + TypeScript and `@xyflow/react`.

The initial canvas must support these node categories:

1. Model
2. Agent
3. Capability
4. Skill
5. Connector
6. Storage

Use clearly distinct visual treatments for each category. Exact final branding is not required.

## Critical graph rule

Edges represent **availability/permission**, not execution flow.

Do not implement automatic DAG execution.

## Required interactions

- Add node from a simple palette.
- Drag/reposition nodes.
- Connect compatible nodes.
- Delete nodes and edges.
- Select a node and edit basic metadata in an inspector panel.
- Switch between Configure and Work without losing graph state.
- Save/load graph state locally using a simple temporary persistence mechanism suitable for the prototype.

## Initial typed domain model

Create explicit TypeScript types for node and edge domain data rather than storing arbitrary UI-only objects.

Suggested node kinds:

```ts
type NodeKind =
  | 'model'
  | 'agent'
  | 'capability'
  | 'skill'
  | 'connector'
  | 'storage';
```

Suggested relationship kinds should include at least:

```ts
type RelationshipKind =
  | 'uses_model'
  | 'can_use'
  | 'can_access'
  | 'delegate'
  | 'consult'
  | 'review'
  | 'report'
  | 'handoff';
```

The implementation may refine names, but preserve these semantics.

## Validation rules for the prototype

At minimum:

- Agent -> Model may use `uses_model`.
- Agent -> Capability/Skill/Connector may use `can_use`.
- Agent -> Storage may use `can_access`.
- Agent -> Agent may use one of the defined A2A relationship types.
- Invalid connection categories should be rejected or clearly flagged.

Do not over-engineer permissions yet.

## Recommended initial stack

Use:

- React
- TypeScript
- Vite
- `@xyflow/react`

A Tauri 2 shell is acceptable and preferred if it does not materially slow the task. If Tauri setup becomes the dominant work, keep the first implementation browser-runnable and document the packaging follow-up instead.

Do not add Electron.

## Explicit non-goals

Do not implement:

- LLM inference,
- custom model loading,
- llama.cpp/Ollama/LM Studio/vLLM integration,
- training/fine-tuning,
- MCP runtime,
- A2A network transport,
- vector databases,
- scheduler/model residency logic,
- GPU telemetry,
- automatic topology optimization,
- autonomous graph modification.

## Acceptance criteria

1. Project runs locally with documented commands.
2. User can switch between Work and Configure views.
3. Configure view presents a usable node canvas.
4. All six initial node categories can be created.
5. Supported relationship types are represented in typed application state.
6. Invalid basic node relationships cannot silently create valid-looking edges.
7. Graph state survives view switching and can be saved/reloaded locally.
8. No edge is interpreted as sequential execution.
9. README contains setup/run instructions.
10. Basic tests cover connection validation/domain rules.

## Deliverable

Open a focused PR for Task 001 only. Include screenshots of both views in the PR description if practical.
