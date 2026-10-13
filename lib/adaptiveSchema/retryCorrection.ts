/**
 * Adaptive retry correction (ADAPTIVE_RETRY_CORRECTION, AR1–AR4, AR8, AR9).
 *
 * Pure helpers for the one-shot corrective retry in orchestrate.ts:
 *
 * - the single retry-outcome enum (persisted on AdaptiveModelResult);
 * - mergeAdaptiveRetry(): AR1 full replacement when the first attempt has no
 *   usable data, AR2 gap-fill-only when it has partial salvage;
 * - normalizeAdaptiveRetryUsage() + AdaptiveRetryUsageSink: capture each real
 *   retry call's provider-reported usage exactly once per slot, then freeze;
 * - retryStateAllowsProviderSearchEvidence(): the AR9 contract for the
 *   future Provider Search Evidence capture (retry dimension only).
 *
 * Never imports Firestore; the supplemental accounting write lives in
 * lib/firestore/adaptiveRetryAccounting.ts.
 */

import type { ModelId, ModelResult } from "@/lib/types";
import { normalizeTokens, TokenUsageNormalized } from "@/lib/panel/normalizeTokens";
import type { AdaptiveModelResult } from "./types";

// ─── Outcome enum (AR8) ─────────────────────────────────────────────────────

export const ADAPTIVE_RETRY_OUTCOMES = [
  /** First attempt had no usable data; the validated retry replaced it in full. */
  "adopted_full",
  /** First attempt had partial salvage; the retry filled at least one unresolved field. */
  "adopted_partial",
  /** A retry response arrived but contributed no usable field; the first attempt stands. */
  "no_change",
  /** The retry call was issued but threw, timed out at the guard, or returned a non-ok status. */
  "failed_call",
  /** The retry was not issued: the remaining request budget was below the model's minimum window. */
  "skipped_budget",
  /** The slot was served by a substitute provider; no adaptive retry is ever issued for it. */
  "ineligible_substituted",
] as const;

export type AdaptiveRetryOutcome = (typeof ADAPTIVE_RETRY_OUTCOMES)[number];

export function isAdaptiveRetryOutcome(value: unknown): value is AdaptiveRetryOutcome {
  return typeof value === "string" && (ADAPTIVE_RETRY_OUTCOMES as readonly string[]).includes(value);
}

export type ParsedAdaptiveRetryOutcome =
  | { kind: "absent" }
  | { kind: "known"; outcome: AdaptiveRetryOutcome }
  | { kind: "unknown" };

/** Fail-closed reader for a persisted `retryOutcome`: anything present but not in the enum is "unknown", never coerced. */
export function parseAdaptiveRetryOutcome(raw: unknown): ParsedAdaptiveRetryOutcome {
  if (raw === undefined || raw === null) return { kind: "absent" };
  return isAdaptiveRetryOutcome(raw) ? { kind: "known", outcome: raw } : { kind: "unknown" };
}

// ─── Merge (AR1 / AR2) ──────────────────────────────────────────────────────

