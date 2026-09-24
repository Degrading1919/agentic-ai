import { useState } from "react";
import { Beaker, Check, FileSearch, Link2, LoaderCircle, Plus, Radar, Trash2 } from "lucide-react";
import type {
  AgentNode,
  ConnectorCatalog,
  ConnectorNode,
  ModelNode,
  RelationshipKind,
  StorageNode,
  TopologyEdge,
  TopologyNode,
} from "../../shared/contracts.js";
import type { AgentFootprint } from "../../shared/prompt.js";
import { trustFor } from "../../shared/capabilities.js";
import { estimateJsonTokens, estimateTokens, formatTokens } from "../../shared/tokens.js";
import {
  collaborationKinds,
  relationName,
  relationshipDescriptions,
  relationshipLabels,
} from "../../shared/topology.js";
import { api } from "../api.js";
import { nodeMeta } from "../node-meta.js";
import { ContextBar } from "./ContextBar.js";

type Props = {
  node: TopologyNode | null;
  edge: TopologyEdge | null;
  sourceNode: TopologyNode | null;
  targetNode: TopologyNode | null;
  footprint: AgentFootprint | null;
  catalog: ConnectorCatalog | null;
  onUpdateNode: (node: TopologyNode) => void;
  onUpdateEdge: (edge: TopologyEdge) => void;
  onDelete: () => void;
  onTestModel: (node: TopologyNode) => Promise<{ ok: boolean; message: string }>;
  onDiscover: (node: TopologyNode) => Promise<ConnectorCatalog | null>;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  step?: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input type="number" min={min} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="inspector-section">
      <div className="section-label">{title}</div>
      {children}
    </div>
  );
}

function FootprintCard({ footprint }: { footprint: AgentFootprint }) {
  return (
    <div className="footprint-card">
      <div className="footprint-head">
        <span>Stable context per request</span>
        <strong>≈{formatTokens(footprint.stableTokens)}</strong>
      </div>
      <ContextBar
        segments={footprint.segments}
        window={footprint.contextWindow}
        reserved={footprint.reservedOutputTokens}
      />
      <div className="footprint-facts">
        <span>{footprint.authorizedTools} authorized tools</span>
        <span>{footprint.exposedToolSchemas} schemas sent · {footprint.exposure}</span>
        {footprint.deferredSchemaTokens > 0 && <span className="saving">≈{formatTokens(footprint.deferredSchemaTokens)} schema tokens deferred</span>}
      </div>
      <small>
        Estimated before any work-order payload. The same prefix is sent unchanged on every call so prefix/KV caches can reuse it.
      </small>
    </div>
  );
}

function AgentFields({ node, footprint, onUpdate }: { node: AgentNode; footprint: AgentFootprint | null; onUpdate: (node: TopologyNode) => void }) {
  const set = (patch: Partial<AgentNode["config"]>) => onUpdate({ ...node, config: { ...node.config, ...patch } });
  return (
    <>
      {footprint && <FootprintCard footprint={footprint} />}
      <Field label="Worker role"><input value={node.config.role} onChange={(event) => set({ role: event.target.value })} /></Field>
      <Field label="Operating instructions"><textarea rows={6} value={node.config.instructions} onChange={(event) => set({ instructions: event.target.value })} /></Field>
      <Toggle label="Available in Work" checked={node.config.entrypoint} onChange={(entrypoint) => set({ entrypoint })} />
      <Toggle label="Plan connected delegations" checked={node.config.autoDelegate} onChange={(autoDelegate) => set({ autoDelegate })} />
      <Section title="Context & tools">
        <Field
          label="Tool exposure"
          hint="Edges authorize tools. Exposure decides how their schemas enter context: deferred sends a catalog plus find_tools/call_tool."
        >
          <select value={node.config.toolExposure} onChange={(event) => set({ toolExposure: event.target.value as AgentNode["config"]["toolExposure"] })}>
            <option value="auto">Auto (eager when small)</option>
            <option value="eager">Eager — send every schema</option>
            <option value="deferred">Deferred — discover on demand</option>
          </select>
        </Field>
        <div className="field-pair">
          <NumberField label="Eager tool limit" min={0} value={node.config.eagerToolLimit} onChange={(eagerToolLimit) => set({ eagerToolLimit })} />
          <NumberField label="Tool iterations" min={1} value={node.config.maxToolIterations} onChange={(maxToolIterations) => set({ maxToolIterations })} />
        </div>
        <NumberField
          label="Max delegations per plan"
          min={0}
          value={node.config.maxDelegations}
          hint="Caps fan-out. Every extra worker costs inference, context, and latency."
          onChange={(maxDelegations) => set({ maxDelegations })}
        />
      </Section>
      <Field label="Conversation persistence">
        <select value={node.config.conversationPersistence} onChange={(event) => set({ conversationPersistence: event.target.value as "transient" | "connected-storage" })}>
          <option value="connected-storage">Connected storage</option><option value="transient">Transient</option>
        </select>
      </Field>
      <div className="field-pair">
        <NumberField label="Temperature" min={0} step={0.1} value={node.config.temperature} onChange={(temperature) => set({ temperature })} />
        <NumberField label="Max output" min={64} step={64} value={node.config.maxOutputTokens} onChange={(maxOutputTokens) => set({ maxOutputTokens })} />
      </div>
    </>
  );
}

