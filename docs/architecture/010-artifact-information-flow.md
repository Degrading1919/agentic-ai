# ADR 010: Artifact Information-Flow Policy

## Status

Accepted and implemented. Resolves audit finding A2.

## Context

`read_artifact` lets a worker fetch full results that its context carries only as summaries. It resolved any order ID in the run or its thread. Order IDs appear in prompts, reports and results, so knowing an ID is not authorization.

## Decision

`resolveArtifact(run, requestingOrder, id, threadRoots)` in `src/server/artifact-policy.ts` grants access only through these relationships:

| Grant | Readable |
| --- | --- |
| self | the order's own draft or result |
| revision | earlier versions the order revises |
| handoff | orders the order took over |
| dependency | declared dependencies, resolved through handoffs |
| subject | orders it reviews (including a draft under review), resolved through handoffs |
| child | its own children, once they returned (terminal) |
| review | reviews of the order or of a version it revises |
| tool | results of tool calls the order made (`tool:<operation id>`) |
| thread | root-chain orders only: prior-run roots listed in the thread digest |

Output of an unfinished order is never readable, except a draft that is the declared subject of a review. Denials return an explanation to the worker and are recorded as `topology_boundary` events.

## Consequences

- Information moves along the same relationships that create work, so the topology is an information boundary as well as a capability boundary.
- Consultants and reviewers cannot read siblings, and a follow-up thread cannot read a previous run's internal specialist orders.
- The policy is a pure function over run state and is unit-tested independently of the runtime.
