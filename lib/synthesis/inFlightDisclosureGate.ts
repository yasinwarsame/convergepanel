import { adminDb } from "@/lib/firebase/admin";
import { ERROR_CODES } from "@/lib/api/errorResponse";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { mergeGovernanceIntoBody, governanceFromRunDoc } from "@/lib/governance/teamGovernancePipeline";

export type InFlightDisclosureGateResult =
  | { outcome: "cache_hit"; body: Record<string, unknown> }
  | { outcome: "verified_no_cache" }
  | { outcome: "denied"; status: number; errorCode: string; message: string; reason: string };

/**
 * Phase 4B security re-review — the gate every request racing an in-flight
 * synthesis (`POST /api/synthesize-panel` when `inFlightSynthesis.get(runId)`
 * is already set) must pass before it is allowed to receive that in-flight
 * request's eventual result. Extracted into its own module specifically so
 * it can be unit-tested directly against every input combination — a
 * source-text/regex assertion on the call site cannot distinguish a
 * correctly-wired check from a disabled or misreferenced one.
 *
 * Fails closed on every non-owner-confirmed path, matching this file's own
 * established convention elsewhere (`RUN_LOOKUP_UNAVAILABLE` on a read
 * failure) rather than the lenient "continue anyway" this branch used to
 * have: `adminDb` unavailable, the Firestore read throwing, the run
 * document not (yet) existing, and a Workspace-integrity lookup throwing
 * are ALL treated as "cannot confirm ownership" and therefore denied —
 * never as permission to silently fall through to `await existing` and
 * disclose the in-flight request's result unverified.
 */
export async function resolveInFlightDisclosureGate(runId: string, uid: string): Promise<InFlightDisclosureGateResult> {
  const lookupUnavailable = (reason: string): InFlightDisclosureGateResult => ({
    outcome: "denied",
    status: 503,
    errorCode: ERROR_CODES.RUN_LOOKUP_UNAVAILABLE,
    message: "Could not verify this run right now. Please try again shortly.",
    reason,
  });
  const forbidden = (reason: string): InFlightDisclosureGateResult => ({
    outcome: "denied",
    status: 403,
    errorCode: ERROR_CODES.FORBIDDEN,
    message: "You don't have access to this run.",
    reason,
  });

  if (!adminDb) {
    return lookupUnavailable("admin_db_unavailable");
  }

  let runDoc;
  try {
    runDoc = await adminDb.collection("runs").doc(runId).get();
  } catch {
    return lookupUnavailable("run_lookup_threw");
  }
  if (!runDoc.exists) {
    // A legitimate concurrent request for a genuinely-not-yet-visible run
    // is indistinguishable, from here, from an attacker racing a runId
    // that may not even be real — ownership cannot be confirmed either
    // way, so this fails closed rather than falling through unchecked.
    return lookupUnavailable("run_not_found");
  }

  const data = runDoc.data() as Record<string, unknown>;
  const cachedRunUserId = data?.userId;
  if (cachedRunUserId !== undefined && cachedRunUserId !== uid) {
    return forbidden("owner_mismatch");
  }

  let integrity;
  try {
    integrity = await validateRunWorkspaceAssociation(data);
  } catch {
    return lookupUnavailable("workspace_integrity_check_threw");
  }
  if (integrity.classification === "invalid") {
    return forbidden(`workspace_run_integrity_failed:${integrity.reason}`);
  }

  if (data?.synthesizedStructuredReport && data?.schemaVersion === 1) {
    const gov = governanceFromRunDoc(data);
    return {
      outcome: "cache_hit",
      body: mergeGovernanceIntoBody(
        {
          ok: true,
          report: data.synthesizedStructuredReport,
          schemaVersion: 1,
          synthesizedBy: data.synthesizedBy || "gpt-5.1",
          cached: true,
        },
        gov
      ),
    };
  }

  return { outcome: "verified_no_cache" };
}
