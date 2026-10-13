/**
 * Order 5 — Provider Search Evidence, PHASE 0 (counters only).
 *
 * Pure observation of the web-search metadata that Perplexity's Agent response
 * already carried for one Research run's Perplexity slot. It answers, from
 * ordinary traffic, whether that metadata would satisfy the eligibility rules
 * a later capture slice intends to persist. It:
 *   - never reads the environment, never logs, never touches Firestore;
 *   - never mutates `rawResponse` and never throws on malformed provider data;
 *   - returns ONE closed, content-free aggregate (counts and enums only — no
 *     URL, domain, title, snippet, date string, question or answer text).
 *
 * Semantics: the entries are "the web-search results Perplexity returned for
 * its response in this run". Nothing stronger — not panel consensus, not a
 * source endorsement, not proof that any result was used for any statement.
 * Publication dates are provider-reported and unverified. `last_updated` is a
 * separate provider field and is never used as the publication date.
 *
 * Only the supported Agent shape is evidence: `output[]` items with
 * `type: "search_results"` (perplexityAgentResponse.agentSearchResultEntries).
 * The legacy Chat Completions shape — and any top-level `search_results` /
 * `citations` — is counted as legacy/unrecognised and is never evidence.
 */

import type { ModelResult } from "@/lib/types";
import { agentOutcome, agentSearchResultEntries, classifyAgentResponseShape, parsePerplexityAgentResponse } from "./perplexityAgentResponse";
import { screenSearchResultUrl } from "./searchResultUrlScreen";
import { retryStateAllowsProviderSearchEvidence } from "@/lib/adaptiveSchema/retryCorrection";

export const PROVIDER_SEARCH_EVIDENCE_PHASE0_EVENT = "[provider-search-evidence] Phase0 observation";

export type ObservedProvider = "perplexity" | "deepseek" | "other" | "absent";
export type ObservedResultStatus = "ok" | "substituted" | "error_or_other";
export type ObservedResponseShape = "agent" | "legacy_chat" | "malformed" | "absent";
export type ObservedAgentStatus = "completed" | "incomplete" | "failed" | "cancelled" | "in_progress" | "queued" | "other";

/** The retry dimension only (AR9). `not_applicable` = a non-adaptive run (no adaptive retry path existed). */
export type ObservedRetryEligibility = "not_applicable" | "eligible" | "ineligible" | "unknown";

export const PHASE0_INELIGIBILITY_REASONS = [
  "substituted",
  "provider_not_perplexity",
  "result_not_ok",
  "no_raw_response",
  "legacy_response",
  "malformed_response",
  "agent_not_completed_or_usable",
  "adaptive_state_unknown",
  "retry_ineligible",
  "no_search_results",
  "no_safe_result_entries",
] as const;
export type Phase0IneligibilityReason = (typeof PHASE0_INELIGIBILITY_REASONS)[number];

/**
 * The adaptive context of the run, as known to the run-execution layer:
 * - `none`: no adaptive plan (ordinary Research run);
 * - `unavailable`: an adaptive plan existed but finalization produced no
 *   trustworthy per-slot result (fails closed);
 * - `result`: the slot's finalized adaptive result (retry metadata only is read).
 */
export type AdaptiveSlotState =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "result"; retryOutcome: unknown; retried: unknown };

export interface ProviderSearchEvidencePhase0Observation {
  schemaVersion: 1;
  provider: ObservedProvider;
  resultStatus: ObservedResultStatus;
  responseShape: ObservedResponseShape;
  /** Agent run status (closed set); null unless the shape is `agent`. */
  agentStatus: ObservedAgentStatus | null;
  searchResultItems: number;
  resultEntries: number;
  /** Entries that are not objects (cannot carry a url/date). */
  malformedEntries: number;
  urlUsable: number;
  urlInvalid: number;
  urlOverLimit: number;
  privacyDroppedEntries: number;
  dateAbsent: number;
  dateValid: number;
  dateMalformed: number;
  dateFuture: number;
  lastUpdatedPresent: number;
  lastUpdatedAbsent: number;
  retryEligibility: ObservedRetryEligibility;
  /** Entries that would remain after URL validation and the privacy screen. */
  safeEntries: number;
  eligible: boolean;
  ineligibilityReason: Phase0IneligibilityReason | null;
}

const AGENT_STATUSES: readonly ObservedAgentStatus[] = ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** UTC calendar day `YYYY-MM-DD` of an instant. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strict publication-day classification of a provider `date` value.
 * absent: undefined, null or an empty/blank string. valid: exactly
 * `YYYY-MM-DD` naming a real calendar day (year 0001–9999, leap years
 * honoured) on or before the observation's UTC day. future: a valid day later
 * than the observation's UTC day. malformed: anything else (other formats,
 * datetimes, impossible days, non-strings). No "implausibly old" threshold in
 * Phase 0.
 */
export function classifyPublicationDate(value: unknown, observationDay: string): "absent" | "valid" | "malformed" | "future" {
  if (value === undefined || value === null) return "absent";
  if (typeof value !== "string") return "malformed";
  if (value.trim().length === 0) return "absent";
  const m = DAY.exec(value);
  if (!m) return "malformed";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return "malformed";
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return "malformed";
  return value > observationDay ? "future" : "valid";
}

function observedProvider(result: ModelResult): ObservedProvider {
  if (result.provider === "perplexity") return "perplexity";
  if (result.provider === "deepseek") return "deepseek";
  if (typeof result.provider === "string" && result.provider.length > 0) return "other";
  return "absent";
}

