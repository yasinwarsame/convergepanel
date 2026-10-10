import { mergeGovernanceIntoBody, governanceFromRunDoc } from "@/lib/governance/teamGovernancePipeline";
import { resolveSynthesisRunAccess, SYNTHESIS_RUN_FORBIDDEN, SYNTHESIS_RUN_UNAVAILABLE } from "@/lib/synthesis/synthesisRunAccess";

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
 *
 * SYNTHESIS_LEGACY_OWNERSHIP_HARDENING: ownership now comes from the shared
 * `resolveSynthesisRunAccess` contract — a string `userId` equal to `uid`, or
 * nothing. A run with no (or a non-string) owner is no longer treated as
 * verified, a malformed (slash-containing) runId is denied before any lookup,
 * and a missing run is the same concealed 403 as a foreign one (it used to be
 * a 503, which told the caller the run did not exist). 503 remains only for a
 * genuine inability to check.
 */
export async function resolveInFlightDisclosureGate(runId: string, uid: string): Promise<InFlightDisclosureGateResult> {
  const access = await resolveSynthesisRunAccess(runId, uid);
  if (access.outcome === "unavailable") return { outcome: "denied", ...SYNTHESIS_RUN_UNAVAILABLE, reason: access.reason };
  if (access.outcome === "forbidden") return { outcome: "denied", ...SYNTHESIS_RUN_FORBIDDEN, reason: access.reason };

  const data = access.runData;
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
