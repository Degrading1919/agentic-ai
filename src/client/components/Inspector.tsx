import { useState } from "react";
import { Beaker, Check, Link2, LoaderCircle, Trash2 } from "lucide-react";
import type {
  RelationshipKind,
  TopologyEdge,
  TopologyNode,
} from "../../shared/contracts.js";
import {
  collaborationKinds,
  relationshipLabels,
} from "../../shared/topology.js";
import { nodeMeta } from "../node-meta.js";

type Props = {
  node: TopologyNode | null;
  edge: TopologyEdge | null;
  sourceNode: TopologyNode | null;
  targetNode: TopologyNode | null;
  onUpdateNode: (node: TopologyNode) => void;
  onUpdateEdge: (edge: TopologyEdge) => void;
  onDelete: () => void;
  onTestModel: (node: TopologyNode) => Promise<{ ok: boolean; message: string }>;
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="inspector-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

function NodeInspector({
  node,
  onUpdate,
  onDelete,
  onTest,
}: {
  node: TopologyNode;
  onUpdate: (node: TopologyNode) => void;
  onDelete: () => void;
  onTest: (node: TopologyNode) => Promise<{ ok: boolean; message: string }>;
}) {
  const meta = nodeMeta[node.kind];
  const Icon = meta.icon;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const common = (patch: Partial<Pick<TopologyNode, "name" | "description">>) =>
    onUpdate({ ...node, ...patch } as TopologyNode);

  const test = async () => {
    setTesting(true);
    try {
      setTestResult(await onTest(node));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="inspector-content">
      <div className="inspector-title">
        <div className="node-icon" style={{ color: meta.color, background: meta.glow }}><Icon size={17} /></div>
        <div><span>{meta.label} node</span><h2>{node.name}</h2></div>
      </div>
      <div className="inspector-form">
        <Field label="Name"><input value={node.name} onChange={(event) => common({ name: event.target.value })} /></Field>
        <Field label="Description"><textarea rows={3} value={node.description} onChange={(event) => common({ description: event.target.value })} /></Field>

        {node.kind === "agent" && (
          <>
            <Field label="Worker role"><input value={node.config.role} onChange={(event) => onUpdate({ ...node, config: { ...node.config, role: event.target.value } })} /></Field>
            <Field label="Operating instructions"><textarea rows={7} value={node.config.instructions} onChange={(event) => onUpdate({ ...node, config: { ...node.config, instructions: event.target.value } })} /></Field>
            <Toggle label="Available in Work" checked={node.config.entrypoint} onChange={(entrypoint) => onUpdate({ ...node, config: { ...node.config, entrypoint } })} />
            <Toggle label="Plan connected delegations" checked={node.config.autoDelegate} onChange={(autoDelegate) => onUpdate({ ...node, config: { ...node.config, autoDelegate } })} />
            <Field label="Conversation persistence">
              <select value={node.config.conversationPersistence} onChange={(event) => onUpdate({ ...node, config: { ...node.config, conversationPersistence: event.target.value as "transient" | "connected-storage" } })}>
                <option value="connected-storage">Connected storage</option><option value="transient">Transient</option>
              </select>
            </Field>
            <div className="field-pair">
              <Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={node.config.temperature} onChange={(event) => onUpdate({ ...node, config: { ...node.config, temperature: Number(event.target.value) } })} /></Field>
              <Field label="Max output"><input type="number" min="64" step="64" value={node.config.maxOutputTokens} onChange={(event) => onUpdate({ ...node, config: { ...node.config, maxOutputTokens: Number(event.target.value) } })} /></Field>
            </div>
          </>
        )}

        {node.kind === "model" && (
          <>
            <Field label="Provider">
              <select value={node.config.provider} onChange={(event) => onUpdate({ ...node, config: { ...node.config, provider: event.target.value as "mock" | "openai-compatible" } })}>
                <option value="mock">Built-in demo</option><option value="openai-compatible">OpenAI compatible</option>
              </select>
            </Field>
            <Field label="Model ID"><input value={node.config.modelId} onChange={(event) => onUpdate({ ...node, config: { ...node.config, modelId: event.target.value } })} /></Field>
            <Field label="Base URL" hint="llama.cpp defaults to http://127.0.0.1:8080/v1"><input disabled={node.config.provider === "mock"} value={node.config.baseUrl} onChange={(event) => onUpdate({ ...node, config: { ...node.config, baseUrl: event.target.value } })} /></Field>
            <Field label="API key environment variable"><input disabled={node.config.provider === "mock"} placeholder="Optional; secret never enters the topology" value={node.config.apiKeyEnv} onChange={(event) => onUpdate({ ...node, config: { ...node.config, apiKeyEnv: event.target.value } })} /></Field>
            <Field label="Lifecycle">
              <select disabled={node.config.provider === "mock"} value={node.config.lifecycle} onChange={(event) => onUpdate({ ...node, config: { ...node.config, lifecycle: event.target.value as "logical" | "llama-swap" } })}>
                <option value="logical">Externally managed / logical</option><option value="llama-swap">llama-swap managed</option>
              </select>
            </Field>
            <div className="field-pair">
              <Field label="Context"><input type="number" min="512" value={node.config.contextWindow} onChange={(event) => onUpdate({ ...node, config: { ...node.config, contextWindow: Number(event.target.value) } })} /></Field>
              <Field label="Est. memory MB"><input type="number" min="0" value={node.config.estimatedMemoryMb} onChange={(event) => onUpdate({ ...node, config: { ...node.config, estimatedMemoryMb: Number(event.target.value) } })} /></Field>
            </div>
            <div className="field-pair">
              <Field label="Idle TTL ms"><input type="number" min="0" value={node.config.idleTtlMs} onChange={(event) => onUpdate({ ...node, config: { ...node.config, idleTtlMs: Number(event.target.value) } })} /></Field>
              <Field label="Timeout ms"><input type="number" min="1000" value={node.config.requestTimeoutMs} onChange={(event) => onUpdate({ ...node, config: { ...node.config, requestTimeoutMs: Number(event.target.value) } })} /></Field>
            </div>
            <button className="test-button" onClick={() => void test()} disabled={testing}>
              {testing ? <LoaderCircle className="spin" size={14} /> : <Beaker size={14} />} Test connection
            </button>
            {testResult && <div className={`test-result ${testResult.ok ? "ok" : "failed"}`}>{testResult.ok && <Check size={13} />}{testResult.message}</div>}
          </>
        )}

        {node.kind === "capability" && (
          <><Field label="Built-in capability"><select value={node.config.capabilityId} disabled><option value="calculator">Safe calculator</option></select></Field><Toggle label="Enabled" checked={node.config.enabled} onChange={(enabled) => onUpdate({ ...node, config: { ...node.config, enabled } })} /></>
        )}
        {node.kind === "skill" && <Field label="Skill instructions"><textarea rows={9} value={node.config.instructions} onChange={(event) => onUpdate({ ...node, config: { instructions: event.target.value } })} /></Field>}
        {node.kind === "connector" && (
          <><Field label="Connector type"><select value={node.config.connectorType} onChange={(event) => onUpdate({ ...node, config: { ...node.config, connectorType: event.target.value as "mcp" | "http-api" } })}><option value="mcp">MCP</option><option value="http-api">HTTP API</option></select></Field><Field label="Endpoint"><input value={node.config.endpoint} onChange={(event) => onUpdate({ ...node, config: { ...node.config, endpoint: event.target.value } })} /></Field><Field label="Auth environment variable"><input value={node.config.authEnv} onChange={(event) => onUpdate({ ...node, config: { ...node.config, authEnv: event.target.value } })} /></Field><Toggle label="Enabled" checked={node.config.enabled} onChange={(enabled) => onUpdate({ ...node, config: { ...node.config, enabled } })} /></>
        )}
        {node.kind === "storage" && (
          <><Field label="Storage type"><select value={node.config.storageType} onChange={(event) => onUpdate({ ...node, config: { ...node.config, storageType: event.target.value as typeof node.config.storageType } })}><option value="artifact-store">Artifact store</option><option value="project-files">Project files</option><option value="git">Git repository</option><option value="vector-store">Vector store</option></select></Field><Field label="Location"><input value={node.config.location} onChange={(event) => onUpdate({ ...node, config: { ...node.config, location: event.target.value } })} /></Field></>
        )}
      </div>
      <button className="danger-button" onClick={onDelete}><Trash2 size={14} /> Delete {meta.label.toLowerCase()}</button>
    </div>
  );
}

function EdgeInspector({ edge, source, target, onUpdate, onDelete }: { edge: TopologyEdge; source: TopologyNode | null; target: TopologyNode | null; onUpdate: (edge: TopologyEdge) => void; onDelete: () => void }) {
  const agentPair = source?.kind === "agent" && target?.kind === "agent";
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
        <Field label="Canvas label"><input value={edge.label ?? ""} placeholder={relationshipLabels[edge.kind]} onChange={(event) => onUpdate({ ...edge, label: event.target.value })} /></Field>
        {edge.kind === "agent_can_access_storage" && (
          <><div className="field-pair"><Toggle label="Read" checked={edge.permissions?.read ?? false} onChange={(read) => onUpdate({ ...edge, permissions: { read, write: edge.permissions?.write ?? false, scope: edge.permissions?.scope ?? "/" } })} /><Toggle label="Write" checked={edge.permissions?.write ?? false} onChange={(write) => onUpdate({ ...edge, permissions: { read: edge.permissions?.read ?? true, write, scope: edge.permissions?.scope ?? "/" } })} /></div><Field label="Scope"><input value={edge.permissions?.scope ?? "/"} onChange={(event) => onUpdate({ ...edge, permissions: { read: edge.permissions?.read ?? true, write: edge.permissions?.write ?? false, scope: event.target.value } })} /></Field></>
        )}
      </div>
      <div className="boundary-note">This edge grants availability. It does not prescribe execution order.</div>
      <button className="danger-button" onClick={onDelete}><Trash2 size={14} /> Delete relationship</button>
    </div>
  );
}

export function Inspector(props: Props) {
  if (props.node) return <NodeInspector node={props.node} onUpdate={props.onUpdateNode} onDelete={props.onDelete} onTest={props.onTestModel} />;
  if (props.edge) return <EdgeInspector edge={props.edge} source={props.sourceNode} target={props.targetNode} onUpdate={props.onUpdateEdge} onDelete={props.onDelete} />;
  return (
    <div className="inspector-empty">
      <div className="empty-inspector-icon"><Link2 size={21} /></div>
      <h2>Inspect the topology</h2>
      <p>Select a node to edit its configuration, or select an edge to change the permission it grants.</p>
    </div>
  );
}
