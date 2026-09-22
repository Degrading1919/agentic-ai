# ADR 001: Capability Topology

## Status

Accepted concept decision.

## Decision

The visual graph represents capability availability and communication permissions rather than prescribed execution order.

## Consequences

A visual edge must have a typed semantic meaning.

Examples:

- `agent_uses_model`
- `agent_can_use_capability`
- `agent_can_access_storage`
- `agent_can_delegate_to_agent`
- `agent_can_consult_agent`
- `agent_can_review_agent`
- `agent_reports_to_agent`
- `agent_can_handoff_to_agent`

Runtime execution should query this topology to determine what actions are legal.

The graph must not be compiled into a conventional DAG and executed from left to right/top to bottom.
