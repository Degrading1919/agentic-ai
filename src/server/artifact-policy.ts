import type { Run, WorkOrder } from "../shared/contracts.js";
import { terminalWorkOrderStatuses } from "../shared/contracts.js";

/**
 * Information-flow policy for `read_artifact`.
 *
 * Knowing an ID is never authorization. An order may read another order's
 * output only through an explicit relationship:
 *
 * | Relationship | Readable |
 * | --- | --- |
 * | self | its own draft/result |
 * | revision | earlier versions it revises (`revisionOf` chain) |
 * | handoff | the orders it took over (`handoffFromOrderId` chain) |
 * | dependency | declared dependencies, resolved through handoffs |
 * | subject | orders it reviews (drafts included), resolved through handoffs |
 * | child | its own children once they have returned (terminal) |
 * | review | reviews whose subject is this order or one it revises |
 * | tool | results of tool calls it (or a handoff predecessor) made |
 * | thread | root-chain orders only: prior-run roots listed in its thread digest |
 *
 * Anything else — siblings, a parent's other children, other runs, orders
 * still running — is denied. Output of an unfinished order is never readable
 * except a draft that is the declared subject of a review.
 */

export type ArtifactGrant =
  | "self"
  | "revision"
  | "handoff"
  | "dependency"
  | "subject"
  | "child"
  | "review"
  | "tool"
  | "thread";

export type ArtifactDecision =
  | { allowed: true; grant: ArtifactGrant; content: string; source: string }
  | { allowed: false; reason: string };

const isTerminal = (order: WorkOrder) => terminalWorkOrderStatuses.includes(order.status);

/** Follow handoffs from an order to the order that finally owns its work. */
export function resolveThroughHandoff(run: Run, orderId: string): WorkOrder | undefined {
  const byId = new Map(run.workOrders.map((order) => [order.id, order]));
  let current = byId.get(orderId);
  const seen = new Set<string>();
  while (current?.status === "handed_off" && current.handedOffToOrderId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.handedOffToOrderId) ?? current;
  }
  return current;
}

function chain(run: Run, start: WorkOrder, next: (order: WorkOrder) => string | null): WorkOrder[] {
  const byId = new Map(run.workOrders.map((order) => [order.id, order]));
  const result: WorkOrder[] = [];
  const seen = new Set<string>([start.id]);
  let cursor = next(start);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const order = byId.get(cursor);
    if (!order) break;
    result.push(order);
    cursor = next(order);
  }
  return result;
}

/** Whether an order belongs to the run's root chain (the user's request and its handoffs). */
export function isRootChain(run: Run, order: WorkOrder): boolean {
  if (order.parentId !== null) return false;
  if (order.returnRelationship === "root") return true;
  return chain(run, order, (item) => item.handoffFromOrderId).some((item) => item.returnRelationship === "root");
}

/** The orders `order` may read, keyed by ID, with the relationship that grants each. */
export function visibleOrders(run: Run, order: WorkOrder): Map<string, { order: WorkOrder; grant: ArtifactGrant }> {
  const visible = new Map<string, { order: WorkOrder; grant: ArtifactGrant }>();
  const grant = (target: WorkOrder | undefined, kind: ArtifactGrant) => {
    if (target && !visible.has(target.id)) visible.set(target.id, { order: target, grant: kind });
  };
  grant(order, "self");
  const revisions = chain(run, order, (item) => item.revisionOf);
  for (const previous of revisions) grant(previous, "revision");
  const predecessors = chain(run, order, (item) => item.handoffFromOrderId);
  for (const previous of predecessors) grant(previous, "handoff");
  for (const id of order.dependencies) {
    grant(run.workOrders.find((item) => item.id === id), "dependency");
    grant(resolveThroughHandoff(run, id), "dependency");
  }
  for (const id of order.subjectOrderIds) {
    grant(run.workOrders.find((item) => item.id === id), "subject");
    grant(resolveThroughHandoff(run, id), "subject");
  }
  const owners = [order, ...predecessors];
  for (const child of run.workOrders) {
    if (child.parentId && owners.some((owner) => owner.id === child.parentId)) grant(child, "child");
  }
  const reviewed = new Set([order.id, ...revisions.map((item) => item.id)]);
  for (const review of run.workOrders) {
    if (review.returnRelationship === "review" && review.subjectOrderIds.some((id) => reviewed.has(id))) {
      grant(review, "review");
    }
  }
  return visible;
}

function contentOf(target: WorkOrder, grant: ArtifactGrant): string | null {
  if (grant === "self") return target.result ?? target.draft ?? null;
  if (isTerminal(target)) return target.result ?? target.error ?? target.draft ?? null;
  // A draft awaiting review is immutable and is exactly what the reviewer evaluates.
  if (grant === "subject" && target.draft) return target.draft;
  return null;
}

/**
 * Decide whether `order` may read `requestedId`, which is either a work-order
 * ID or `tool:<operationId>`. `threadRoots` are prior-run root orders listed
 * in the thread digest shown to this run.
 */
export function resolveArtifact(
  run: Run,
  order: WorkOrder,
  requestedId: string,
  threadRoots: Array<{ runId: string; order: WorkOrder }> = [],
): ArtifactDecision {
  const id = requestedId.trim();
  if (id.startsWith("tool:")) {
    const operationId = id.slice(5);
    const owners = new Set([order.id, ...chain(run, order, (item) => item.handoffFromOrderId).map((item) => item.id)]);
    const record = run.toolCalls.find((call) => call.id === operationId);
    if (!record || !owners.has(record.workOrderId)) {
      return { allowed: false, reason: "That tool result was not produced by this work order." };
    }
    if (record.result === null) return { allowed: false, reason: "That tool call has no recorded result." };
    return { allowed: true, grant: "tool", content: record.result, source: `${record.targetName} (${operationId})` };
  }

  const visible = visibleOrders(run, order).get(id);
  if (visible) {
    const content = contentOf(visible.order, visible.grant);
    if (content === null) {
      return { allowed: false, reason: "That work has not returned a result yet." };
    }
    return { allowed: true, grant: visible.grant, content, source: `${visible.grant} ${visible.order.id}` };
  }

  if (isRootChain(run, order)) {
    const prior = threadRoots.find((item) => item.order.id === id || item.runId === id);
    if (prior) {
      const content = prior.order.result ?? prior.order.error;
      if (content) return { allowed: true, grant: "thread", content, source: `thread run ${prior.runId}` };
    }
  }
  return {
    allowed: false,
    reason: "No relationship gives this work order access to that artifact (knowing its ID is not enough).",
  };
}
