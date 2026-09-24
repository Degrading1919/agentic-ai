import type { AgentNode, RelationshipName, TopologyEdge } from "../shared/contracts.js";
import { relationName } from "../shared/topology.js";
import { lexicalTerms } from "./storage.js";

export type PlanCandidate = {
  agent: AgentNode;
  edge: TopologyEdge;
  relationship: RelationshipName;
};

export type PlannedTask = {
  agentId: string;
  relationship: "delegate" | "consult";
  objective: string;
  expectedOutput: string;
};

export type PlanDecision = {
  mode: "direct" | "delegate" | "handoff";
  tasks: PlannedTask[];
  review: { agentId: string; criteria: string } | null;
  handoff: { agentId: string; reason: string; remainingWork: string } | null;
  rationale: string;
  source: "model" | "fallback";
};

export function planCandidates(
  collaborators: Array<{ agent: AgentNode; edge: TopologyEdge }>,
  excludedAgentIds: Set<string>,
): PlanCandidate[] {
  return collaborators
    .filter(({ agent, edge }) => edge.kind !== "agent_reports_to_agent" && !excludedAgentIds.has(agent.id))
    .map(({ agent, edge }) => ({ agent, edge, relationship: relationName(edge.kind) }))
    .sort(
      (a, b) =>
        a.relationship.localeCompare(b.relationship) || a.agent.id.localeCompare(b.agent.id),
    );
}

/** Stable single-line description the planner (and the demo model) reads. */
export function candidateLine(candidate: PlanCandidate): string {
  const description = candidate.agent.description.replace(/\s+/g, " ").replaceAll("|", "/");
  return `CANDIDATE|${candidate.agent.id}|${candidate.agent.name}|${candidate.relationship}|${candidate.agent.config.role}|${description}`;
}

export function planningSchema(
  candidates: PlanCandidate[],
  maxDelegations: number,
): Record<string, unknown> {
  const ids = (relationships: RelationshipName[]) => [
    ...new Set(
      candidates
        .filter((candidate) => relationships.includes(candidate.relationship))
        .map((candidate) => candidate.agent.id),
    ),
  ];
  const taskIds = ids(["delegate", "consult"]);
  const reviewIds = ids(["review"]);
  const handoffIds = ids(["handoff"]);
  const modes = ["direct", ...(taskIds.length ? ["delegate"] : []), ...(handoffIds.length ? ["handoff"] : [])];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: modes },
      tasks: {
        type: "array",
        maxItems: Math.max(0, Math.min(maxDelegations, taskIds.length)),
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            agentId: { type: "string", enum: taskIds.length ? taskIds : [""] },
            relationship: { type: "string", enum: ["delegate", "consult"] },
            objective: { type: "string" },
            expectedOutput: { type: "string" },
          },
          required: ["agentId", "relationship", "objective", "expectedOutput"],
        },
      },
      review: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentId: { type: "string", enum: [...reviewIds, ""] },
          criteria: { type: "string" },
        },
        required: ["agentId", "criteria"],
      },
      handoff: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentId: { type: "string", enum: [...handoffIds, ""] },
          reason: { type: "string" },
          remainingWork: { type: "string" },
        },
        required: ["agentId", "reason", "remainingWork"],
      },
      rationale: { type: "string" },
    },
    required: ["mode", "tasks", "review", "handoff", "rationale"],
  };
}

export const PLANNING_INSTRUCTIONS = [
  "PLANNING REQUEST",
  "Decide how to handle this work order using only the candidates listed below.",
  "- direct: do the work yourself (preferred when no collaborator adds clear value).",
  "- delegate: assign bounded tasks. Use relationship 'delegate' for work products and 'consult' for advice.",
  "- handoff: transfer the whole unfinished task to a better-suited agent.",
  "Add a review only when an independent check adds value. Every extra worker costs inference, context, and latency, so select the fewest collaborators that materially improve the outcome.",
  "Give each task a self-contained objective. Use an empty agentId for review or handoff when not used. Respond with JSON only.",
].join("\n");

function stem(term: string): string {
  return term.slice(0, 5);
}

/** Lexical relevance between an objective and a collaborator's declared role. */
export function relevance(objective: string, agent: AgentNode): number {
  const objectiveStems = new Set(lexicalTerms(objective).map(stem));
  const profile = lexicalTerms(`${agent.name} ${agent.config.role} ${agent.description}`).map(stem);
  return new Set(profile.filter((term) => objectiveStems.has(term))).size;
}

/**
 * Deterministic plan used when a model cannot produce valid structured
 * output. Unlike naive fan-out, it selects only collaborators whose declared
 * role overlaps the objective, and defaults to direct work.
 */
