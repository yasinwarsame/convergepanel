/**
 * Evidence Workspace, Phase 11A.5B — Personal durable source-link read
 * resolution. Given a stored verification's persisted `origin` (untrusted
 * — Firestore is schemaless) and the authenticated caller who has ALREADY
 * been authorized to read that verification, determines whether the
 * source Deep Research run is CURRENTLY readable by that same caller and,
 * if so, whether the persisted `claimId` still identifies a valid finding
 * in the run's CURRENT canonical data.
 *
 * Read-only — performs exactly one Firestore read (`runs/{runId}`), zero
 * writes. Never throws: any failure (source missing, foreign/unreadable
 * run, malformed run, unsupported schema, malformed origin, stale/forged
 * fingerprint, or a genuine infrastructure hiccup) collapses uniformly to
 * `null` — this is enrichment for an otherwise-successful verification
 * read, never a reason to fail that read. This is a deliberate departure
 * from `resolveClaimVerificationOrigin()`'s own philosophy (which lets a
 * genuine Firestore outage reject rather than degrade, because ITS
 * caller's entire request depends on knowing which happened) — here, the
 * primary functionality (reading the verification) never depends on this
 * helper's outcome.
 *
 * Reuses `classifyRunWorkspaceBindingShape()` (the same structural
 * classifier `resolveClaimVerificationOrigin()` uses) and
 * `verifyDeepResearchClaimFingerprint()` (a factored-out piece of that
 * same resolver's own fingerprint check) rather than reimplementing
 * either. Deliberately does NOT call `resolveClaimVerificationOrigin()`
 * itself — that function's contract is scoped to the creation flow.
 *
 * Deliberately does NOT require `verification.projectId` to equal the
 * source run's current `projectId` — a run's project association can
 * legitimately change after the verification was created (see this
 * module's own client-DTO doc comment); the durable relationship is
 * runId+claimId only.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { classifyRunWorkspaceBindingShape } from "@/lib/workspaces/classifyRunWorkspaceBindingShape";
import { parsePersistedAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { verifyDeepResearchClaimFingerprint } from "./claimVerificationOrigin";
import type { ClaimVerificationSourceResearch } from "./claimVerificationClientPayload";

interface SupportedPersistedOriginShape {
  type: "deep_research_claim";
  runId: string;
  claimId: string;
}

/**
 * Defensive runtime validation of the persisted `origin` field — the
 * `ClaimVerificationOrigin` TypeScript type on `ClaimVerificationFirestoreDoc`
 * only describes the shape a well-behaved writer produces; Firestore
 * itself enforces nothing, so a historical/corrupted document could carry
 * anything under this key. Anything that doesn't match this exact shape
 * is treated identically to "no origin at all."
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

export async function resolvePersonalSourceResearchLink(args: {
  origin: unknown;
  callerUid: string;
}): Promise<ClaimVerificationSourceResearch | null> {
  if (!isSupportedPersistedOriginShape(args.origin)) return null;
  if (!adminDb) return null;

  const { runId, claimId } = args.origin;

  try {
    const snap = await adminDb.collection("runs").doc(runId).get();
    if (!snap.exists) return null;
    const raw = snap.data();
    if (!raw) return null;

    // Same structural classification resolveClaimVerificationOrigin()
    // uses for its Personal-scope check — a Team-bound (or malformed)
    // run can never satisfy Personal source linkage.
    const hasWorkspaceIdField = Object.prototype.hasOwnProperty.call(raw, "workspaceId");
    const shape = classifyRunWorkspaceBindingShape({
      hasWorkspaceIdField,
      workspaceIdValue: raw.workspaceId,
      userId: raw.userId,
    });
    if (shape.kind !== "legacy" && shape.kind !== "personal") return null;

    const owner = typeof raw.userId === "string" ? raw.userId : "";
    if (owner !== args.callerUid) return null;

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
    // verification's own (already-successful) read — see this module's
    // header comment.
    return null;
  }
}