function retryDimension(adaptive: AdaptiveSlotState, slotStatus: string): ObservedRetryEligibility {
  if (adaptive.kind === "none") return "not_applicable";
  if (adaptive.kind === "unavailable") return "unknown";
  return retryStateAllowsProviderSearchEvidence({ slotStatus, retryOutcome: adaptive.retryOutcome, retried: adaptive.retried })
    ? "eligible"
    : "ineligible";
}

/**
 * Observe one Research run's Perplexity slot. `observedAt` fixes the UTC day
 * used for the `future` date class. Never throws.
 */
export function observeProviderSearchEvidence(args: {
  result: ModelResult;
  adaptive: AdaptiveSlotState;
  observedAt: Date;
}): ProviderSearchEvidencePhase0Observation {
  const { result, adaptive, observedAt } = args;
  const observationDay = utcDay(observedAt);

  const provider = observedProvider(result);
  const resultStatus: ObservedResultStatus = result.status === "ok" ? "ok" : result.status === "substituted" ? "substituted" : "error_or_other";
  const raw: unknown = result.rawResponse;
  const responseShape: ObservedResponseShape = raw === undefined || raw === null ? "absent" : classifyAgentResponseShape(raw);

  const counters = {
    searchResultItems: 0,
    resultEntries: 0,
    malformedEntries: 0,
    urlUsable: 0,
    urlInvalid: 0,
    urlOverLimit: 0,
    privacyDroppedEntries: 0,
    dateAbsent: 0,
    dateValid: 0,
    dateMalformed: 0,
    dateFuture: 0,
    lastUpdatedPresent: 0,
    lastUpdatedAbsent: 0,
    safeEntries: 0,
  };

  let agentStatus: ObservedAgentStatus | null = null;
  let agentUsable = false;

  if (responseShape === "agent") {
    const body = raw as Record<string, unknown>;
    const parsed = parsePerplexityAgentResponse(body);
    agentStatus = AGENT_STATUSES.includes(parsed.status as ObservedAgentStatus) ? (parsed.status as ObservedAgentStatus) : "other";
    const outcome = agentOutcome(parsed);
    agentUsable = outcome.kind === "ok" || outcome.kind === "truncated";

    const { items, entries } = agentSearchResultEntries(body.output as unknown[]);
    counters.searchResultItems = items;
    counters.resultEntries = entries.length;
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        counters.malformedEntries += 1;
        continue;
      }
      const screened = screenSearchResultUrl(entry.url);
      if (screened.kind === "usable") counters.urlUsable += 1;
      else if (screened.kind === "invalid") counters.urlInvalid += 1;
      else if (screened.kind === "over_limit") counters.urlOverLimit += 1;
      else counters.privacyDroppedEntries += 1;
      if (screened.kind === "usable") counters.safeEntries += 1;

      const dateClass = classifyPublicationDate(entry.date, observationDay);
      if (dateClass === "absent") counters.dateAbsent += 1;
      else if (dateClass === "valid") counters.dateValid += 1;
      else if (dateClass === "malformed") counters.dateMalformed += 1;
      else counters.dateFuture += 1;

      if (entry.last_updated !== undefined && entry.last_updated !== null) counters.lastUpdatedPresent += 1;
      else counters.lastUpdatedAbsent += 1;
    }
  }

  const retryEligibility = retryDimension(adaptive, result.status);

  let ineligibilityReason: Phase0IneligibilityReason | null = null;
  if (result.status === "substituted") ineligibilityReason = "substituted";
  else if (provider !== "perplexity") ineligibilityReason = "provider_not_perplexity";
  else if (result.status !== "ok") ineligibilityReason = "result_not_ok";
  else if (responseShape === "absent") ineligibilityReason = "no_raw_response";
  else if (responseShape === "legacy_chat") ineligibilityReason = "legacy_response";
  else if (responseShape === "malformed") ineligibilityReason = "malformed_response";
  else if (!agentUsable) ineligibilityReason = "agent_not_completed_or_usable";
  else if (retryEligibility === "unknown") ineligibilityReason = "adaptive_state_unknown";
  else if (retryEligibility === "ineligible") ineligibilityReason = "retry_ineligible";
  else if (counters.searchResultItems === 0 || counters.resultEntries === 0) ineligibilityReason = "no_search_results";
  else if (counters.safeEntries === 0) ineligibilityReason = "no_safe_result_entries";

  return {
    schemaVersion: 1,
    provider,
    resultStatus,
    responseShape,
    agentStatus,
    searchResultItems: counters.searchResultItems,
    resultEntries: counters.resultEntries,
    malformedEntries: counters.malformedEntries,
    urlUsable: counters.urlUsable,
    urlInvalid: counters.urlInvalid,
    urlOverLimit: counters.urlOverLimit,
    privacyDroppedEntries: counters.privacyDroppedEntries,
    dateAbsent: counters.dateAbsent,
    dateValid: counters.dateValid,
    dateMalformed: counters.dateMalformed,
    dateFuture: counters.dateFuture,
    lastUpdatedPresent: counters.lastUpdatedPresent,
    lastUpdatedAbsent: counters.lastUpdatedAbsent,
    retryEligibility,
    safeEntries: counters.safeEntries,
    eligible: ineligibilityReason === null,
    ineligibilityReason,
  };
}