function ModelFields({ node, onUpdate, onTest }: { node: ModelNode; onUpdate: (node: TopologyNode) => void; onTest: (node: TopologyNode) => Promise<{ ok: boolean; message: string }> }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<{ ok: boolean; message: string } | null>(null);
  const set = (patch: Partial<ModelNode["config"]>) => onUpdate({ ...node, config: { ...node.config, ...patch } });
  const artifact = node.config.artifact;
  const setArtifact = (patch: Partial<ModelNode["config"]["artifact"]>) => set({ artifact: { ...artifact, ...patch } });
  const isMock = node.config.provider === "mock";

  const test = async () => {
    setTesting(true);
    try {
      setTestResult(await onTest(node));
    } finally {
      setTesting(false);
    }
  };

  const inspect = async () => {
    setInspecting(true);
    setInspectResult(null);
    try {
      const result = await api.inspectModel(artifact.path, {
        contextWindow: node.config.contextWindow,
        gpuLayers: artifact.gpuLayers,
        parallelSlots: node.config.parallelSlots,
      });
      set({
        estimatedMemoryMb: result.estimatedMemoryMb,
        estimatedVramMb: result.estimatedVramMb,
        artifact: {
          ...artifact,
          format: "gguf",
          architecture: result.architecture,
          parameterLabel: result.parameterLabel,
          quantization: result.quantization,
          trainedContextLength: result.trainedContextLength,
          baseModel: artifact.baseModel || result.baseModel,
        },
      });
      setInspectResult({
        ok: true,
        message: `${result.name}: ${result.architecture} ${result.parameterLabel} ${result.quantization} · ≈${result.estimatedMemoryMb} MB RAM, ≈${result.estimatedVramMb} MB VRAM${result.isAdapter ? " · LoRA adapter" : ""}. ${result.assumptions}`,
      });
    } catch (error) {
      setInspectResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setInspecting(false);
    }
  };

  return (
    <>
      <Field label="Provider">
        <select value={node.config.provider} onChange={(event) => set({ provider: event.target.value as ModelNode["config"]["provider"] })}>
          <option value="mock">Built-in demo</option><option value="openai-compatible">OpenAI compatible</option>
        </select>
      </Field>
      <Field label="Model ID"><input value={node.config.modelId} onChange={(event) => set({ modelId: event.target.value })} /></Field>
      <Field label="Base URL" hint="llama.cpp defaults to http://127.0.0.1:8080/v1"><input disabled={isMock} value={node.config.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} /></Field>
      <Field label="API key environment variable"><input disabled={isMock} placeholder="Optional; secret never enters the topology" value={node.config.apiKeyEnv} onChange={(event) => set({ apiKeyEnv: event.target.value })} /></Field>
      <Field label="Lifecycle">
        <select disabled={isMock} value={node.config.lifecycle} onChange={(event) => set({ lifecycle: event.target.value as "logical" | "llama-swap" })}>
          <option value="logical">Externally managed / logical</option><option value="llama-swap">llama-swap managed</option>
        </select>
      </Field>
      <button className="test-button" onClick={() => void test()} disabled={testing}>
        {testing ? <LoaderCircle className="spin" size={14} /> : <Beaker size={14} />} Test connection
      </button>
      {testResult && <div className={`test-result ${testResult.ok ? "ok" : "failed"}`}>{testResult.ok && <Check size={13} />}{testResult.message}</div>}

      <Section title="Resources & scheduling">
        <div className="field-pair">
          <NumberField label="Context" min={512} value={node.config.contextWindow} onChange={(contextWindow) => set({ contextWindow })} />
          <NumberField label="Parallel slots" min={1} value={node.config.parallelSlots} onChange={(parallelSlots) => set({ parallelSlots })} />
        </div>
        <div className="field-pair">
          <NumberField label="Est. RAM MB" min={0} value={node.config.estimatedMemoryMb} onChange={(estimatedMemoryMb) => set({ estimatedMemoryMb })} />
          <Field label="Est. VRAM MB" hint={isMock ? undefined : "Empty = unknown: the scheduler reserves the whole GPU budget. 0 = CPU only."}>
            <input
              type="number"
              min={0}
              placeholder="unknown"
              value={node.config.estimatedVramMb ?? ""}
              onChange={(event) => set({ estimatedVramMb: event.target.value === "" ? null : Number(event.target.value) })}
            />
          </Field>
        </div>
        <div className="field-pair">
          <NumberField label="Idle TTL ms" min={0} value={node.config.idleTtlMs} onChange={(idleTtlMs) => set({ idleTtlMs })} />
          <NumberField label="Timeout ms" min={1000} value={node.config.requestTimeoutMs} onChange={(requestTimeoutMs) => set({ requestTimeoutMs })} />
        </div>
      </Section>

      <Section title="Model artifact">
        <Field label="Artifact path" hint="Local GGUF used for llama-swap config and memory estimates.">
          <input placeholder="C:\\models\\specialist.Q4_K_M.gguf" value={artifact.path} onChange={(event) => setArtifact({ path: event.target.value })} />
        </Field>
        <button className="test-button" disabled={!artifact.path || inspecting} onClick={() => void inspect()}>
          {inspecting ? <LoaderCircle className="spin" size={14} /> : <FileSearch size={14} />} Inspect GGUF
        </button>
        {inspectResult && <div className={`test-result ${inspectResult.ok ? "ok" : "failed"}`}>{inspectResult.ok && <Check size={13} />}{inspectResult.message}</div>}
        <div className="field-pair">
          <Field label="Architecture"><input value={artifact.architecture} onChange={(event) => setArtifact({ architecture: event.target.value })} /></Field>
          <Field label="Quantization"><input value={artifact.quantization} onChange={(event) => setArtifact({ quantization: event.target.value })} /></Field>
        </div>
        <div className="field-pair">
          <Field label="Parameters"><input placeholder="3B" value={artifact.parameterLabel} onChange={(event) => setArtifact({ parameterLabel: event.target.value })} /></Field>
          <Field label="Version"><input placeholder="v1" value={artifact.version} onChange={(event) => setArtifact({ version: event.target.value })} /></Field>
        </div>
        <Field label="Base model / lineage"><input placeholder="Foundation model this specialist was tuned from" value={artifact.baseModel} onChange={(event) => setArtifact({ baseModel: event.target.value })} /></Field>
        <NumberField label="GPU layers (-1 = server default)" min={-1} value={artifact.gpuLayers} onChange={(gpuLayers) => setArtifact({ gpuLayers })} />
        <div className="adapter-list">
          <span className="inspector-field-label">LoRA adapters</span>
          {artifact.adapters.map((adapter, index) => (
            <div className="adapter-row" key={index}>
              <input value={adapter.path} placeholder="adapter.gguf" onChange={(event) => setArtifact({ adapters: artifact.adapters.map((item, i) => (i === index ? { ...item, path: event.target.value } : item)) })} />
              <input type="number" step={0.1} min={0} value={adapter.scale} onChange={(event) => setArtifact({ adapters: artifact.adapters.map((item, i) => (i === index ? { ...item, scale: Number(event.target.value) } : item)) })} />
              <button className="icon-button" title="Remove adapter" onClick={() => setArtifact({ adapters: artifact.adapters.filter((_, i) => i !== index) })}><Trash2 size={12} /></button>
            </div>
          ))}
          <button className="secondary-button small" onClick={() => setArtifact({ adapters: [...artifact.adapters, { path: "adapter.gguf", scale: 1 }] })}><Plus size={12} /> Add adapter</button>
        </div>
        <Field label="Notes"><textarea rows={2} value={artifact.notes} onChange={(event) => setArtifact({ notes: event.target.value })} /></Field>
      </Section>
    </>
  );
}

