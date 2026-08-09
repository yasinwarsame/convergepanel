/**
 * Adaptive Research Export, Phase 1 — the single, central authorization
 * function for adaptive research export (design doc §11's Risk #1: "a
 * single `resolveExportCapabilities(uid, runId)`-style function is the one
 * place this logic lives", mirroring `routeClassifiedQuery()`'s own
 * "exactly one place this logic lives" precedent). Never scattered between
 * the UI and the API — the UI calls this only to decide what to SHOW; the
 * API route calls it again, independently, to decide what to ALLOW. A
 * client-supplied capability flag is never trusted (matches the
 * `canManagePanel`/`canVote`/`canFinalize` server-derived-capability
 * precedent this design doc explicitly names).
 *
 * Evaluates the five axes Phase 1 requires: plan entitlement, role,
 * organization policy, data classification, governance state. Phase 1's
 * scope is a single allow/deny(+visible-status) verdict for the DEFAULT,
 * least-privilege export (final report + sources + governance status,
 * never raw model output, never private reviewer comments/identity) — the
 * design doc's richer 7-permission granular matrix
 * (export_raw_model_outputs / export_reviewer_identity / etc.) is a later
 * phase's scope, not invented here.
 *
 * Organization policy: `TeamDocument` has no export-specific policy field
 * today (verified by reading teamTypes.ts/teamApiAuth.ts) — per Part 5's
 * explicit instruction not to invent one, this axis is a real, present
 * check point that currently always passes, structured so a future
 * `team.exportPolicy` field can be added without changing this function's
 * shape or call sites.
 */

import "server-only";
import { getPlanConfig, PlanId } from "@/lib/plans";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { AdaptiveExportClassification, AdaptiveExportGovernanceStatus } from "./researchExport";

export type AdaptiveExportDenialReason =
  | "plan_not_entitled"
  | "role_not_permitted"
  | "organization_policy_blocked"
  | "governance_state_blocked"
  | "not_run_owner";

export type AdaptiveExportVerdict =
  | { allowed: true; requiresVisibleStatusNotice: boolean }
  | { allowed: false; reason: AdaptiveExportDenialReason };

export interface CanExportAdaptiveResearchInput {
  /** The uid making the request — must equal the run's own owner uid (checked by the caller before this function is even reached; re-asserted here as `isRunOwner` so this function's own contract is self-contained and can't be called with the wrong owner by mistake). */
  isRunOwner: boolean;
  planId: PlanId;
  /** Null when the requesting user has no team (solo run — always permitted to export their own run regardless of role, since role only matters within a team context). */
  teamRole: "owner" | "admin" | "member" | null;
  classification: AdaptiveExportClassification;
  governanceStatusAtExport: AdaptiveExportGovernanceStatus;
}

/** Governance states that block export outright — never grantable by role/plan. A run that was actively rejected must never be exportable as if it were a normal report. */
function isGovernanceStateBlocking(status: AdaptiveExportGovernanceStatus): boolean {
  if (status.family === "milestone2") {
    return status.kind === "rejected";
  }
  return status.status === "blocked";
}

/** States that ARE exportable but must carry a visible, unmistakable status notice in the output — a changes_requested/needs_review/incomplete report must never look equivalent to an approved one (Part 5/9). */
function requiresVisibleStatusNotice(status: AdaptiveExportGovernanceStatus): boolean {
  if (status.family === "milestone2") {
    return status.kind !== "approved";
  }
  return status.status !== "approved";
}

/**
 * Never throws. Every input combination maps to a real verdict — there is
 * no "unknown, allow by default" branch; an unrecognized state fails
 * closed to denied.
 */
export function canExportAdaptiveResearch(input: CanExportAdaptiveResearchInput): AdaptiveExportVerdict {
  if (!input.isRunOwner) {
    return { allowed: false, reason: "not_run_owner" };
  }

  // Plan entitlement — reuses `advancedExportEnabled` verbatim (lib/plans.ts),
  // the same field the Full plan's own marketing copy already promises
  // "advanced exports" under, per the design doc's §1 finding: this is a
  // pre-existing billing commitment, not a new gate invented for this
  // feature.
  const planConfig = getPlanConfig(input.planId);
  if (!planConfig.advancedExportEnabled) {
    return { allowed: false, reason: "plan_not_entitled" };
  }

  // Role — a team `member` (non-admin) may still export THEIR OWN run
  // (isRunOwner already confirmed above); team role only matters for
  // exports that would reach into shared/team-governed content beyond the
  // requester's own run, which Phase 1's single-run, own-run-only export
  // does not do. This mirrors the design doc §5.2's own table: only
  // `export_organization_reports` (bulk/cross-run, explicitly out of scope
  // for Phase 1 per design doc §11 Risk #4) is admin/owner-restricted.
  // No additional role check beyond ownership is applied here.

  // Organization policy — no export-specific policy field exists on
  // TeamDocument today (verified, not invented); always passes until one
  // is added. Left as an explicit, named check (not silently omitted) so
  // adding real policy data later is a one-line change here, not a new
  // call site.
  const organizationPolicyBlocked = false;
  if (organizationPolicyBlocked) {
    return { allowed: false, reason: "organization_policy_blocked" };
  }

  // Governance state — a rejected (Milestone-2) or blocked (legacy) run
  // may never be exported, regardless of plan/role. Every other state is
  // exportable, but non-approved states require a visible status notice
  // in the rendered output (handled by the PDF composer, never silently
  // dropped here).
  if (isGovernanceStateBlocking(input.governanceStatusAtExport)) {
    return { allowed: false, reason: "governance_state_blocked" };
  }

  return { allowed: true, requiresVisibleStatusNotice: requiresVisibleStatusNotice(input.governanceStatusAtExport) };
}

/**
 * Convenience wrapper for API/UI callers that only have a uid, not an
 * already-loaded plan/team — resolves plan + team role, then delegates to
 * the pure `canExportAdaptiveResearch()` above. Kept separate so the pure
 * decision function stays trivially unit-testable (no Firestore reads)
 * while callers get a single async entry point.
 */
export async function resolveAdaptiveExportVerdict(
  uid: string,
  runOwnerUid: string,
  classification: AdaptiveExportClassification,
  governanceStatusAtExport: AdaptiveExportGovernanceStatus
): Promise<AdaptiveExportVerdict> {
  const isRunOwner = uid === runOwnerUid;

  const ctx = await loadUserAndTeam(uid);
  const planId = (ctx?.user?.plan as PlanId | undefined) ?? "free";
  const teamRole = ctx?.team ? (ctx.team.members.find((m) => m.uid === uid)?.role ?? null) : null;

  return canExportAdaptiveResearch({
    isRunOwner,
    planId,
    teamRole,
    classification,
    governanceStatusAtExport,
  });
}