function rootFieldKey(path: string): string {
  return path.split(/[.[]/)[0];
}

/**
 * Merge a revalidated retry onto the first attempt.
 *
 * - AR1: `first.ok === false` (the validator guarantees `data === null`
 *   exactly then) and the retry validates → the retry's validated result is
 *   adopted in full under the first attempt's modelId/schemaId/latencyMs;
 *   no stale first-attempt parseError/invalidFields survive.
 * - AR2: `first.ok === true` with unresolved fields → every valid first
 *   value is kept by reference (byte-identical); the retry may only fill keys
 *   listed in `first.invalidFields`.
 * - Anything else → the first attempt stands unchanged (its parseError and
 *   invalidFields are never overwritten by the retry's), outcome "no_change".
 */
export function mergeAdaptiveRetry(
  first: AdaptiveModelResult,
  retried: AdaptiveModelResult
): { result: AdaptiveModelResult; outcome: "adopted_full" | "adopted_partial" | "no_change" } {
  const latency = first.latencyMs !== undefined ? { latencyMs: first.latencyMs } : {};

  if (!first.ok) {
    if (retried.ok && retried.data) {
      const { latencyMs: _ignoredRetryLatency, retried: _ignoredRetried, retryOutcome: _ignoredOutcome, ...retryRest } = retried;
      return {
        outcome: "adopted_full",
        result: {
          ...retryRest,
          modelId: first.modelId,
          schemaId: first.schemaId,
          retried: true,
          retryOutcome: "adopted_full",
          ...latency,
        },
      };
    }
    return { outcome: "no_change", result: { ...first, retried: true, retryOutcome: "no_change" } };
  }

  const unresolved = first.invalidFields || [];
  const adopted: string[] = [];
  const data: Record<string, any> = { ...(first.data || {}) };
  if (retried.ok && retried.data) {
    for (const key of unresolved) {
      if (Object.prototype.hasOwnProperty.call(retried.data, key) && retried.data[key] !== undefined) {
        data[key] = retried.data[key];
        adopted.push(key);
      }
    }
  }

  if (adopted.length === 0) {
    return { outcome: "no_change", result: { ...first, retried: true, retryOutcome: "no_change" } };
  }

  const adoptedSet = new Set(adopted);
  const keptFromFirst = new Set(Object.keys(first.data || {}));
  const stillInvalid = unresolved.filter((key) => !adoptedSet.has(key));
  const truncatedFields = Array.from(
    new Set([
      ...(first.truncatedFields || []).filter((key) => keptFromFirst.has(key)),
      ...(retried.truncatedFields || []).filter((key) => adoptedSet.has(key)),
    ])
  );
  const coercions = [
    ...(first.coercions || []).filter((c) => keptFromFirst.has(rootFieldKey(c.path))),
    ...(retried.coercions || []).filter((c) => adoptedSet.has(rootFieldKey(c.path))),
  ];

  return {
    outcome: "adopted_partial",
    result: {
      modelId: first.modelId,
      schemaId: first.schemaId,
      ok: true,
      data,
      retried: true,
      retryOutcome: "adopted_partial",
      ...latency,
      ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
      ...(stillInvalid.length > 0 ? { invalidFields: stillInvalid } : {}),
      ...(coercions.length > 0 ? { coercions } : {}),
    },
  };
}

// ─── Retry usage (AR4) ──────────────────────────────────────────────────────

/**
 * Provider-reported usage of one returned retry call, normalized through the
 * same normalizeTokens() the primary accounting uses. `null` when the
 * provider reported none (connectors collapse a missing usage block to 0, so
 * a zero total is indistinguishable from "not reported" and is never counted
 * as a real zero-cost call).
 */
export function normalizeAdaptiveRetryUsage(modelId: ModelId, result: ModelResult): TokenUsageNormalized | null {
  const usage = normalizeTokens(
    modelId,
    result.rawResponse || result,
    result.tokenUsage
      ? {
          promptTokens: result.tokenUsage.promptTokens ?? undefined,
          completionTokens: result.tokenUsage.completionTokens ?? undefined,
          totalTokens: result.tokenUsage.totalTokens,
        }
      : undefined
  );
  const finite = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  const totalTokens = finite(usage.totalTokens);
  if (totalTokens <= 0) return null;
  const reasoningTokens = finite(usage.reasoningTokens);
  return {
    promptTokens: finite(usage.promptTokens),
    completionTokens: finite(usage.completionTokens),
    totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

export interface AdaptiveRetryUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface AdaptiveRetryUsageModelEntry extends AdaptiveRetryUsageTotals {
  /** Retry provider calls issued for this model (at most one per slot). */
  calls: number;
  /** Of those, calls whose provider usage was unavailable (guard timeout, thrown call, or none reported) — never counted, never estimated. */
  usageUnavailableCalls: number;
}

/** Persisted on runs/{runId}.adaptiveRetryUsage. Normalized usage only — no prompts, text, or provider payloads. */
export interface AdaptiveRetryUsageV1 {
  schemaVersion: 1;
  calls: number;
  usageUnavailableCalls: number;
  totals: AdaptiveRetryUsageTotals;
  byModel: Record<string, AdaptiveRetryUsageModelEntry>;
}

function addUsage(target: AdaptiveRetryUsageTotals, usage: TokenUsageNormalized): void {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  if (usage.reasoningTokens) target.reasoningTokens = (target.reasoningTokens || 0) + usage.reasoningTokens;
}

/**
 * Collects retry usage for one run. Each slot records at most once (a second
 * record for the same slot is ignored), and once frozen every later record —
 * e.g. from a provider promise resolving after its guard — is ignored, so the
 * snapshot handed to accounting can never change underneath it.
 */
export class AdaptiveRetryUsageSink {
  private readonly slots = new Map<number, { modelId: ModelId; usage: TokenUsageNormalized | null }>();
  private frozenSnapshot: AdaptiveRetryUsageV1 | null | undefined = undefined;

  /** Returns true only when the record was accepted. */
  record(slotIndex: number, modelId: ModelId, usage: TokenUsageNormalized | null): boolean {
    if (this.frozenSnapshot !== undefined) return false;
    if (this.slots.has(slotIndex)) return false;
    this.slots.set(slotIndex, { modelId, usage });
    return true;
  }

  get isFrozen(): boolean {
    return this.frozenSnapshot !== undefined;
  }

  /** Freezes the sink (idempotent) and returns the run's retry usage, or null when no retry call was issued. */
  freeze(): AdaptiveRetryUsageV1 | null {
    if (this.frozenSnapshot !== undefined) return this.frozenSnapshot;
    if (this.slots.size === 0) {
      this.frozenSnapshot = null;
      return null;
    }
    const totals: AdaptiveRetryUsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const byModel: Record<string, AdaptiveRetryUsageModelEntry> = {};
    let usageUnavailableCalls = 0;
    const ordered = Array.from(this.slots.entries()).sort(([a], [b]) => a - b);
    for (const [, { modelId, usage }] of ordered) {
      const entry = (byModel[modelId] ||= { calls: 0, usageUnavailableCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      entry.calls += 1;
      if (usage) {
        addUsage(entry, usage);
        addUsage(totals, usage);
      } else {
        entry.usageUnavailableCalls += 1;
        usageUnavailableCalls += 1;
      }
    }
    this.frozenSnapshot = { schemaVersion: 1, calls: this.slots.size, usageUnavailableCalls, totals, byModel };
    return this.frozenSnapshot;
  }
}

// ─── Provider Search Evidence contract (AR9) ───────────────────────────────

/**
 * Retry dimension of the future Provider Search Evidence v1 eligibility —
 * contract only, no evidence is captured anywhere yet. `true` means the
 * retry state does not disqualify the ORIGINAL provider response; the
 * evidence capture must still apply every other eligibility rule itself.
 *
 * Eligible: no retry metadata and `retried !== true`; failed_call;
 * no_change; skipped_budget. Ineligible: adopted_full, adopted_partial,
 * ineligible_substituted, any substituted slot, an unknown persisted value,
 * and a legacy record with `retried === true` but no trustworthy outcome.
 */
export function retryStateAllowsProviderSearchEvidence(args: {
  slotStatus: ModelResult["status"] | string;
  retryOutcome: unknown;
  retried: unknown;
}): boolean {
  if (args.slotStatus === "substituted") return false;
  const parsed = parseAdaptiveRetryOutcome(args.retryOutcome);
  if (parsed.kind === "unknown") return false;
  if (parsed.kind === "absent") return args.retried !== true;
  return parsed.outcome === "failed_call" || parsed.outcome === "no_change" || parsed.outcome === "skipped_budget";
}