function ConnectorFields({
  node,
  catalog,
  onUpdate,
  onDiscover,
}: {
  node: ConnectorNode;
  catalog: ConnectorCatalog | null;
  onUpdate: (node: TopologyNode) => void;
  onDiscover: (node: TopologyNode) => Promise<ConnectorCatalog | null>;
}) {
  const [discovering, setDiscovering] = useState(false);
  const set = (patch: Partial<ConnectorNode["config"]>) => onUpdate({ ...node, config: { ...node.config, ...patch } });
  const mcp = node.config.connectorType === "mcp";
  const stdio = mcp && node.config.transport === "stdio";
  const allowlist = new Set(node.config.toolAllowlist);
  const allowed = (name: string) => allowlist.size === 0 || allowlist.has(name);
  const toggleTool = (name: string, enabled: boolean) => {
    const all = catalog?.tools.map((tool) => tool.name) ?? [];
    const current = allowlist.size === 0 ? new Set(all) : new Set(allowlist);
    if (enabled) current.add(name);
    else current.delete(name);
    // An allowlist equal to the full catalog is stored as "all".
    set({ toolAllowlist: current.size === all.length ? [] : [...current].sort() });
  };
  /** Local trust is pinned to the definition hash the user is looking at. */
  const setTrust = (tool: { name: string; schemaHash: string }, patch: { access?: "read" | "write"; idempotent?: boolean }) => {
    const existing = node.config.trustPolicies.find((policy) => policy.name === tool.name);
    const next = {
      name: tool.name,
      access: patch.access ?? (existing?.schemaHash === tool.schemaHash ? existing.access : "write"),
      idempotent: patch.idempotent ?? (existing?.schemaHash === tool.schemaHash ? existing.idempotent : false),
      schemaHash: tool.schemaHash,
    };
    const others = node.config.trustPolicies.filter((policy) => policy.name !== tool.name);
    set({
      trustPolicies:
        next.access === "write" && !next.idempotent ? others : [...others, next].sort((a, b) => a.name.localeCompare(b.name)),
    });
  };
  const adoptServerHints = () => {
    if (!catalog) return;
    const hinted = catalog.tools.filter((tool) => tool.readOnly);
    const others = node.config.trustPolicies.filter((policy) => !hinted.some((tool) => tool.name === policy.name));
    set({
      trustPolicies: [
        ...others,
        ...hinted.map((tool) => ({ name: tool.name, access: "read" as const, idempotent: false, schemaHash: tool.schemaHash })),
      ].sort((a, b) => a.name.localeCompare(b.name)),
    });
  };

  return (
    <>
      <Field label="Connector type">
        <select value={node.config.connectorType} onChange={(event) => set({ connectorType: event.target.value as "mcp" | "http-api" })}>
          <option value="mcp">MCP server</option><option value="http-api">HTTP API</option>
        </select>
      </Field>
      {mcp && (
        <Field label="Transport">
          <select value={node.config.transport} onChange={(event) => set({ transport: event.target.value as "streamable-http" | "stdio" })}>
            <option value="streamable-http">Streamable HTTP</option><option value="stdio">Local process (stdio)</option>
          </select>
        </Field>
      )}
      {stdio ? (
        <>
          <Field label="Command" hint="Runs locally with your user permissions when the connector is enabled."><input placeholder="npx" value={node.config.command} onChange={(event) => set({ command: event.target.value })} /></Field>
          <Field label="Arguments (one per line)"><textarea rows={3} value={node.config.args.join("\n")} onChange={(event) => set({ args: event.target.value.split("\n").filter((line) => line.length > 0) })} /></Field>
        </>
      ) : (
        <Field label={mcp ? "Endpoint" : "Base URL"}><input value={node.config.endpoint} onChange={(event) => set({ endpoint: event.target.value })} /></Field>
      )}
      <Field label="Auth environment variable" hint="Sent as a bearer token (or passed to the process); never stored."><input value={node.config.authEnv} onChange={(event) => set({ authEnv: event.target.value })} /></Field>
      {!mcp && (
        <div className="method-grid">
          {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) => (
            <Toggle
              key={method}
              label={method}
              checked={node.config.allowedMethods.includes(method)}
              onChange={(checked) =>
                set({ allowedMethods: checked ? [...node.config.allowedMethods, method] : node.config.allowedMethods.filter((item) => item !== method) })
              }
            />
          ))}
        </div>
      )}
      <div className="field-pair">
        <NumberField label="Timeout ms" min={1000} value={node.config.timeoutMs} onChange={(timeoutMs) => set({ timeoutMs })} />
        <NumberField label="Max result chars" min={256} value={node.config.maxResultChars} onChange={(maxResultChars) => set({ maxResultChars })} />
      </div>
      {!mcp && (
        <Toggle
          label="Server honours Idempotency-Key (POST/PATCH safe to retry)"
          checked={node.config.honorsIdempotencyKey}
          onChange={(honorsIdempotencyKey) => set({ honorsIdempotencyKey })}
        />
      )}
      {mcp && (
        <NumberField
          label="Catalog re-verify after (ms)"
          min={10_000}
          value={node.config.catalogTtlMs}
          hint="Tools are re-listed and compared with the stored catalog after this interval or a credential change."
          onChange={(catalogTtlMs) => set({ catalogTtlMs })}
        />
      )}
      <Toggle label="Enabled" checked={node.config.enabled} onChange={(enabled) => set({ enabled })} />

      {mcp && (
        <Section title="Tool catalog">
          <button
            className="test-button"
            disabled={discovering || !node.config.enabled}
            title={node.config.enabled ? "Connect and list tools" : "Enable the connector first"}
            onClick={async () => {
              setDiscovering(true);
              try {
                await onDiscover(node);
              } finally {
                setDiscovering(false);
              }
            }}
          >
            {discovering ? <LoaderCircle className="spin" size={14} /> : <Radar size={14} />} Discover tools
          </button>
          {catalog?.error && <div className="test-result failed">{catalog.error}</div>}
          {catalog && !catalog.error && (
            <div className="catalog">
              <div className="catalog-head">
                <span>{catalog.serverName || "MCP server"} {catalog.serverVersion}</span>
                <span>{catalog.tools.filter((tool) => allowed(tool.name)).length}/{catalog.tools.length} authorized</span>
              </div>
              <div className="catalog-list">
                {catalog.tools.map((tool) => {
                  const trust = trustFor(node, tool);
                  return (
                    <div key={tool.name} className="catalog-tool" title={tool.description}>
                      <input type="checkbox" aria-label={`Authorize ${tool.name}`} checked={allowed(tool.name)} onChange={(event) => toggleTool(tool.name, event.target.checked)} />
                      <span>{tool.name}</span>
                      <span className="trust-controls">
                        <button
                          className={`trust-chip ${trust.status === "trusted" && trust.access === "read" ? "on" : ""}`}
                          title="Local decision: this tool only reads. Required for consult/review use."
                          onClick={() => setTrust(tool, { access: trust.status === "trusted" && trust.access === "read" ? "write" : "read" })}
                        >
                          read-only
                        </button>
                        <button
                          className={`trust-chip ${trust.status === "trusted" && trust.idempotent ? "on" : ""}`}
                          title="Local decision: repeating this call with the same operation ID is safe. Otherwise an interrupted call needs reconciliation."
                          onClick={() => setTrust(tool, { idempotent: !(trust.status === "trusted" && trust.idempotent) })}
                        >
                          retry-safe
                        </button>
                        {trust.status === "drifted" && <em className="destructive" title="The server changed this tool since you reviewed it. Local trust no longer applies.">changed</em>}
                        {tool.readOnly && <em className="hint" title="The server claims this tool is read-only. Advisory only.">server: read</em>}
                      </span>
                      <small>{formatTokens(estimateJsonTokens({ name: tool.name, description: tool.description, parameters: tool.inputSchema }))}</small>
                    </div>
                  );
                })}
              </div>
              {catalog.rejectedTools.length > 0 && (
                <div className="catalog-rejected">
                  <strong>{catalog.rejectedTools.length} tool{catalog.rejectedTools.length === 1 ? "" : "s"} rejected by local limits</strong>
                  {catalog.rejectedTools.slice(0, 8).map((item) => (
                    <span key={item.name + item.reason}>{item.name}: {item.reason}</span>
                  ))}
                </div>
              )}
              {catalog.tools.some((tool) => tool.readOnly) && (
                <button className="secondary-button small" onClick={adoptServerHints}>Trust the server's read-only hints for these definitions</button>
              )}
              <small className="catalog-note">
                Unchecked tools are not authorized. Server annotations are advisory: only tools you mark read-only are available to consult and review work, and only retry-safe tools are repeated automatically after an interruption. Marks are pinned to the current definition and lapse if the server changes it. Revision {catalog.revision.slice(0, 8) || "n/a"}.
              </small>
            </div>
          )}
        </Section>
      )}
    </>
  );
}

