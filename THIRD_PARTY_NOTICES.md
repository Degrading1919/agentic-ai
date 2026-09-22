# Third-Party Notices

Agentic Harness is MIT licensed. Its JavaScript dependencies retain their own licenses as distributed by their package publishers.

Direct runtime dependencies include:

| Project | Use | License |
| --- | --- | --- |
| React / React DOM | User interface | MIT |
| React Flow (`@xyflow/react`) | Configure node canvas | MIT |
| Fastify / `@fastify/static` | Local API and static server | MIT |
| Zod | Runtime schema validation | MIT |
| Lucide | Interface icons | ISC |
| react-markdown | Safe Markdown rendering | MIT |

Development dependencies include Vite, Vitest, TypeScript, tsx, tsup, and concurrently under their respective open-source licenses.

The following projects were studied for architecture and interoperability patterns. Their source code is not vendored or copied into this repository:

- [Langflow](https://github.com/langflow-ai/langflow) — visual components, agent and tool registration, tracing, and checkpoint concepts
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — local inference, OpenAI-compatible serving, function calling, schema output, and hardware controls
- [llama-swap](https://github.com/mostlygeek/llama-swap) — model-ID routing, on-demand process lifecycle, TTL eviction, and runtime inspection
- [Open WebUI](https://github.com/open-webui/open-webui) — local model user experience and provider separation patterns
- [Model Context Protocol](https://github.com/modelcontextprotocol/modelcontextprotocol) — connector interoperability direction
- [Agent2Agent Protocol](https://github.com/a2aproject/A2A) — structured cross-agent interoperability direction

Any future source reuse must be reviewed against the exact upstream version and license, and required notices must be added at that time.
