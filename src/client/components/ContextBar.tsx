import type { ContextSegmentKind } from "../../shared/contracts.js";
import { formatTokens } from "../../shared/tokens.js";

export const segmentMeta: Record<ContextSegmentKind, { label: string; color: string; hint: string }> = {
  harness: { label: "Harness", color: "#6f7b8c", hint: "Fixed harness rules shared by every worker." },
  worker: { label: "Worker", color: "#c6ff4a", hint: "This agent's role and operating instructions." },
  skills: { label: "Skills", color: "#c09cff", hint: "Always-loaded skill instructions." },
  skill_catalog: { label: "Skill catalog", color: "#8f76c9", hint: "One line per on-demand skill; bodies load only when used." },
  collaborators: { label: "Collaborators", color: "#9be27a", hint: "Connected agents and relationship semantics." },
  resources: { label: "Resources", color: "#76e6b3", hint: "Connected storage and connectors." },
  tool_catalog: { label: "Tool catalog", color: "#ffd48a", hint: "Compact list of deferred tools." },
  tool_schemas: { label: "Tool schemas", color: "#ffb454", hint: "Full function schemas sent with each request." },
  work_order: { label: "Work order", color: "#54d7ff", hint: "Objective, inputs, constraints, expected output." },
  history: { label: "Thread digest", color: "#6aa8ff", hint: "Compact digest of prior runs in this thread." },
  memory: { label: "Memory", color: "#5fd0c0", hint: "Retrieved notes from connected memory." },
  dependencies: { label: "Dependencies", color: "#ff7fc4", hint: "Specialist outputs, advice, verdicts, revision requests." },
  inbox: { label: "Inbox", color: "#b9a9ff", hint: "Status reports delivered to this agent." },
  tool_results: { label: "Tool loop", color: "#ff8d75", hint: "Tool calls and results in this request, fitted to the window (older results may be elided)." },
  response_schema: { label: "Response schema", color: "#9aa7b8", hint: "JSON schema sent with plan and review requests." },
};

export type BarSegment = { kind: ContextSegmentKind; label: string; tokens: number; trimmed?: boolean };

/** Stacked bar of context usage against the model window. */
export function ContextBar({
  segments,
  window,
  reserved = 0,
  compact = false,
}: {
  segments: BarSegment[];
  window: number;
  reserved?: number;
  compact?: boolean;
}) {
  const used = segments.reduce((sum, item) => sum + item.tokens, 0);
  const scale = Math.max(window, used + reserved, 1);
  const byKind = new Map<ContextSegmentKind, BarSegment & { count: number }>();
  for (const item of segments) {
    const existing = byKind.get(item.kind);
    byKind.set(item.kind, {
      kind: item.kind,
      label: segmentMeta[item.kind].label,
      tokens: (existing?.tokens ?? 0) + item.tokens,
      trimmed: Boolean(existing?.trimmed || item.trimmed),
      count: (existing?.count ?? 0) + 1,
    });
  }
  const groups = [...byKind.values()].filter((item) => item.tokens > 0);
  const overBudget = window > 0 && used + reserved > window;
  return (
    <div className={`context-bar ${compact ? "compact" : ""}`}>
      <div className="context-track" role="img" aria-label={`${used} of ${window} tokens used`}>
        {groups.map((item) => (
          <span
            key={item.kind}
            className={item.trimmed ? "trimmed" : ""}
            style={{ width: `${(item.tokens / scale) * 100}%`, background: segmentMeta[item.kind].color }}
            title={`${item.label}: ≈${item.tokens} tokens${item.trimmed ? " (compacted to fit)" : ""}\n${segmentMeta[item.kind].hint}`}
          />
        ))}
        {reserved > 0 && (
          <span className="reserved" style={{ width: `${(reserved / scale) * 100}%` }} title={`Reserved for output: ${reserved} tokens`} />
        )}
      </div>
      <div className="context-scale">
        <span className={overBudget ? "over" : ""}>≈{formatTokens(used)}{reserved ? ` + ${formatTokens(reserved)} out` : ""}</span>
        <span>{window ? `${formatTokens(window)} window · ${Math.round(((used + reserved) / window) * 100)}%` : "no model"}</span>
      </div>
      {!compact && (
        <div className="context-legend">
          {groups
            .sort((a, b) => b.tokens - a.tokens)
            .map((item) => (
              <div key={item.kind} title={segmentMeta[item.kind].hint}>
                <i style={{ background: segmentMeta[item.kind].color }} />
                <span>{item.label}{item.trimmed ? " · compacted" : ""}</span>
                <strong>{formatTokens(item.tokens)}</strong>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