const storageHints: Record<StorageNode["config"]["storageType"], string> = {
  "artifact-store": "Folder name under the harness data directory.",
  "project-files": "Absolute path to a project, or a folder name under the harness workspace.",
  git: "Absolute path to a repository (files adapter; no commits are made).",
  memory: "Memory namespace. Notes are stored as local JSONL and retrieved with BM25.",
  "vector-store": "No adapter yet — use memory for local retrieval.",
};

function NodeInspector({ props, node }: { props: Props; node: TopologyNode }) {
  const meta = nodeMeta[node.kind];
  const Icon = meta.icon;
  const onUpdate = props.onUpdateNode;
  const common = (patch: Partial<Pick<TopologyNode, "name" | "description">>) => onUpdate({ ...node, ...patch } as TopologyNode);

  return (
    <div className="inspector-content">
      <div className="inspector-title">
        <div className="node-icon" style={{ color: meta.color, background: meta.glow }}><Icon size={17} /></div>
        <div><span>{meta.label} node</span><h2>{node.name}</h2></div>
      </div>
      <div className="inspector-form">
        <Field label="Name"><input value={node.name} onChange={(event) => common({ name: event.target.value })} /></Field>
        <Field label="Description" hint={node.kind === "agent" ? "Planners read this to decide whether this worker adds value." : undefined}>
          <textarea rows={3} value={node.description} onChange={(event) => common({ description: event.target.value })} />
        </Field>

        {node.kind === "agent" && <AgentFields node={node} footprint={props.footprint} onUpdate={onUpdate} />}
        {node.kind === "model" && <ModelFields node={node} onUpdate={onUpdate} onTest={props.onTestModel} />}
        {node.kind === "capability" && (
          <>
            <Field label="Built-in capability"><select value={node.config.capabilityId} disabled><option value="calculator">Safe calculator</option></select></Field>
            <Toggle label="Enabled" checked={node.config.enabled} onChange={(enabled) => onUpdate({ ...node, config: { ...node.config, enabled } })} />
          </>
        )}
        {node.kind === "skill" && (
          <>
            <Field label="Loading" hint="On-demand skills cost one catalog line until a worker loads them.">
              <select value={node.config.loading} onChange={(event) => onUpdate({ ...node, config: { ...node.config, loading: event.target.value as "always" | "on-demand" } })}>
                <option value="always">Always in context</option><option value="on-demand">On demand</option>
              </select>
            </Field>
            {node.config.loading === "on-demand" && (
              <Field label="Catalog summary"><input value={node.config.summary} placeholder="One line shown in the skill catalog" onChange={(event) => onUpdate({ ...node, config: { ...node.config, summary: event.target.value } })} /></Field>
            )}
            <Field label="Skill instructions" hint={`≈${formatTokens(estimateTokens(node.config.instructions))} tokens when loaded`}>
              <textarea rows={9} value={node.config.instructions} onChange={(event) => onUpdate({ ...node, config: { ...node.config, instructions: event.target.value } })} />
            </Field>
          </>
        )}
        {node.kind === "connector" && <ConnectorFields node={node} catalog={props.catalog} onUpdate={onUpdate} onDiscover={props.onDiscover} />}
        {node.kind === "storage" && (
          <>
            <Field label="Storage type">
              <select value={node.config.storageType} onChange={(event) => onUpdate({ ...node, config: { ...node.config, storageType: event.target.value as StorageNode["config"]["storageType"] } })}>
                <option value="artifact-store">Artifact store</option>
                <option value="project-files">Project files</option>
                <option value="git">Git repository</option>
                <option value="memory">Memory (local retrieval)</option>
                <option value="vector-store">Vector store (no adapter yet)</option>
              </select>
            </Field>
            <Field label="Location" hint={storageHints[node.config.storageType]}><input value={node.config.location} onChange={(event) => onUpdate({ ...node, config: { ...node.config, location: event.target.value } })} /></Field>
          </>
        )}
      </div>
      <button className="danger-button" onClick={props.onDelete}><Trash2 size={14} /> Delete {meta.label.toLowerCase()}</button>
    </div>
  );
}

