import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ToolCall,
} from "../shared/contracts.js";
import { estimateJsonTokens, estimateTokens } from "../shared/tokens.js";
import { lexicalTerms } from "./storage.js";

/**
 * Deterministic offline model used by the demo topology and the test suite.
 *
 * It is a simulator, not a language model: it reads the harness's structured
 * prompt sections and exercises the same runtime paths a real model would
 * (relevance-based planning, deferred tool discovery, structured reviews,
 * consults, handoffs). Bracketed markers in an objective such as `[direct]`,
 * `[handoff]`, `[consult]`, or `[needs-revision]` steer it for demos/tests.
 */

type Intent =
  | { kind: "calc"; expression: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "write"; path: string }
  | { kind: "consult" }
  | { kind: "handoff" }
  | { kind: "read"; id: string };


function userText(request: CompletionRequest): string {
  return request.messages.find((message) => message.role === "user")?.content ?? "";
}

function systemText(request: CompletionRequest): string {
  return request.messages.find((message) => message.role === "system")?.content ?? "";
}

export function objectiveOf(prompt: string): string {
  return prompt.match(/OBJECTIVE\n([\s\S]*?)(?:\n\n|$)/)?.[1]?.trim() ?? prompt.trim();
}

function stems(text: string): Set<string> {
  return new Set(lexicalTerms(text).map((term) => term.slice(0, 5)));
}

function overlap(a: string, b: string): number {
  const left = stems(a);
  return [...stems(b)].filter((term) => left.has(term)).length;
}

function usage(request: CompletionRequest, content: string): CompletionResult["usage"] {
  const promptTokens =
    request.messages.reduce(
      (sum, message) =>
        sum + estimateTokens(message.content ?? "") + estimateTokens(message.toolCalls ? JSON.stringify(message.toolCalls) : "") + 4,
      0,
    ) + (request.tools?.length ? estimateJsonTokens(request.tools) : 0);
  // The simulator has no tokenizer and no prompt cache: its counts are
  // estimates and it reports no cache information rather than inventing it.
  return { promptTokens, completionTokens: estimateTokens(content), cachedPromptTokens: null, estimated: true };
}

function result(request: CompletionRequest, content: string, toolCalls: ToolCall[] = []): CompletionResult {
  return { content, toolCalls, usage: usage(request, content) };
}

function mockPlan(request: CompletionRequest): CompletionResult {
  const prompt = userText(request);
  const objective = objectiveOf(prompt);
  const maxTasks = Number(prompt.match(/Maximum tasks: (\d+)/)?.[1] ?? 3);
  const candidates = prompt
    .split("\n")
    .filter((line) => line.startsWith("CANDIDATE|"))
    .map((line) => {
      const [, agentId, name, relationship, role, description = ""] = line.split("|");
      return { agentId, name, relationship, role, description, score: 0 };
    })
    .map((candidate) => ({
      ...candidate,
      score: overlap(objective, `${candidate.name} ${candidate.role} ${candidate.description}`),
    }));
  const empty = { agentId: "", reason: "", remainingWork: "" };
  const noReview = { agentId: "", criteria: "" };

  const handoff = candidates.find((candidate) => candidate.relationship === "handoff");
  if (/\[handoff\]/i.test(objective) && handoff) {
    return result(
      request,
      JSON.stringify({
        mode: "handoff",
        tasks: [],
        review: noReview,
        handoff: { agentId: handoff.agentId, reason: `${handoff.name} is better suited to own this work.`, remainingWork: objective },
        rationale: `Transfer ownership to ${handoff.name}.`,
      }),
    );
  }
  const reviewer = candidates.find((candidate) => candidate.relationship === "review");
  const wantsReview = /review|risk|verif|check|audit|quality/i.test(objective);
  const review = reviewer && wantsReview ? { agentId: reviewer.agentId, criteria: "Correctness, risks, and verifiability." } : noReview;
  if (/\[direct\]/i.test(objective)) {
    return result(
      request,
      JSON.stringify({ mode: "direct", tasks: [], review, handoff: empty, rationale: "Simple enough to complete directly." }),
    );
  }

  const byScore = (a: { score: number; agentId: string }, b: { score: number; agentId: string }) =>
    b.score - a.score || a.agentId.localeCompare(b.agentId);
  const delegates = candidates
    .filter((candidate) => candidate.relationship === "delegate" && candidate.score > 0)
    .sort(byScore)
    .slice(0, Math.min(2, maxTasks));
  const consults = candidates
    .filter((candidate) => candidate.relationship === "consult" && (candidate.score > 1 || /\[consult-plan\]/i.test(objective)))
    .sort(byScore)
    .slice(0, Math.max(0, maxTasks - delegates.length));
  const tasks = [...delegates, ...consults].map((candidate) => ({
    agentId: candidate.agentId,
    relationship: candidate.relationship,
    objective: `As ${candidate.role}, handle the part of this objective that matches your role: ${objective}`,
    expectedOutput: `A concise ${candidate.relationship === "consult" ? "recommendation" : "deliverable"} for the lead agent.`,
  }));
  const skipped = candidates.filter((candidate) => !tasks.some((task) => task.agentId === candidate.agentId));
  return result(
    request,
    JSON.stringify({
      mode: tasks.length ? "delegate" : "direct",
      tasks,
      review,
      handoff: empty,
      rationale: tasks.length
        ? `Selected ${tasks.map((task) => task.agentId).join(", ")} by role relevance; skipped ${skipped.length} that would add cost without clear value.`
        : "No connected collaborator adds clear value; completing directly.",
    }),
  );
}

