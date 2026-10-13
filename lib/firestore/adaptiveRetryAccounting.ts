/**
 * Supplemental accounting for adaptive corrective retries
 * (ADAPTIVE_RETRY_CORRECTION, AR4 + A2′).
 *
 * The primary panel accounting is unchanged and runs first:
 * `completeRun()` marks the run complete with the panel's own token totals,
 * then `incrementUserTokenUsage()` adds them to the user's period counter.
 * Adaptive finalization (which may issue one corrective retry per slot) runs
 * afterwards, so a platform kill during the retry can never leave a
 * provider-completed run stuck at "running".
 *
 * This module then adds the frozen retry usage in ONE Firestore transaction:
 *
 * - runs/{runId}: `adaptiveRetryUsage` (the per-run marker + normalized
 *   usage), and increments of the whole-run aggregates `totalTokens`,
 *   `tokenUsage.totals.*` and `tokensByProvider.<provider>`. The primary
 *   per-model records (`tokensByModel`, `tokenUsage.byModel`,
 *   `runDocument.perModel`) are never touched — they keep describing the
 *   original panel execution, so after a retry
 *   `totalTokens = Σ tokensByModel + adaptiveRetryUsage.totals.totalTokens`.
 * - users/{uid}: a plain `FieldValue.increment` of `tokensUsedCurrentPeriod`
 *   — never a second `incrementUserTokenUsage()` call, whose new-period
 *   branch SETs (resets) the counter for every user without
 *   `billingCycleStart` (the separately tracked free-user reset defect,
 *   deliberately not fixed here).
 *
 * Idempotency: the transaction reads the run first and does nothing when
 * `adaptiveRetryUsage` is already present, so a transaction retry (or any
 * re-entry) can never apply the increments twice; the run and user writes
 * commit atomically together or not at all.
 *
 * Never throws: every failure resolves to `{ status: "failed" }` and is
 * logged, and the caller's response is unaffected.
 */

import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { modelIdToProviderKey } from "@/lib/tokenExtraction";
import { logger } from "@/lib/logger";
import type { AdaptiveRetryUsageV1 } from "@/lib/adaptiveSchema/retryCorrection";

export type AdaptiveRetryUserCounterOutcome = "applied" | "skipped_primary_unconfirmed" | "no_reported_usage";

/** What runs/{runId}.adaptiveRetryUsage holds. */
export interface PersistedAdaptiveRetryUsageV1 extends AdaptiveRetryUsageV1 {
  userCounter: AdaptiveRetryUserCounterOutcome;
}

export interface AdaptiveRetryAccountingGates {
  /** `completeRun()` resolved in this request (the run is "complete" with primary totals). */
  completeRunSucceeded: boolean;
  /** The primary `incrementUserTokenUsage()` call resolved in this request (it may have added 0). */
  primaryUserAccountingSucceeded: boolean;
}

export type AdaptiveRetryAccountingResult =
  | { status: "no_retry_calls" }
  | { status: "skipped_primary_run_unconfirmed" }
  | { status: "run_missing" }
  | { status: "already_applied" }
  | { status: "applied"; userCounter: AdaptiveRetryUserCounterOutcome }
  | { status: "failed" };

function safePositive(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

export async function applyAdaptiveRetryAccounting(args: {
  runId: string;
  uid: string;
  usage: AdaptiveRetryUsageV1 | null;
  gates: AdaptiveRetryAccountingGates;
}): Promise<AdaptiveRetryAccountingResult> {
  const { runId, uid, usage, gates } = args;

  if (!usage || usage.calls <= 0) return { status: "no_retry_calls" };

  if (!gates.completeRunSucceeded) {
    // The run never reached its primary completion write: adding retry
    // usage would put partial totals on a "running" document.
    logger.warn("[adaptiveRetryAccounting] Supplemental retry accounting skipped: primary run accounting not confirmed", {
      runId,
      retryCalls: usage.calls,
      retryTotalTokens: usage.totals.totalTokens,
      usageUnavailableCalls: usage.usageUnavailableCalls,
    });
    return { status: "skipped_primary_run_unconfirmed" };
  }

  const totalTokens = safePositive(usage.totals.totalTokens);
  const promptTokens = safePositive(usage.totals.promptTokens);
  const completionTokens = safePositive(usage.totals.completionTokens);
  const reasoningTokens = safePositive(usage.totals.reasoningTokens);
  const byProvider: Record<string, number> = {};
  for (const [modelId, entry] of Object.entries(usage.byModel)) {
    const providerKey = modelIdToProviderKey(modelId);
    const modelTotal = safePositive(entry.totalTokens);
    if (providerKey && modelTotal > 0) byProvider[providerKey] = (byProvider[providerKey] || 0) + modelTotal;
  }

  const userCounter: AdaptiveRetryUserCounterOutcome =
    totalTokens <= 0 ? "no_reported_usage" : gates.primaryUserAccountingSucceeded ? "applied" : "skipped_primary_unconfirmed";

  try {
    if (!adminDb) throw new Error("Firestore is not available");
    const db = adminDb;
    const result = await db.runTransaction<AdaptiveRetryAccountingResult>(async (txn) => {
      const runRef = db.collection("runs").doc(runId);
      const snap = await txn.get(runRef);
      if (!snap.exists) return { status: "run_missing" };
      if (snap.data()?.adaptiveRetryUsage !== undefined) return { status: "already_applied" };

      const persisted: PersistedAdaptiveRetryUsageV1 = { ...usage, userCounter };
      const update: Record<string, unknown> = { adaptiveRetryUsage: persisted };
      if (totalTokens > 0) {
        update.totalTokens = FieldValue.increment(totalTokens);
        update["tokenUsage.totals.totalTokens"] = FieldValue.increment(totalTokens);
        if (promptTokens > 0) update["tokenUsage.totals.promptTokens"] = FieldValue.increment(promptTokens);
        if (completionTokens > 0) update["tokenUsage.totals.completionTokens"] = FieldValue.increment(completionTokens);
        if (reasoningTokens > 0) update["tokenUsage.totals.reasoningTokens"] = FieldValue.increment(reasoningTokens);
        for (const [providerKey, providerTotal] of Object.entries(byProvider)) {
          update[`tokensByProvider.${providerKey}`] = FieldValue.increment(providerTotal);
        }
      }
      txn.update(runRef, update);

      if (userCounter === "applied") {
        txn.set(
          db.collection("users").doc(uid),
          { tokensUsedCurrentPeriod: FieldValue.increment(totalTokens), updatedAt: FieldValue.serverTimestamp() },
          { merge: true }
        );
      }
      return { status: "applied", userCounter };
    });

    if (result.status === "applied" && userCounter === "skipped_primary_unconfirmed") {
      logger.warn("[adaptiveRetryAccounting] Supplemental user token increment skipped: primary user accounting not confirmed", {
        runId,
        retryTotalTokens: totalTokens,
      });
    }
    logger.info("[adaptiveRetryAccounting] Supplemental retry accounting", {
      runId,
      status: result.status,
      retryCalls: usage.calls,
      usageUnavailableCalls: usage.usageUnavailableCalls,
      retryTotalTokens: totalTokens,
      userCounter: result.status === "applied" ? result.userCounter : null,
    });
    return result;
  } catch (error: any) {
    logger.error("[adaptiveRetryAccounting] Supplemental retry accounting FAILED (primary accounting unaffected)", {
      runId,
      retryCalls: usage.calls,
      retryTotalTokens: totalTokens,
      errorName: error?.name,
      errorCode: error?.code,
      error: error?.message,
    });
    return { status: "failed" };
  }
}
