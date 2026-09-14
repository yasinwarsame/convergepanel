/**
 * Project/Research Assignment (D4) — resolves a parsed `?assignee=me`
 * filter against the CALLER's own current eligibility for the target kind.
 * A stale assignee "is excluded from assignee-specific active views": the
 * stored field still names them, so a raw equality/array-contains query
 * would return their rows. Because the only filter value is `me`, the
 * caller's own eligibility is uniform across the whole page, so the
 * exclusion is exact and needs no per-row post-filter:
 *
 *   - Project view: any active member is an eligible Project assignee, and
 *     only active members reach the list route ⇒ never empty by rule.
 *   - Run view: eligible iff the caller's CURRENT capability set holds
 *     `research.create` (the same predicate `isEligibleAssignmentTarget("run")`
 *     applies at write time, expressed through the already-resolved
 *     capability set). Otherwise the active view is definitively empty —
 *     and no query is issued at all.
 *
 * Pure. Never an authorization decision: the caller's read access and
 * `research.read` were already established by the route.
 */

import "server-only";
import type { WorkspaceCapability } from "./capabilities";
import type { AssignmentTargetKind } from "./assignmentTargetEligibility";

export type ResolvedAssigneeFilter = { kind: "none" } | { kind: "uid"; uid: string } | { kind: "empty" };

export function resolveAssigneeFilterForCaller(args: { filter: "me" | null; uid: string; capabilities: readonly WorkspaceCapability[]; target: AssignmentTargetKind }): ResolvedAssigneeFilter {
  if (args.filter === null) return { kind: "none" };
  if (args.target === "run" && !args.capabilities.includes("research.create")) return { kind: "empty" };
  return { kind: "uid", uid: args.uid };
}