function mockReview(request: CompletionRequest): CompletionResult {
  const prompt = userText(request);
  const subject = prompt.split("SUBJECT WORK")[1] ?? "";
  // Test hook: a reviewer that answers in prose instead of a verdict.
  if (subject.includes("[review-garbage]")) return result(request, "I could not inspect the files.");
  const needsRevision = subject.includes("DRAFT-MARKER");
  return result(
    request,
    JSON.stringify(
      needsRevision
        ? {
            verdict: "revise",
            summary: "The deliverable is still marked as a draft.",
            findings: [
              { severity: "major", issue: "Draft marker present; the deliverable is incomplete.", recommendation: "Finalize the deliverable and remove the draft marker." },
            ],
          }
        : {
            verdict: "approve",
            summary: "The work meets the stated requirements and states its assumptions.",
            findings: [
              { severity: "minor", issue: "Acceptance checks could be more specific.", recommendation: "Name one measurable check per claim." },
            ],
          },
    ),
  );
}

function parseIntents(objective: string): Intent[] {
  const intents: Intent[] = [];
  const calc = objective.match(/(?:calculate|compute|evaluate|what\s+is)\s+([0-9eE+\-*/%^().\s]{1,160})/i);
  if (calc?.[1]?.trim()) intents.push({ kind: "calc", expression: calc[1].trim() });
  for (const match of objective.matchAll(/use tool ([\w-]+)(?: with (\{[^}]*\}))?/gi)) {
    let args: Record<string, unknown> = {};
    try {
      args = match[2] ? (JSON.parse(match[2]) as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    intents.push({ kind: "tool", name: match[1], args });
  }
  const write = objective.match(/write file ([\w./-]+)/i);
  if (write) intents.push({ kind: "write", path: write[1] });
  if (/\[consult\]/i.test(objective)) intents.push({ kind: "consult" });
  if (/\[handoff-now\]/i.test(objective)) intents.push({ kind: "handoff" });
  for (const match of objective.matchAll(/read artifact ([\w:.-]+)/gi)) intents.push({ kind: "read", id: match[1] });
  return intents;
}

type HistoryCall = { name: string; args: Record<string, unknown>; result: string };

function toolHistory(messages: ChatMessage[]): HistoryCall[] {
  const results = new Map(
    messages.filter((message) => message.role === "tool").map((message) => [message.toolCallId ?? "", message.content ?? ""]),
  );
  return messages.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { name: call.function.name, args, result: results.get(call.id) ?? "" };
    }),
  );
}

function catalogNames(system: string): string[] {
  const section = system.split("TOOL CATALOG")[1] ?? "";
  return [...section.matchAll(/^- ([a-zA-Z0-9_-]+):/gm)].map((match) => match[1]);
}

