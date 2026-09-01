/**
 * Evidence Workspace, Phase 11A.5C — Team durable source-link read
 * resolution. Applies the exact 11A.5B pattern (persisted internal
 * `origin` -> current source authorization -> canonical fingerprint
 * revalidation -> minimal client-safe DTO -> fail soft to `null`) to
 * Team-scoped stored verifications, but independently proves the
 * TEAM-specific authorization boundary rather than reusing
 * `resolvePersonalSourceResearchLink()`'s ownership logic — Team run
 * read is capability/membership-based, not owner-based, and the two
 * helpers must remain isolated so a change to one can never silently
 * alter the other.
 *
 * ============== PROVENANCE CONTAINMENT (CRITICAL) ==============
 * A Team verification's `origin.runId` must resolve to a run that is
 * CURRENTLY, STRUCTURALLY bound to the SAME Workspace the verification
 * itself belongs to (`args.expectedWorkspaceId`, the verification's own
 * persisted `workspaceId` — never the caller's choice). This is checked
 * even though the caller has, by the time this function is called,
 * already been proven to have `research.read` on that exact Workspace
 * (the route re-derives that access independently below anyway, per the
 * "always re-derive, never assume it still holds" discipline this
 * codebase already applies at Team Claim Verification creation's
 * Gate 1/Gate 2). Critically, a caller's access to some OTHER Workspace
 * the source run happens to actually live in is irrelevant and is never
 * checked — this function only ever authorizes against
 * `expectedWorkspaceId`, so a corrupted/forged origin pointing at a
 * foreign Workspace's run fails the containment check regardless of
 * what else the caller can see.
 *
 * Read-only — performs exactly the Workspace/membership reads
 * `resolveTeamRunWorkspaceAccess()` itself performs, plus exactly one
 * `runs/{runId}` read, zero writes. Never throws: any failure (source
 * missing, wrong Workspace, revoked/removed membership, malformed run,
 * unsupported schema, malformed origin, stale/forged fingerprint, or a
 * genuine infrastructure hiccup) collapses uniformly to `null` — this is
 * enrichment for an otherwise-successful verification read, never a
 * reason to fail that read.
 *
 * Reuses `resolveTeamRunWorkspaceAccess()` (the exact authoritative Team
 * access resolver this route's own verification-read check already
 * uses — never a manually copied/reimplemented authorization rule),
 * `classifyRunWorkspaceBindingShape()` (the same pure structural
 * classifier `resolveClaimVerificationOrigin()` uses for its own
 * Team-scope check), and `verifyDeepResearchClaimFingerprint()` (the
 * shared, now dual-protected fingerprint primitive). Deliberately does
 * NOT call `resolveClaimVerificationOrigin()` itself — that function's
 * contract is scoped to the creation flow — and does NOT invent a
 * project-level ACL: Team Projects currently have none (11A.5A), and
 * authorization here is fully delegated to `resolveTeamRunWorkspaceAccess()`
 * so any future project-ACL layer added there is inherited automatically,
 * with no DTO or call-site redesign required.
 *
 * Deliberately does NOT require `verification.projectId` to equal the
 * source run's current `projectId` — see resolvePersonalSourceResearchLink.ts's
 * identical rationale; the durable relationship is runId+claimId+Workspace
 * containment, never current project equality.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { classifyRunWorkspaceBindingShape } from "@/lib/workspaces/classifyRunWorkspaceBindingShape";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { verifyDeepResearchClaimFingerprint } from "./claimVerificationOrigin";
import type { ClaimVerificationSourceResearch } from "./claimVerificationClientPayload";

interface SupportedPersistedOriginShape {
  type: "deep_research_claim";
  runId: string;
  claimId: string;
}

/**
 * Defensive runtime validation of the persisted `origin` field — same
 * discipline as resolvePersonalSourceResearchLink.ts's identical check
 * (deliberately duplicated rather than shared, so the two Team/Personal
 * helpers remain fully independent files with no coupling between their
 * authorization paths).
 */
function isSupportedPersistedOriginShape(value: unknown): value is SupportedPersistedOriginShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "deep_research_claim" &&
    typeof v.runId === "string" &&
    v.runId.length > 0 &&
    typeof v.claimId === "string" &&
    v.claimId.length > 0
  );
}

export async function resolveTeamSourceResearchLink(args: {
  origin: unknown;
  callerUid: string;
  /**
   * The verification's OWN persisted `workspaceId` — never a
   * caller-supplied or otherwise-derived value. This is the authoritative
   * provenance boundary the source run must structurally belong to.
   */
  expectedWorkspaceId: string;
}): Promise<ClaimVerificationSourceResearch | null> {
  if (!isSupportedPersistedOriginShape(args.origin)) return null;
  if (!adminDb) return null;

  const { runId, claimId } = args.origin;

  try {
    // Independently re-derive current Team access against the
    // verification's own Workspace — never trusts that the route's own
    // (already-passed) check still holds by the time this async call
    // runs.
    const access = await resolveTeamRunWorkspaceAccess({ uid: args.callerUid, workspaceId: args.expectedWorkspaceId });
    if (!access.granted) return null;
    if (!access.capabilities.includes("research.read")) return null;

    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) return null;
    const raw = snap.data();
    if (!raw) return null;

    // Provenance containment (CRITICAL): the source run must be
    // structurally bound to the SAME Workspace the verification itself
    // belongs to — never merely "some Workspace the caller can access."
    const hasWorkspaceIdField = Object.prototype.hasOwnProperty.call(raw, "workspaceId");
    const shape = classifyRunWorkspaceBindingShape({
      hasWorkspaceIdField,
      workspaceIdValue: raw.workspaceId,
      userId: raw.userId,
    });
    if (shape.kind !== "non_personal_bound" || shape.workspaceId !== args.expectedWorkspaceId) return null;

    const parsed = parsePersistedAdaptiveOutput(raw.adaptiveOutput);
    if (!parsed.ok || parsed.output.schemaId !== "deep_research") return null;

    const result = parsed.output.result;
    if (!Array.isArray(result.findings) || !Array.isArray(result.lowConfidenceFindings)) return null;

    const fingerprintMatches = verifyDeepResearchClaimFingerprint({
      runId,
      claimId,
      findings: result.findings,
      lowConfidenceFindings: result.lowConfidenceFindings,
    });
    if (!fingerprintMatches) return null;

    return { type: "deep_research_claim", runId, claimId };
  } catch {
    // A genuine infrastructure failure here must never fail the
    // verification's own (already-successful) read.
    return null;
  }
}
