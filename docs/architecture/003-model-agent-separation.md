# ADR 003: Model and Agent Are Separate Concepts

## Status

Accepted concept decision.

## Model

Represents a deployable model artifact and associated metadata, eventually including items such as:

- model family / architecture,
- weights location,
- tokenizer,
- quantization,
- context limit,
- inference compatibility,
- training lineage/version,
- estimated memory characteristics.

Custom user-trained/fine-tuned models are first-class.

## Agent

Represents a specialized worker that uses a model and knows when/how to invoke its connected capabilities.

An Agent may include or reference:

- assigned Model,
- worker specialization,
- operational instructions,
- A2A permissions,
- tool/capability permissions,
- storage permissions,
- persistence behavior.

This separation allows an agent configuration to swap model versions without rebuilding the topology and allows compatible models to support multiple worker definitions.
