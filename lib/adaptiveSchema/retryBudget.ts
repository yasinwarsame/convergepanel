/**
 * Adaptive retry request budget (ADAPTIVE_RETRY_CORRECTION, AR5 + AR11).
 *
 * The two research execution routes (`app/api/run-panel/route.ts` and
 * `app/api/workspaces/[workspaceId]/runs/route.ts`) each export
 * `maxDuration = 300` as a literal (Next.js only reads a statically
 * analyzable segment-config literal, so it cannot import the constant
 * below); retryBudget.spec.ts pins both literals to
 * RESEARCH_ROUTE_MAX_DURATION_SECONDS so the two can never drift silently.
 *
 * The one-shot adaptive corrective retry runs inside finalizeAdaptiveRun(),
 * after the panel and primary accounting have already spent part of that
 * budget, and before the post-retry LLM work (alignment, synthesis) and the
 * persistence/governance writes. Its outer guard is therefore:
 *
 *   min(model hard timeout + 5 s, remaining request budget − 76 s reserve)
 *
 * and the retry is skipped outright (zero provider calls, retryOutcome
 * "skipped_budget") when that window is below the model's deterministic
 * minimum admission floor.
 *
 * The guard protects the HTTP request only. It does not abort the provider
 * request (connectors take no AbortSignal), so a guarded-out retry may still
 * complete and bill at the provider; its usage is unknowable to this process
 * and is recorded as unavailable, never as zero cost and never estimated.
 */

import type { ModelId } from "@/lib/types";
import { getModelTimeout } from "@/lib/modelConfig";

/** Route-level `maxDuration` (seconds) both research execution routes export. */
export const RESEARCH_ROUTE_MAX_DURATION_SECONDS = 300;

/** Internal request budget, derived from the single route duration constant. */
export const RESEARCH_REQUEST_BUDGET_MS = RESEARCH_ROUTE_MAX_DURATION_SECONDS * 1000;

/**
 * Reserve kept free after the retry guard for the work that still has to
 * finish inside the same request: the longest mutually exclusive post-retry
 * LLM branch (claim path: cluster 8 s + backfill 6 s + bias 12 s + coverage
 * 10 s + narrative 10 s + one regenerate 10 s = 56 s) plus a 20 s heuristic
 * margin for the persistence/governance/accounting Firestore writes (which
 * carry no explicit RPC deadline). retryBudget.spec.ts recomputes the 56 s
 * from the exported timeout constants.
 */
export const ADAPTIVE_RETRY_POST_RESERVE_MS = 76_000;

/** Write margin component of the reserve above (heuristic, not a bound). */
export const ADAPTIVE_RETRY_WRITE_MARGIN_MS = 20_000;

/** Added to the model's own hard timeout so the guard never cuts a connector that is still inside its own limit. */
export const ADAPTIVE_RETRY_HARD_TIMEOUT_MARGIN_MS = 5_000;

/** Deterministic minimum retry admission windows (no runtime latency lookup). */
export const ADAPTIVE_RETRY_DEFAULT_MIN_WINDOW_MS = 15_000;
export const ADAPTIVE_RETRY_MIN_WINDOW_MS: Partial<Record<ModelId, number>> = {
  // Observed Agent API latency reached ~28 s in the migration smoke; a window
  // below 30 s would mostly issue billed retries that are then abandoned.
  perplexity: 30_000,
};

export function adaptiveRetryMinimumWindowMs(modelId: ModelId): number {
  return ADAPTIVE_RETRY_MIN_WINDOW_MS[modelId] ?? ADAPTIVE_RETRY_DEFAULT_MIN_WINDOW_MS;
}

/** Monotonic clock (ms). Never wall-clock: immune to system clock adjustments. */
export function monotonicNowMs(): number {
  return performance.now();
}

/** The request's execution budget, captured at the very start of a research POST handler. */
export interface ResearchRequestBudget {
  /** Monotonic timestamp (ms) taken as the first statement of the POST handler. */
  startedAtMonoMs: number;
  budgetMs: number;
}

export function startResearchRequestBudget(now: () => number = monotonicNowMs): ResearchRequestBudget {
  return { startedAtMonoMs: now(), budgetMs: RESEARCH_REQUEST_BUDGET_MS };
}

export type AdaptiveRetryWindow =
  | { kind: "run"; guardMs: number; remainingMs: number; minimumMs: number }
  | { kind: "skip"; availableMs: number; remainingMs: number; minimumMs: number };

/**
 * Pure. Decides whether a retry may be issued now, and with which outer
 * guard. `availableMs` may be negative when the request is already past the
 * reserve; that is always a skip.
 */
export function computeAdaptiveRetryWindow(args: {
  modelId: ModelId;
  budget: ResearchRequestBudget;
  nowMonoMs: number;
}): AdaptiveRetryWindow {
  const { modelId, budget, nowMonoMs } = args;
  const elapsedMs = nowMonoMs - budget.startedAtMonoMs;
  const remainingMs = budget.budgetMs - elapsedMs;
  const availableMs = Math.min(
    getModelTimeout(modelId).hardTimeoutMs + ADAPTIVE_RETRY_HARD_TIMEOUT_MARGIN_MS,
    remainingMs - ADAPTIVE_RETRY_POST_RESERVE_MS
  );
  const minimumMs = adaptiveRetryMinimumWindowMs(modelId);
  if (!Number.isFinite(availableMs) || availableMs < minimumMs) {
    return { kind: "skip", availableMs, remainingMs, minimumMs };
  }
  return { kind: "run", guardMs: availableMs, remainingMs, minimumMs };
}
