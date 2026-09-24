# Connecting MCP Servers and APIs

Connector nodes bring external tools into a topology. An agent can use a connector only when an edge connects it, and it sees only the tools that the connector's allowlist authorizes.

## MCP over Streamable HTTP

1. Add a **Connector** node and set **Connector type** to *MCP server* and **Transport** to *Streamable HTTP*.
2. Set **Endpoint**, for example `http://127.0.0.1:3333/mcp`.
3. If the server needs a bearer token, set an environment variable before starting Agentic Harness and put only its **name** in **Auth environment variable**.
4. Enable the connector, draw an edge from each agent that may use it, and click **Discover tools**.

## MCP over stdio (local process)

1. Set **Transport** to *Local process (stdio)*.
2. Set **Command** (for example `npx`, `uvx`, or an absolute executable path) and put **Arguments** one per line.
3. Enable the connector and click **Discover tools**.

The process runs with your user permissions, so only configure commands you trust. The optional auth variable is passed through to the process environment by name.

## What discovery does

Discovery connects with the official MCP TypeScript SDK, lists every tool (following pagination), and caches the catalog with a fingerprint of the connector configuration. The catalog records each tool's name, description, input schema, and `readOnlyHint`/`destructiveHint` annotations. When you change the endpoint, command, or arguments, the cached catalog stops applying and tools are rediscovered on first use.

The inspector then shows:

- the server name and version;
- every tool, with a **read** or **writes** badge;
- the approximate token cost of each tool's schema;
- a checkbox per tool. Unchecked tools are not authorized for any agent.

## How tools reach a model

Connecting 150 tools does not put 150 schemas into every request. Each agent's **Tool exposure** setting decides:

- **Auto** (default): send schemas directly when the agent has at most *Eager tool limit* tools and they are small; otherwise defer.
- **Eager**: always send every authorized schema.
- **Deferred**: send a compact catalog plus `find_tools` and `call_tool`. The worker searches the catalog, receives the schemas it needs, and invokes tools by name.

The agent's context card in Configure shows how many schemas are sent and how many tokens deferral saves. In Work, each model call's context frame reports `0/154 schemas · deferred` or similar.

## Local trust: read-only and retry-safe

MCP servers describe their tools with annotations such as `readOnlyHint`. Those are useful hints but not guarantees: a server can be stale, buggy, or untrusted. Agentic Harness therefore keeps its own decision per tool:

- **read-only**: the tool only reads. Only tools marked read-only are available to consult and review work.
- **retry-safe**: repeating the call with the same operation ID is harmless. After an interruption, retry-safe calls are repeated automatically; others pause the run for reconciliation.

Each decision is pinned to the tool's definition hash (name, description, schema, annotations). If the server changes the tool, the decision lapses (the inspector shows **changed**) and the tool is treated as an unreviewed write tool until you review it again. **Trust the server's read-only hints** copies the annotations into local decisions in one explicit step.

This controls what the harness exposes, not what the server does: a server can change behavior without changing its advertised definition. For a hard read-only guarantee, connect a read-only credential or a separate read-only server.

## Freshness and identity

- A catalog is re-verified before use after **Catalog re-verify after (ms)** (default 10 minutes), after a restart, or when the credential in the auth variable changes. Changes are recorded as `catalog_changed` events.
- Changing the endpoint, command, arguments, or credential closes the old session; credentials are compared by an in-memory digest and never stored.
- A call is refused if the tool's current definition differs from the one the worker was shown.

## Limits on untrusted servers

Messages are capped at 4 MB before they are parsed (stdio and HTTP). Catalogs accept at most 512 tools, valid names, schemas up to 32 KB / depth 16 / 2,000 nodes, and 2 MB in total; other tools are listed as rejected and never authorized. Results are truncated to **Max result chars**.

## Effects and reconciliation

Every call is recorded with an operation ID. HTTP connectors send it as `Idempotency-Key`; MCP calls include it in `_meta`. Enable **Server honours Idempotency-Key** on an HTTP connector only when the service deduplicates by that header: POST/PATCH then become safe to retry. When a non-retry-safe call is interrupted, the run pauses and Work shows a **Needs reconciliation** panel: check the external system and record whether it took effect.

## Read-only work

Consult and review orders run read-only. They receive only MCP tools locally marked read-only for their current definition, only GET for HTTP APIs, and no storage write tools.

## HTTP APIs

Set **Connector type** to *HTTP API*, set **Base URL**, and choose the allowed methods. The agent receives one request tool. Paths must be relative, and requests that resolve outside the base URL (other hosts, `..`, protocol-relative URLs) are refused. Responses are truncated to **Max result chars**.

## Troubleshooting

- **"Could not connect…"**: for stdio, the last lines of the process's stderr are included in the error. Check that the command runs from a terminal.
- **Tools missing for an agent**: confirm the edge exists, the connector is enabled, the tool is checked in the allowlist, and, for consult or review work, that the tool is annotated read-only.
- **Discovery works but runs show no MCP tools**: the configuration may have changed since discovery. Discover again or start a run; enabled connectors are rediscovered automatically.
