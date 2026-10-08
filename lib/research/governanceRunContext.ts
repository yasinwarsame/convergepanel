/**
 * Step 6.1 — run-level governance context for a persisted research result.
 *
 * The ONE place that decides which governance-context values a saved run shows,
 * on both the Personal report and the Team research detail (both reach it
 * through `interpretPersistedRunReadPayload()` and render it in
 * `PersistedResearchResultView`). Every value comes directly from a persisted
 * field the shared read builder (`buildRunReadPayload`) already emitted:
 *
 *   - "Evaluated under policy v<N>" — `adaptive.automatedGovernance.policyVersion`,
 *     only when the persisted automated status is a real evaluation outcome
 *     (`passed` / `flagged` / `blocked`). `not_evaluated` and `error` records
 *     also carry a version, but "evaluated under" would be untrue for them.
 *   - "Decided <age> (<date>)" — `adaptive.humanReview.reviewedAt`, only when
 *     the persisted human-review status is an actual decision.
 *   - "Time-sensitive question · generated <date>" — the persisted
 *     classification's `freshness` (`date_sensitive` / `recent` / `live`) and
 *     the output's `generatedAt`, read from the same envelope the result
 *     itself renders from (adaptive first, then legacy-adaptive).
 *
 * Missing or invalid data yields NO value — nothing is inferred, defaulted or
 * substituted. There is deliberately no comparison with the CURRENT policy.
 *
 * PURE and client-safe: no network, no Firestore, no clock unless the caller
 * passes one, no mutation of its input.
 */

export const EVALUATED_AUTOMATED_STATUSES = ["passed", "flagged", "blocked"] as const;
export const DECIDED_HUMAN_REVIEW_STATUSES = ["approved", "approved_with_conditions", "changes_requested", "rejected"] as const;
export const TIME_SENSITIVE_FRESHNESS = ["date_sensitive", "recent", "live"] as const;

export type GovernanceRunContext = {
  /** The policy version the run was evaluated under, or null. */
  policyVersion: number | null;
  /** ISO timestamp of the persisted human decision, or null. */
  decidedAt: string | null;
  /** ISO generation timestamp of a time-sensitive question's result, or null. */
  timeSensitiveGeneratedAt: string | null;
};

export const EMPTY_GOVERNANCE_RUN_CONTEXT: GovernanceRunContext = Object.freeze({
  policyVersion: null,
  decidedAt: null,
  timeSensitiveGeneratedAt: null,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === "string" && list.includes(value);
}

/** The single envelope the result renders from: a valid adaptive envelope wins, then a valid legacy-adaptive one. */
function renderedEnvelopeOutput(data: Record<string, unknown>): Record<string, unknown> | null {
  const adaptive = data.adaptive;
  if (isPlainObject(adaptive) && adaptive.status === "valid" && isPlainObject(adaptive.output)) {
    return adaptive.output;
  }
  const legacy = data.legacyAdaptive;
  if (isPlainObject(legacy) && legacy.status === "valid" && isPlainObject(legacy.output)) {
    return legacy.output;
  }
  return null;
}

/** Derives the context from a successful persisted-run read body. Never throws. */
export function deriveGovernanceRunContext(raw: unknown): GovernanceRunContext {
  if (!isPlainObject(raw)) return EMPTY_GOVERNANCE_RUN_CONTEXT;
  const adaptive = isPlainObject(raw.adaptive) && raw.adaptive.status === "valid" ? raw.adaptive : null;

  let policyVersion: number | null = null;
  const automated = adaptive && isPlainObject(adaptive.automatedGovernance) ? adaptive.automatedGovernance : null;
  if (
    automated &&
    includes(EVALUATED_AUTOMATED_STATUSES, automated.status) &&
    typeof automated.policyVersion === "number" &&
    Number.isSafeInteger(automated.policyVersion) &&
    automated.policyVersion >= 1
  ) {
    policyVersion = automated.policyVersion;
  }

  let decidedAt: string | null = null;
  const review = adaptive && isPlainObject(adaptive.humanReview) ? adaptive.humanReview : null;
  if (review && includes(DECIDED_HUMAN_REVIEW_STATUSES, review.status) && isValidTimestamp(review.reviewedAt)) {
    decidedAt = review.reviewedAt;
  }

  let timeSensitiveGeneratedAt: string | null = null;
  const output = renderedEnvelopeOutput(raw);
  const classification = output && isPlainObject(output.classification) ? output.classification : null;
  if (classification && includes(TIME_SENSITIVE_FRESHNESS, classification.freshness) && isValidTimestamp(output?.generatedAt)) {
    timeSensitiveGeneratedAt = output.generatedAt as string;
  }

  return { policyVersion, decidedAt, timeSensitiveGeneratedAt };
}

export type GovernanceContextFormatOptions = { locale?: string; timeZone?: string };

export function formatGovernanceContextDate(iso: string, options: GovernanceContextFormatOptions = {}): string {
  return new Date(iso).toLocaleDateString(options.locale, { dateStyle: "medium", timeZone: options.timeZone });
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** Elapsed time from `thenMs` to `nowMs`, coarsest whole unit. A future or sub-minute value is "just now". */
export function formatDecisionAge(thenMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return plural(days, "day");
  if (days < 365) return plural(Math.floor(days / 30), "month");
  return plural(Math.floor(days / 365), "year");
}

export type GovernanceRunContextLine = { key: "policy" | "decided" | "time_sensitive"; text: string };

/** The display lines, in a fixed order; empty when no value is present. */
export function governanceRunContextLines(
  context: GovernanceRunContext,
  nowMs: number,
  options: GovernanceContextFormatOptions = {}
): GovernanceRunContextLine[] {
  const lines: GovernanceRunContextLine[] = [];
  if (context.policyVersion !== null) {
    lines.push({ key: "policy", text: `Evaluated under policy v${context.policyVersion}` });
  }
  if (context.decidedAt !== null) {
    const age = formatDecisionAge(Date.parse(context.decidedAt), nowMs);
    lines.push({ key: "decided", text: `Decided ${age} (${formatGovernanceContextDate(context.decidedAt, options)})` });
  }
  if (context.timeSensitiveGeneratedAt !== null) {
    lines.push({
      key: "time_sensitive",
      text: `Time-sensitive question · generated ${formatGovernanceContextDate(context.timeSensitiveGeneratedAt, options)}`,
    });
  }
  return lines;
}