function callOf(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function enumOf(request: CompletionRequest, tool: string, property: string): string | undefined {
  const definition = request.tools?.find((candidate) => candidate.function.name === tool);
  const properties = definition?.function.parameters.properties as Record<string, { enum?: string[] }> | undefined;
  return properties?.[property]?.enum?.[0];
}

function nextToolCall(request: CompletionRequest, objective: string): ToolCall | null {
  const native = new Set((request.tools ?? []).map((tool) => tool.function.name));
  const deferred = catalogNames(systemText(request));
  const history = toolHistory(request.messages);
  const matches = (candidate: string, wanted: string) => candidate === wanted || candidate.endsWith(`__${wanted}`);

  for (const intent of parseIntents(objective)) {
    if (intent.kind === "read") {
      const done = history.some((call) => call.name === "read_artifact" && call.args.id === intent.id);
      if (!native.has("read_artifact") || done) continue;
      return callOf("read_artifact", { id: intent.id });
    }
    if (intent.kind === "consult") {
      if (!native.has("consult_agent") || history.some((call) => call.name === "consult_agent")) continue;
      return callOf("consult_agent", { agentId: enumOf(request, "consult_agent", "agentId"), question: `What should I watch out for in: ${objective}` });
    }
    if (intent.kind === "handoff") {
      if (!native.has("handoff_work") || history.some((call) => call.name === "handoff_work")) continue;
      return callOf("handoff_work", {
        agentId: enumOf(request, "handoff_work", "agentId"),
        reason: "This task belongs with a better-suited specialist.",
        progress: "Scoped the request.",
        remainingWork: objective,
      });
    }

    const wanted = intent.kind === "calc" ? "calculator_evaluate" : intent.kind === "tool" ? intent.name : "";
    const pick = (names: Iterable<string>) =>
      [...names].find((name) => (intent.kind === "write" ? /^fs_.*_write$/.test(name) : matches(name, wanted)));
    const args =
      intent.kind === "calc"
        ? { expression: intent.expression }
        : intent.kind === "tool"
          ? intent.args
          : { path: intent.kind === "write" ? intent.path : "", content: `Deliverable for: ${objective}\n` };

    const nativeTarget = pick(native);
    if (nativeTarget && !isMetaName(nativeTarget)) {
      if (history.some((call) => call.name === nativeTarget)) continue;
      return callOf(nativeTarget, args);
    }
    // Large catalogs list groups, not names: search, then use what came back.
    const searched = history
      .filter((call) => call.name === "find_tools")
      .flatMap((call) => {
        try {
          return (JSON.parse(call.result) as { tools?: Array<{ name: string }> }).tools?.map((tool) => tool.name) ?? [];
        } catch {
          return [];
        }
      });
    const deferredTarget = pick([...deferred, ...searched]);
    if (!deferredTarget && native.has("find_tools") && wanted && !history.some((call) => call.name === "find_tools" && call.args.query === wanted)) {
      return callOf("find_tools", { query: wanted });
    }
    if (deferredTarget && native.has("find_tools")) {
      const called = history.some(
        (call) => call.name === "call_tool" && call.args.name === deferredTarget && !call.result.includes("Load the schema"),
      );
      if (called) continue;
      const found = history.some((call) => call.name === "find_tools" && call.result.includes(`"${deferredTarget}"`));
      return found
        ? callOf("call_tool", { name: deferredTarget, arguments: args })
        : callOf("find_tools", { query: wanted || "write", names: [deferredTarget] });
    }
  }
  return null;
}

function isMetaName(name: string): boolean {
  return ["find_tools", "call_tool", "load_skill", "consult_agent", "handoff_work", "read_artifact"].includes(name);
}

function finalContent(request: CompletionRequest, objective: string): string {
  const prompt = userText(request);
  const toolLines = toolHistory(request.messages)
    .filter((call) => !["find_tools"].includes(call.name))
    .map((call) => `- ${call.name === "call_tool" ? String(call.args.name) : call.name} → ${call.result.slice(0, 400)}`);
  const toolSection = toolLines.length
    ? `\n\n### Tool results\n\n${toolLines.join("\n")}\n\nThe connected tools returned the values above; only capabilities granted to this worker were used.`
    : "";

  if (prompt.includes("REVISION REQUEST")) {
    return `## Revised deliverable\n\nAddressed every review finding for: ${objective}\n\n- Finalized the deliverable.\n- Added an explicit acceptance check.${toolSection}`;
  }
  if (prompt.includes("CONSULTATION:")) {
    return `## Advice\n\nFor "${objective}": keep the change small, name the acceptance check up front, and record assumptions. Main risk: scope creep beyond the connected resources.${toolSection}`;
  }
  if (prompt.includes("SPECIALIST OUTPUTS") || prompt.includes("INTEGRATION REQUEST")) {
    const outputs = prompt.split("SPECIALIST OUTPUTS")[1]?.split(/\n(?:CONSULTANT ADVICE|REVIEW VERDICTS|INTEGRATION REQUEST)/)[0]?.trim() ?? "";
    const verdicts = prompt.split("REVIEW VERDICTS")[1]?.split("\nINTEGRATION REQUEST")[0]?.trim() ?? "";
    return [
      "## Integrated result",
      "",
      "The team completed the request through the configured collaboration boundaries.",
      "",
      outputs || "No specialist output was available, so the lead completed the work directly.",
      ...(verdicts ? ["", "## Review", "", verdicts] : []),
      "",
      "## Decision notes",
      "",
      "- Execution used only connected models and resources.",
      "- Completed work orders and this result are durable and can be inspected or resumed.",
    ].join("\n") + toolSection;
  }
  const advice = prompt.includes("CONSULTANT ADVICE") ? "\n\nConsultant advice was considered before finalizing." : "";
  const draft = /\[needs-revision\]/i.test(objective) ? "\n\nDRAFT-MARKER: acceptance checks still to be written." : "";
  return [
    "## Specialist response",
    "",
    `I analyzed the scoped objective: ${objective || "No objective supplied."}`,
    "",
    "### Recommended outcome",
    "",
    "Use a small, verifiable implementation slice with explicit inputs, observable state, and a concrete acceptance check. Keep capability access narrow and return evidence with the result.",
    "",
    "### Checks",
    "",
    "- Confirm required inputs are available through connected resources.",
    "- Test the outcome at the boundary where it will be consumed.",
    "- Record any unresolved assumption instead of silently widening scope.",
  ].join("\n") + advice + draft + toolSection;
}

export function mockCompletion(request: CompletionRequest): CompletionResult {
  const prompt = userText(request);
  if (request.jsonSchema) {
    if (prompt.includes("PLANNING REQUEST")) return mockPlan(request);
    if (prompt.includes("REVIEW REQUEST")) return mockReview(request);
    return result(request, "{}");
  }
  const objective = objectiveOf(prompt);
  const call = nextToolCall(request, objective);
  if (call) return result(request, "", [call]);
  return result(request, finalContent(request, objective));
}