function EdgeInspector({ edge, source, target, onUpdate, onDelete }: { edge: TopologyEdge; source: TopologyNode | null; target: TopologyNode | null; onUpdate: (edge: TopologyEdge) => void; onDelete: () => void }) {
  const agentPair = source?.kind === "agent" && target?.kind === "agent";
  const permissions = edge.permissions ?? { read: true, write: false, scope: "/" };
  return (
    <div className="inspector-content">
      <div className="inspector-title"><div className="node-icon edge-icon"><Link2 size={17} /></div><div><span>Typed boundary</span><h2>{relationshipLabels[edge.kind]}</h2></div></div>
      <div className="edge-endpoints"><strong>{source?.name ?? edge.source}</strong><span>→</span><strong>{target?.name ?? edge.target}</strong></div>
      <div className="inspector-form">
        <Field label="Relationship">
          <select value={edge.kind} disabled={!agentPair} onChange={(event) => onUpdate({ ...edge, kind: event.target.value as RelationshipKind, label: relationshipLabels[event.target.value as RelationshipKind] })}>
            {(agentPair ? collaborationKinds : [edge.kind]).map((kind) => <option key={kind} value={kind}>{relationshipLabels[kind]}</option>)}
          </select>
        </Field>
        {agentPair && <div className="semantics-note">{relationshipDescriptions[relationName(edge.kind)]}</div>}
        {edge.kind === "agent_can_review_agent" && (
          <NumberField
            label="Max revisions"
            min={0}
            value={edge.settings?.maxRevisions ?? 1}
            hint="How many times a revise verdict may send work back before the owner finalizes."
            onChange={(maxRevisions) => onUpdate({ ...edge, settings: { maxRevisions } })}
          />
        )}
        <Field label="Canvas label"><input value={edge.label ?? ""} placeholder={relationshipLabels[edge.kind]} onChange={(event) => onUpdate({ ...edge, label: event.target.value })} /></Field>
        {edge.kind === "agent_can_access_storage" && (
          <>
            <div className="field-pair">
              <Toggle label="Read" checked={permissions.read} onChange={(read) => onUpdate({ ...edge, permissions: { ...permissions, read } })} />
              <Toggle label="Write" checked={permissions.write} onChange={(write) => onUpdate({ ...edge, permissions: { ...permissions, write } })} />
            </div>
            <Field label="Scope" hint="Sub-path of the storage the agent may touch. Enforced by the adapter, including symlinks.">
              <input value={permissions.scope} onChange={(event) => onUpdate({ ...edge, permissions: { ...permissions, scope: event.target.value } })} />
            </Field>
          </>
        )}
      </div>
      <div className="boundary-note">This edge grants availability. It does not prescribe execution order.</div>
      <button className="danger-button" onClick={onDelete}><Trash2 size={14} /> Delete relationship</button>
    </div>
  );
}

export function Inspector(props: Props) {
  if (props.node) return <NodeInspector key={props.node.id} props={props} node={props.node} />;
  if (props.edge) return <EdgeInspector edge={props.edge} source={props.sourceNode} target={props.targetNode} onUpdate={props.onUpdateEdge} onDelete={props.onDelete} />;
  return (
    <div className="inspector-empty">
      <div className="empty-inspector-icon"><Link2 size={21} /></div>
      <h2>Inspect the topology</h2>
      <p>Select a node to edit its configuration, or select an edge to change the permission it grants. Agent nodes show their context cost.</p>
    </div>
  );
}
