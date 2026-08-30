/**
 * Evidence Workspace, Phase 11A.1 — the durable origin-linkage foundation
 * for "Deep Research finding -> Verify This Claim -> Claim Verification".
 * This module is read-only derivation only: no route wiring, no UI, no
 * persistence write. See the frozen Phase 11A.0C1 closure for the full
 * rationale; this header only restates the parts a reader of this file
 * specifically needs.
 *
 * FROZEN DATA CONTRACT — deliberately minimal. `workspaceId`, `projectId`,
 * a creator uid, a creation timestamp, and a separate claim-text snapshot
 * are NOT stored here: every one of them already has a canonical home
 * elsewhere (the verification document's own top-level `workspaceId`/
 * `projectId`/`userId`/`timestamp` fields, and — once the creation route is
 * wired in a later phase — the verification's own existing `claim: string`
 * field, which becomes the immutable historical snapshot the moment it is
 * written). Duplicating any of them inside `origin` would create a second
 * copy that could drift from the authoritative one; this type intentionally
 * cannot express that duplication.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import type { AggregatedResearchFinding } from "@/lib/adaptiveSchema/types";

export interface ClaimVerificationOrigin {
  type: "deep_research_claim";
  runId: string;
  claimId: string;
}

export type ClaimVerificationOriginDenialReason =
  | "run_not_found"
  | "not_deep_research"
  | "claim_not_found"
  | "not_owner"
  | "workspace_mismatch";

/**
 * `projectId` is returned alongside `origin` (not inside it, per the frozen
 * contract) so a later creation phase can derive the verification's own
 * top-level `projectId` from the source run without a second Firestore
 * read — see PROJECT CONTRACT in the 11A.0C1 closure.
 */
export type ClaimVerificationOriginResolution =
  | { status: "resolved"; origin: ClaimVerificationOrigin; claimText: string; projectId: string | null }
  | { status: "denied"; reason: ClaimVerificationOriginDenialReason }
  /**
   * A genuine infrastructure failure (Firestore unavailable) — deliberately
   * NOT one of the `denied` reasons above and never collapsed into
   * `run_not_found`. Named to match this codebase's existing convention for
   * the same failure mode (e.g. `listViewerTeamWorkspaces.ts`'s
   * `{ status: "lookup_failed" }`), not invented for this module.
   */
  | { status: "lookup_failed" };

/**
 * Exact-match only. Deliberately NOT fuzzy: no title matching, no summary
 * matching, no ID normalization, no fallback to array position — a claimId
 * that doesn't exist must be a clean, honest `claim_not_found`, never a
 * best-guess substitute for a different finding.
 */
export function findClaimInDeepResearchFindings(
  findings: AggregatedResearchFinding[],
  claimId: string
): AggregatedResearchFinding | null {
  return findings.find((f) => f.id === claimId) ?? null;
}

/**
 * Read-only. Performs exactly one Firestore document read (`runs/{runId}`)
 * and zero writes. Never accepts claim text, workspace/project/creator
 * metadata, or a schema type from the caller — every one of those is
 * derived here from the canonical run document, never trusted from input.
 *
 * TEAM MEMBERSHIP BOUNDARY (deliberate, see 11A.0C1 Part H): this function
 * checks only whether the canonical run's OWN `workspaceId` equals
 * `expectedWorkspaceId` — it does NOT check whether `callerUid` currently
 * has membership/capability in that workspace. That is the responsibility
 * of the existing Team route's Gate-1/Gate-2 authorization (already
 * required, and already re-derived independently, for every Team
 * verification creation) when a later phase wires this resolver into it.
 * Importing `resolveWorkspaceAccess`/`resolveTeamRunWorkspaceAccess`/
 * `roleHasCapability` here would duplicate that check against a boundary
 * this module has no business owning.
 *
 * FAILURE PRECEDENCE (frozen, tested): run_not_found -> workspace_mismatch
 * -> not_owner (Personal only) -> not_deep_research -> claim_not_found.
 * Scope is always resolved before the adaptive output is ever inspected,
 * so a scope-mismatched caller never learns anything about the run's
 * claim/schema contents.
 */
export async function resolveClaimVerificationOrigin(args: {
  runId: string;
  claimId: string;
  callerUid: string;
  expectedWorkspaceId: string | null;
}): Promise<ClaimVerificationOriginResolution> {
  if (!adminDb) {
    return { status: "lookup_failed" };
  }

  let raw: Record<string, unknown> | undefined;
  try {
    const snap = await adminDb.collection("runs").doc(args.runId).get();
    if (!snap.exists) {
      return { status: "denied", reason: "run_not_found" };
    }
    raw = snap.data();
  } catch {
    // Genuine Firestore failure — never reinterpreted as "no such run".
    return { status: "lookup_failed" };
  }

  if (!raw) {
    return { status: "denied", reason: "run_not_found" };
  }

  const runWorkspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId : null;

  if (args.expectedWorkspaceId === null) {
    // Caller expects a Personal-origin claim. A Team-scoped run can never
    // satisfy that expectation, regardless of who owns it.
    if (runWorkspaceId !== null) {
      return { status: "denied", reason: "workspace_mismatch" };
    }
    const owner = typeof raw.userId === "string" ? raw.userId : "";
    if (owner !== args.callerUid) {
      return { status: "denied", reason: "not_owner" };
    }
  } else {
    // Caller expects a Team-origin claim for a specific workspace. Both "no
    // workspace at all" (a Personal run) and "a different workspace" are
    // the same denial: the run does not belong to the expected scope.
    if (runWorkspaceId !== args.expectedWorkspaceId) {
      return { status: "denied", reason: "workspace_mismatch" };
    }
    // No ownership/membership check here by design — see TEAM MEMBERSHIP
    // BOUNDARY above.
  }

  const parsed = parsePersistedAdaptiveOutput(raw.adaptiveOutput);
  if (!parsed.ok || parsed.output.schemaId !== "deep_research") {
    return { status: "denied", reason: "not_deep_research" };
  }

  const candidates = [...parsed.output.result.findings, ...parsed.output.result.lowConfidenceFindings];
  const finding = findClaimInDeepResearchFindings(candidates, args.claimId);
  if (!finding) {
    return { status: "denied", reason: "claim_not_found" };
  }

  const projectId = typeof raw.projectId === "string" ? raw.projectId : null;

  return {
    status: "resolved",
    origin: { type: "deep_research_claim", runId: args.runId, claimId: args.claimId },
    claimText: finding.summary,
    projectId,
  };
}
