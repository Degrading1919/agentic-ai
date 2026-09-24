# ADR 008: Operational Relationship Semantics

## Status

Accepted and implemented. Supersedes the MVP behaviour, in which every relationship produced an identical child order.

## Decision

Each relationship has distinct ownership, blocking, access, and return behaviour:

| | Owner of the outcome | Blocks the requester | Access | Returns |
| --- | --- | --- | --- | --- |
| Delegate | Sender (unchanged) | Yes | Full | Work product integrated by the sender; may be revised after review |
| Consult | Sender (unchanged) | No (failure is tolerated) | Read-only | Advice, planned or inline via `consult_agent` |
| Review | Sender (unchanged) | Yes; depends on its subject | Read-only | Structured verdict; `revise` triggers bounded revisions |
| Handoff | Receiver | Replaces the source order | Full | Receiver inherits the source's parent and return path |
| Report | n/a | No | n/a | Status delivered to the target's inbox; no inference |

Planning is bounded: a model plan is validated against actual edges and capped by `maxDelegations`, collaborators on the order's own chain are excluded, and the fallback selects by relevance and defaults to direct work. Plans record both selected and available collaborators so users can see what was skipped.

## Consequences

- Multi-agent fan-out happens only when it adds value. Every extra worker is visible, with its context cost, in Work.
- The domain model (work orders with owner, dependencies, subjects, handoff links, verdicts) maps directly onto A2A tasks and artifacts if a cross-process transport is added later.
- Nested delegation is limited to depth 2 and handoff chains to 3, which prevents runaway recursion while cyclic topologies remain legal.
