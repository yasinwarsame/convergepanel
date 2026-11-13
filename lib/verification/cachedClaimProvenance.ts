/**
 * Cached claim verifications (Personal history, `localStorage`) and model-independence provenance.
 *
 * The Personal history caches each claim's full client payload. A payload cached before `modelIndependence` existed
 * does not record it, so it presents as "unverified" (claimConsensusPresentation.ts, fail closed) — even when the
 * user's own persisted verification proves ≥ 2 independent executing models, which the server-built history row
 * (`/api/user/panel-history`) already states. That left the history line ("· 92 consensus") and the opened detail
 * ("Consensus score withheld (model independence not recorded)") contradicting each other for the same record.
 *
 * The rule, in one place:
 *  - A payload that records its independence (`independent` / `insufficient` / `unverified`) is used as is.
 *  - A payload that does not is reconciled ONLY from authoritative evidence about the same record, read through the
 *    existing authenticated, owner-scoped APIs:
 *     1. the server history row for that record id (`storedVerificationConsensusIndependence` over the persisted
 *        document, computed by `/api/user/panel-history`) — adopted only when it is a definite "independent" or
 *        "insufficient";
 *     2. when the cached payload is opened and still records nothing, the record itself
 *        (`/api/user/verifications/{id}`, which maps the persisted document with the same function).
 *  - Nothing is inferred from the requested model slots or from the cached payload's own rows. When the authoritative
 *    record cannot be read, the cached payload is kept as it is — independence unrecorded, presented "unverified".
 * Stored data, scores and verdicts are never modified; only which payload is presented.
 *
 * Pure (the record read is injected) and client-safe.
 */

import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";

/** Whether a payload records its model independence (any of the three server-computed values). */
export function claimPayloadRecordsIndependence(payload: ClaimVerificationClientPayload | null | undefined): boolean {
  const v = payload?.modelIndependence;
  return v === "independent" || v === "insufficient" || v === "unverified";
}

/**
 * The payload to keep for one history id when a server history row arrives (`mergeHistoryById`, app/page.tsx).
 * `serverIndependence` is the independence the server computed for that record from its persisted rows. A payload that
 * already records independence is never changed; one that does not adopts a definite server value ("independent" /
 * "insufficient"); anything else leaves it unrecorded (so opening it reads the record).
 */
export function reconcileCachedClaimPayload(
  payload: ClaimVerificationClientPayload | null | undefined,
  serverIndependence: unknown
): ClaimVerificationClientPayload | undefined {
  if (!payload) return undefined;
  if (claimPayloadRecordsIndependence(payload)) return payload;
  if (serverIndependence === "independent" || serverIndependence === "insufficient") {
    return { ...payload, modelIndependence: serverIndependence };
  }
  return payload;
}

/** Reads the user's own persisted verification (authenticated detail API); null when it cannot be read. */
export type ClaimRecordLookup = () => Promise<ClaimVerificationClientPayload | null>;

export type ResolvedClaimHistoryPayload = {
  payload: ClaimVerificationClientPayload | null;
  /** True when `payload` is the record read through `lookup` (callers refresh the cached history item from it). */
  fromRecord: boolean;
};

/**
 * The payload to present when a saved claim is opened. A cached payload that records independence is presented as
 * cached. Otherwise (no cached payload, or one cached before independence was recorded) the persisted record is read
 * through `lookup`; when there is no lookup (signed out), it fails, or it returns nothing, the cached payload (if any)
 * is presented unchanged — independence unrecorded, i.e. "unverified".
 */
export async function resolveClaimHistoryPayload(
  verificationId: string,
  cached: ClaimVerificationClientPayload | null | undefined,
  lookup: ClaimRecordLookup | null
): Promise<ResolvedClaimHistoryPayload> {
  const asCached = (): ResolvedClaimHistoryPayload => ({
    payload: cached ? { ...cached, verificationId: cached.verificationId ?? verificationId } : null,
    fromRecord: false,
  });
  if (cached && claimPayloadRecordsIndependence(cached)) return asCached();
  if (!lookup) return asCached();
  try {
    const record = await lookup();
    if (record) return { payload: record, fromRecord: true };
  } catch {
    // Fall through: the record could not be read, so nothing is established.
  }
  return asCached();
}