export function fallbackPlan(
  objective: string,
  candidates: PlanCandidate[],
  maxDelegations: number,
  reason = "The planning response was not valid; used deterministic relevance ranking.",
): PlanDecision {
  const ranked = candidates
    .filter((candidate) => candidate.relationship === "delegate")
    .map((candidate) => ({ candidate, score: relevance(objective, candidate.agent) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.agent.id.localeCompare(b.candidate.agent.id))
    .slice(0, Math.min(maxDelegations, 2));
  const tasks = ranked.map(({ candidate }) => ({
    agentId: candidate.agent.id,
    relationship: "delegate" as const,
    objective: `As ${candidate.agent.config.role}, handle the part of this objective that matches your role: ${objective}`,
    expectedOutput: "A concise, verifiable result for the requesting agent to integrate.",
  }));
  const reviewer = candidates.find((candidate) => candidate.relationship === "review");
  const wantsReview = /\b(review|risk|verify|verification|check|audit|quality)\b/i.test(objective);
  return {
    mode: tasks.length ? "delegate" : "direct",
    tasks,
    review:
      reviewer && wantsReview
        ? { agentId: reviewer.agent.id, criteria: "Check correctness, risks, and completeness against the objective." }
        : null,
    handoff: null,
    rationale: reason,
    source: "fallback",
  };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Validate a model plan against the real topology candidates. */
export function parsePlan(
  content: string,
  candidates: PlanCandidate[],
  maxDelegations: number,
  objective: string,
): PlanDecision {
  let raw: Record<string, unknown>;
  try {
    const json = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch {
    return fallbackPlan(objective, candidates, maxDelegations);
  }

  const find = (agentId: string, relationship: RelationshipName) =>
    candidates.find(
      (candidate) => candidate.agent.id === agentId && candidate.relationship === relationship,
    );
  const rationale = text(raw.rationale, "No rationale supplied.").slice(0, 4_000);

  const handoffRaw = (raw.handoff ?? {}) as Record<string, unknown>;
  const handoffCandidate = find(text(handoffRaw.agentId), "handoff");
  if (raw.mode === "handoff" && handoffCandidate) {
    return {
      mode: "handoff",
      tasks: [],
      review: null,
      handoff: {
        agentId: handoffCandidate.agent.id,
        reason: text(handoffRaw.reason, "The receiving agent is better suited."),
        remainingWork: text(handoffRaw.remainingWork, objective),
      },
      rationale,
      source: "model",
    };
  }

  const seen = new Set<string>();
  const tasks: PlannedTask[] = [];
  for (const entry of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (tasks.length >= maxDelegations) break;
    if (typeof entry !== "object" || entry === null) continue;
    const task = entry as Record<string, unknown>;
    const agentId = text(task.agentId);
    const requested = task.relationship === "consult" ? "consult" : "delegate";
    // Honour the requested relationship only if that exact edge exists.
    const candidate = find(agentId, requested) ?? find(agentId, requested === "consult" ? "delegate" : "consult");
    if (!candidate || seen.has(`${agentId}:${candidate.relationship}`)) continue;
    seen.add(`${agentId}:${candidate.relationship}`);
    tasks.push({
      agentId,
      relationship: candidate.relationship as "delegate" | "consult",
      objective:
        text(task.objective) ||
        `Handle the part of this objective that matches your role as ${candidate.agent.config.role}: ${objective}`,
      expectedOutput: text(task.expectedOutput) || "A concise result for the requesting agent.",
    });
  }

  const reviewRaw = (raw.review ?? {}) as Record<string, unknown>;
  const reviewCandidate = find(text(reviewRaw.agentId), "review");
  return {
    mode: tasks.length ? "delegate" : "direct",
    tasks,
    review: reviewCandidate
      ? {
          agentId: reviewCandidate.agent.id,
          criteria: text(reviewRaw.criteria) || "Check correctness, risks, and completeness against the objective.",
        }
      : null,
    handoff: null,
    rationale,
    source: "model",
  };
}

export function reviewSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["approve", "revise", "reject"] },
      summary: { type: "string" },
      findings: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string", enum: ["blocking", "major", "minor"] },
            issue: { type: "string" },
            recommendation: { type: "string" },
          },
          required: ["severity", "issue", "recommendation"],
        },
      },
    },
    required: ["verdict", "summary", "findings"],
  };
}

export const REVIEW_INSTRUCTIONS = [
  "REVIEW REQUEST",
  "Evaluate the subject work below against the requirements. You have read-only access.",
  "Return verdict 'approve' when it meets the requirements, 'revise' when specific fixable issues remain, or 'reject' when it is fundamentally unsuitable.",
  "List concrete findings with a recommendation for each. Respond with JSON only.",
].join("\n");
