# ADR 004: Structured Work Orders

## Status

Accepted concept decision.

Agents behave as specialized workers rather than conversational personalities.

A2A communication should use structured work objects. The final protocol may align with or extend A2A, but the domain model should support at least:

- task ID,
- sender,
- assignee,
- objective,
- required inputs,
- constraints,
- allowed resources,
- dependencies,
- expected output/artifact,
- output location,
- priority,
- status,
- return-to relationship.

Natural-language task content may exist inside this envelope, but the envelope itself must be machine-readable.
