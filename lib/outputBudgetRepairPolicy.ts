/**
 * Item 7B — output-budget repair policy (owner decisions D2/D5, 2026-11-24). Pure, client-safe, never throws.
 *
 * When a provider reports that a first attempt stopped at its output-token budget, the adaptive pipeline may issue
 * ONE repair call with a larger cap — but only for an exact provider/model listed here, and only when every bound holds:
 *   - the repair cap is greater than the configured first-attempt cap;
 *   - it is no more than floor(1.5 × the first-attempt cap);
 *   - it is no more than the 8,192-token policy ceiling (a ConvergePanel engineering policy, not a provider claim);
 *   - it is no more than the documented output limit of that exact model;
 *   - the repair is projected to finish inside the model's existing hard timeout and the remaining retry window.
 * These are upper bounds, never targets. Anything not listed — another model id, a changed first-attempt cap, an
 * unverified provider limit — gets NO repair (fail closed). First-attempt caps and timeouts are never changed here.
 *
 * Pinned entries (7B-0 characterization, docs checked 2026-11-24, owner-approved ceilings):
 *   - claude / claude-haiku-4-5-20251001: first 4,000; documented max output 64K
 *     (platform.claude.com/docs/en/about-claude/models/overview); repair ceiling 4,800 (owner-approved; below 1.5× because
 *     a full 4,000-token answer was measured at ~45 s against the 60 s hard timeout).
 *   - chatgpt / gpt-4o-mini: first 2,200; documented "16,384 max output tokens"
 *     (developers.openai.com/api/docs/models/gpt-4o-mini); repair ceiling 3,300 (= 1.5×).
 * Not listed (no repair):
 *   - gemini / gemini-3.5-flash-lite: first cap already 8,192 = the policy ceiling (documented limit 65,536).
 *   - grok: model set by GROK_MODEL; xAI publishes no first-party output limit for it.
 *   - perplexity / perplexity/sonar (Agent API): no first-party per-model output limit.
 */
import type { ModelId } from "@/lib/types";

export const OUTPUT_BUDGET_REPAIR_POLICY_CEILING = 8192;
export const OUTPUT_BUDGET_REPAIR_MAX_MULTIPLIER = 1.5;
/** Kept free after the projected repair duration, inside the model's own hard timeout and the retry guard. */
export const OUTPUT_BUDGET_REPAIR_TIMING_MARGIN_MS = 5_000;

export interface OutputBudgetRepairEntry {
  /** The exact provider model the connector sends. */
  providerModel: string;
  /** The configured first-attempt cap this entry was characterized against (MODEL_LIMITS). */
  firstAttemptCap: number;
  /** The provider's documented maximum output tokens for providerModel. */
  documentedOutputLimit: number;
  /** The owner-approved repair cap (an upper bound). */
  repairCap: number;
}

export const OUTPUT_BUDGET_REPAIR_CAPS: Readonly<Partial<Record<ModelId, OutputBudgetRepairEntry>>> = Object.freeze({
  claude: Object.freeze({ providerModel: "claude-haiku-4-5-20251001", firstAttemptCap: 4000, documentedOutputLimit: 64000, repairCap: 4800 }),
  chatgpt: Object.freeze({ providerModel: "gpt-4o-mini", firstAttemptCap: 2200, documentedOutputLimit: 16384, repairCap: 3300 }),
});

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** True when an entry satisfies every D2 bound against the given first-attempt cap. */
export function entrySatisfiesRepairBounds(entry: OutputBudgetRepairEntry, firstAttemptCap: number): boolean {
  if (!isPosInt(firstAttemptCap) || !isPosInt(entry.repairCap) || !isPosInt(entry.documentedOutputLimit)) return false;
  return (
    entry.firstAttemptCap === firstAttemptCap &&
    entry.repairCap > firstAttemptCap &&
    entry.repairCap <= Math.floor(firstAttemptCap * OUTPUT_BUDGET_REPAIR_MAX_MULTIPLIER) &&
    entry.repairCap <= OUTPUT_BUDGET_REPAIR_POLICY_CEILING &&
    entry.repairCap <= entry.documentedOutputLimit
  );
}

/**
 * The repair cap for this slot, or null when no compliant larger cap exists (D5: then no same-cap retry is issued for
 * confirmed exhaustion). `providerModel` must be the exact model the slot's connector sent.
 */
export function outputBudgetRepairCap(modelId: unknown, providerModel: unknown, firstAttemptCap: unknown): number | null {
  if (typeof modelId !== "string" || !Object.prototype.hasOwnProperty.call(OUTPUT_BUDGET_REPAIR_CAPS, modelId)) return null;
  const entry = OUTPUT_BUDGET_REPAIR_CAPS[modelId as ModelId];
  if (!entry || typeof providerModel !== "string" || providerModel !== entry.providerModel || !isPosInt(firstAttemptCap)) return null;
  return entrySatisfiesRepairBounds(entry, firstAttemptCap) ? entry.repairCap : null;
}

/**
 * Connector-side guard: the max_tokens a connector sends. A requested repair cap is honoured only when it is exactly the
 * pinned, bound-satisfying cap for this model; anything else falls back to the first-attempt cap.
 */
export function connectorMaxTokens(modelId: ModelId, providerModel: string, firstAttemptCap: number, requestedRepairCap: unknown): number {
  if (requestedRepairCap === undefined) return firstAttemptCap;
  const allowed = outputBudgetRepairCap(modelId, providerModel, firstAttemptCap);
  return allowed !== null && requestedRepairCap === allowed ? allowed : firstAttemptCap;
}

/**
 * Whether a repair at `repairCap` is projected to finish in time. The projection scales the first attempt's own measured
 * latency by the token ratio (the first attempt stopped at its budget, so its completion tokens ≈ its cap); it must leave
 * OUTPUT_BUDGET_REPAIR_TIMING_MARGIN_MS inside BOTH the model's hard timeout and the remaining retry guard. Any missing or
 * non-finite measurement means it cannot be shown to fit, so it does not run.
 */
export function outputBudgetRepairFitsWindow(args: {
  firstLatencyMs: unknown;
  firstCompletionTokens: unknown;
  repairCap: number;
  hardTimeoutMs: number;
  guardMs: number;
}): boolean {
  const { firstLatencyMs, firstCompletionTokens, repairCap, hardTimeoutMs, guardMs } = args;
  if (typeof firstLatencyMs !== "number" || !Number.isFinite(firstLatencyMs) || firstLatencyMs <= 0) return false;
  if (!isPosInt(firstCompletionTokens) || !isPosInt(repairCap)) return false;
  if (!Number.isFinite(hardTimeoutMs) || !Number.isFinite(guardMs)) return false;
  const projectedMs = (firstLatencyMs * repairCap) / firstCompletionTokens;
  return projectedMs + OUTPUT_BUDGET_REPAIR_TIMING_MARGIN_MS <= Math.min(hardTimeoutMs, guardMs);
}
