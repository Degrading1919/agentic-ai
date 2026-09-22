# Codex Start Prompt

Read `AGENTS.md`, `README.md`, all files in `docs/architecture/`, and `tasks/001-configure-work-shell.md` before making changes.

Implement **Task 001: Configure + Work Application Shell** exactly as scoped.

Important constraints:

- The graph is a capability/permission topology, not an execution DAG.
- Do not integrate any model inference backend yet.
- Keep model and agent as distinct domain concepts.
- Use typed node/relationship domain models.
- Implement basic validation so invalid relationship categories are rejected or visibly invalid.
- Prefer React + TypeScript + Vite + `@xyflow/react`.
- Tauri 2 is preferred only if it does not dominate the task; otherwise keep the first vertical slice browser-runnable and document Tauri as a follow-up.
- Do not use Electron.
- Add tests for graph connection validation.
- Keep the work tightly scoped to Task 001.

Before coding, briefly state the implementation plan and any architectural assumptions. Then implement, run tests/build checks, and summarize the result and any follow-up decisions that Task 001 exposed.
