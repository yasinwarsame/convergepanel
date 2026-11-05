/**
 * #290 Increment 1 — the four trust signals of the readable layout, as a pure view model.
 *
 *   1. Verification gate — the stored gate status word (gatePresentation's D6 words, read through pageGateValue so it is
 *      the same stored value the rest of the page shows) and the gate's stored inputs. No cause is written: the gate
 *      stores no reasons, so the inputs are listed, never explained.
 *   2. Panel coverage — responded vs dispatched slots, from the run's recorded per-slot status (RunSlotStatusContext);
 *      a failed slot counts as dispatched, never as responded. Plus claims with positions from 2+ models.
 *   3. Sources — named sources over the values this schema asks models to source (metric `source`, factual_lookup's
 *      `source`; the same values trustSummary.computeCitationScore reads). No sourceable values → "N/A (not
 *      requested)"; zero named → "None recorded". Never a percentage.
 *   4. Model behaviour score — the stored overallTrust, relabelled for what it is. Not recomputed. When the schema asks
 *      for no sources, the panel says its citation part was counted as full marks.
 *
 * Every number shown is a stored number or a count of stored items. Nothing here changes a gate, a score, a status or
 * a stored record. UI-only and pure (readableImportBoundary.spec.ts).
 */
import type {
  AdaptiveGateResult,
  AdaptiveGateStatus,
  AdaptiveModelResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  Metric,
  ResultSchema,
} from "@/lib/adaptiveSchema/types";
import { GATE_THRESHOLDS } from "@/lib/adaptiveSchema/config";
import { GATE_STATUS_WORD, gateNotice, hasGatePresentation, pageGateValue, readGateStatus, type GateDisplayStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { READABLE_GATE_COPY as G, READABLE_TRUST_COPY as C } from "./copy";

export type TrustSignalId = "gate" | "coverage" | "sources" | "behaviour";

export interface TrustSignal {
  id: TrustSignalId;
  name: string;
  definition: string;
  /** The one-line value, always words or counts — never colour alone. */
  value: string;
  /** Further plain lines (stored inputs, notices, caveats), in display order. */
  details: string[];
  /** A machine-readable state for tests and styling; never shown on its own. */
  state: string;
}

export interface TrustSignalsInput {
  schema: Pick<ResultSchema, "id" | "fields">;
  results: AdaptiveModelResult[];
  alignedClaims?: AlignedClaim[] | null;
  gate?: AdaptiveGateResult | null;
  synthesisReport?: Pick<AdaptiveSynthesisReport, "gate" | "presentation"> | null;
  trustSummary?: AdaptiveTrustSummary | null;
  /** The run's recorded per-slot call status (RunSlotStatusContext); null when the page was not handed it. */
  slotStatuses: ReadonlyMap<string, string> | null;
}

const pct = (x: number) => Math.round(x * 100);
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

// ── 1. Verification gate ────────────────────────────────────────────────────

export interface StoredGateInput {
  gate?: AdaptiveGateResult | null;
  synthesisReport?: Pick<AdaptiveSynthesisReport, "gate" | "presentation"> | null;
  /** The report type; only factual_lookup changes the rule (gate.ts caps its otherwise-passing gate at caution). */
  schemaId?: string;
}

/**
 * Whether a LEGACY report's stored gate agrees with the gate's own stored inputs. Read-only: nothing is written,
 * nothing corrected, and no gate is ever shown in place of the stored one.
 *
 *   - "not_applicable": the report carries the Order 4 presentation (its wording is unchanged), or the page's stored
 *     gate value (pageGateValue) is not a known status (D8 "Unrecognized" already shows no result).
 *   - "inconsistent", either:
 *       (a) the report's stored gate and the gate object's stored status are both strings and differ (two stored
 *           results for one run); or
 *       (b) the gate's recorded loadBearingClaims list (when stored) does not hold loadBearingSplitCount claims with
 *           status "split"; or
 *       (c) gate.ts's decision for the recorded inputs (runCertainty, loadBearingSplitCount; GATE_THRESHOLDS) is not
 *           the stored status — fail when splits >= 2 or certainty < cautionMin; else pass when certainty >= passMin
 *           and splits === 0; else caution. factual_lookup alone may store caution where that decision is pass (gate.ts
 *           caps it on a split anywhere in the rows).
 *   - "inputs_not_recorded": no (a), and runCertainty or loadBearingSplitCount is not stored as a finite number (a
 *     non-negative integer count): nothing to check the stored status against. Missing is not inconsistent.
 *   - "consistent": otherwise.
 * The rows are not re-scored: the check reads the inputs the gate recorded (and the trust signal shows), not a fresh
 * salience sort of the claims.
 */
export type StoredGateConsistency = "not_applicable" | "inconsistent" | "inputs_not_recorded" | "consistent";

/** gate.ts's decision on its two recorded inputs (computeAdaptiveGate without the factual_lookup row cap). */
function ruleStatus(certainty: number, loadBearingSplits: number): AdaptiveGateStatus {
  if (loadBearingSplits >= 2 || certainty < GATE_THRESHOLDS.cautionMin) return "fail";
  if (certainty >= GATE_THRESHOLDS.passMin && loadBearingSplits === 0) return "pass";
  return "caution";
}

export function storedGateConsistency({ gate, synthesisReport, schemaId }: StoredGateInput): StoredGateConsistency {
  if (!gate && !synthesisReport) return "not_applicable";
  if (hasGatePresentation(synthesisReport)) return "not_applicable";
  const shown = readGateStatus(pageGateValue(synthesisReport ?? null, gate?.status));
  if (shown === "unrecognized") return "not_applicable";
  if (synthesisReport && gate && typeof gate.status === "string" && typeof synthesisReport.gate === "string" && gate.status !== synthesisReport.gate) return "inconsistent";
  const certainty = gate?.runCertainty;
  const splits = gate?.loadBearingSplitCount;
  if (!isFiniteNumber(certainty) || !isFiniteNumber(splits) || !Number.isInteger(splits) || splits < 0) return "inputs_not_recorded";
  if (Array.isArray(gate!.loadBearingClaims) && gate!.loadBearingClaims.filter((c) => c?.status === "split").length !== splits) return "inconsistent";
  const expected = ruleStatus(certainty, splits);
  if (expected === shown) return "consistent";
  if (schemaId === "factual_lookup" && expected === "pass" && shown === "caution") return "consistent";
  return "inconsistent";
}

/**
 * The readable gate banner's words for a legacy report (AdaptiveSynthesisReportView's LegacyGateBannerLabels): the
 * stored word with what kind of check the gate is, or — on an inconsistent record — the unavailable statement for every
 * status, so no gate result is shown.
 */
export function readableLegacyGateBannerLabels(input: StoredGateInput): Readonly<Record<AdaptiveGateStatus, string>> {
  if (storedGateConsistency(input) !== "inconsistent") return G.legacyBanner;
  return { pass: G.inconsistentBanner, caution: G.inconsistentBanner, fail: G.inconsistentBanner };
}

export function gateSignal(input: Pick<TrustSignalsInput, "gate" | "synthesisReport"> & { schemaId?: string }): TrustSignal {
  const base = { id: "gate" as const, name: C.gateName, definition: C.gateDefinition };
  const { gate, synthesisReport } = input;
  if (!gate && !synthesisReport) return { ...base, value: C.gateNotRecorded, details: [C.gateNotRecordedDetail], state: "not_recorded" };

  // The stored value the rest of the page shows (F4): the report's copy when a report exists.
  const status: GateDisplayStatus = readGateStatus(pageGateValue(synthesisReport ?? null, gate?.status));
  const inconsistent = storedGateConsistency(input) === "inconsistent";
  const details: string[] = [];
  const notice = inconsistent ? null : gateNotice(status);
  // D8: an unrecognized stored value supports no verification result, so its stored inputs are not presented beside it.
  if (status !== "unrecognized") {
    if (gate && isFiniteNumber(gate.runCertainty) && isFiniteNumber(gate.loadBearingSplitCount) && Array.isArray(gate.loadBearingClaims)) {
      details.push(`${C.gateInputsHeading}: ${C.gateCertainty(pct(gate.runCertainty))}; ${C.gateSplitTop(gate.loadBearingSplitCount, gate.loadBearingClaims.length)}`);
    } else {
      details.push(C.gateInputsNotRecorded);
    }
  }
  if (inconsistent) return { ...base, value: G.inconsistentValue, details: [...details, G.inconsistentDetail], state: "inconsistent" };
  if (notice) details.push(notice);
  return { ...base, value: GATE_STATUS_WORD[status], details, state: status };
}

// ── 2. Panel coverage ───────────────────────────────────────────────────────

export interface CoverageCounts {
  dispatched: number;
  /** ok + substituted: a slot that produced a response, from its own model or a substitute. */
  responded: number;
  /** The part of `responded` answered by a substitute model, never by the model that was asked. */
  substituted: number;
  notResponded: number;
  unknown: number;
}

/** Counts the recorded slot statuses: ok / substituted responded; any other recorded status did not; blank is unknown. */
export function coverageCounts(slotStatuses: ReadonlyMap<string, string> | null): CoverageCounts | null {
  if (!slotStatuses || slotStatuses.size === 0) return null;
  let responded = 0;
  let substituted = 0;
  let notResponded = 0;
  let unknown = 0;
  for (const status of slotStatuses.values()) {
    if (typeof status !== "string" || status.length === 0) unknown += 1;
    else if (status === "ok") responded += 1;
    else if (status === "substituted") {
      responded += 1;
      substituted += 1;
    }
    else notResponded += 1;
  }
  return { dispatched: slotStatuses.size, responded, substituted, notResponded, unknown };
}

/** Claims whose non-empty cells come from at least two distinct models, out of all claims. */
export function claimsWithMultipleModels(alignedClaims: AlignedClaim[] | null | undefined): { multi: number; total: number } {
  const claims = Array.isArray(alignedClaims) ? alignedClaims : [];
  let multi = 0;
  for (const claim of claims) {
    const models = new Set<string>();
    for (const cell of Array.isArray(claim?.cells) ? claim.cells : []) if (cell && typeof cell.modelId === "string") models.add(cell.modelId);
    if (models.size >= 2) multi += 1;
  }
  return { multi, total: claims.length };
}

export function coverageSignal(input: Pick<TrustSignalsInput, "results" | "alignedClaims" | "slotStatuses">): TrustSignal {
  const base = { id: "coverage" as const, name: C.coverageName, definition: C.coverageDefinition };
  const counts = coverageCounts(input.slotStatuses);
  const details: string[] = [];
  let value: string;
  let state: string;
  if (counts) {
    value = C.coverageResponded(counts.responded, counts.dispatched, counts.substituted);
    state = counts.unknown > 0 ? "partial_status" : "recorded";
    if (counts.substituted > 0) details.push(C.coverageSubstitutedDetail(counts.substituted));
    if (counts.unknown > 0) details.push(C.coverageUnknownStatus(counts.unknown, counts.dispatched));
  } else {
    value = C.coverageNoStatus;
    state = "not_recorded";
    details.push(C.coverageModelsInReport(input.results.length));
  }
  const claims = claimsWithMultipleModels(input.alignedClaims);
  details.push(claims.total > 0 ? C.coverageClaims(claims.multi, claims.total) : C.coverageNoClaims);
  return { ...base, value, details, state };
}

// ── 3. Sources ──────────────────────────────────────────────────────────────

/** Same rule as trustSummary.isRealSource (server-only there): blank, "unknown", "none" and "n/a" name no source. */
export function namesASource(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "unknown" && normalized !== "none" && normalized !== "n/a";
}

/** The values this schema asks models to source, over the responses that parsed — the set computeCitationScore reads. */
export function sourceableValueCounts(schema: Pick<ResultSchema, "id" | "fields">, results: AdaptiveModelResult[]): { named: number; total: number } {
  const metricKeys = schema.fields.filter((f) => f.type === "metric[]").map((f) => f.key);
  let named = 0;
  let total = 0;
  for (const result of results) {
    if (!result.ok || !result.data) continue;
    for (const key of metricKeys) {
      const metrics = result.data[key];
      if (!Array.isArray(metrics)) continue;
      for (const m of metrics as Metric[]) {
        total += 1;
        if (namesASource(m?.source)) named += 1;
      }
    }
    if (schema.id === "factual_lookup") {
      total += 1;
      if (namesASource(result.data["source"])) named += 1;
    }
  }
  return { named, total };
}

/** Whether this schema asks models to source anything at all (independent of what the responses held). */
export function schemaRequestsSources(schema: Pick<ResultSchema, "id" | "fields">): boolean {
  return schema.id === "factual_lookup" || schema.fields.some((f) => f.type === "metric[]");
}

export function sourcesSignal(input: Pick<TrustSignalsInput, "schema" | "results">): TrustSignal {
  const base = { id: "sources" as const, name: C.sourcesName, definition: C.sourcesDefinition };
  const { named, total } = sourceableValueCounts(input.schema, input.results);
  if (total === 0) {
    if (!schemaRequestsSources(input.schema)) return { ...base, value: C.sourcesNotRequested, details: [C.sourcesNotRequestedDetail], state: "not_requested" };
    return { ...base, value: C.sourcesNone(0), details: [C.sourcesNoneDetail], state: "none_recorded" };
  }
  if (named === 0) return { ...base, value: C.sourcesNone(total), details: [C.sourcesNoneDetail], state: "none_recorded" };
  return { ...base, value: C.sourcesNamed(named, total), details: [C.sourcesNamedDetail], state: "named" };
}

// ── 4. Model behaviour score ────────────────────────────────────────────────

export function behaviourSignal(input: Pick<TrustSignalsInput, "schema" | "results" | "trustSummary">): TrustSignal {
  const base = { id: "behaviour" as const, name: C.behaviourName, definition: C.behaviourDefinition };
  const overall = input.trustSummary?.overallTrust;
  if (!isFiniteNumber(overall)) return { ...base, value: C.behaviourNotScored, details: [C.behaviourNotScoredDetail], state: "not_scored" };
  const details: string[] = [];
  // The stored citation part is a vacuous full mark whenever no sourceable value existed (computeCitationScore → 1).
  // computeCitationScore gives a parsed response with no sourceable value a full citation mark — per response. Say so
  // whenever any parsed response got that mark, not only when all did.
  const { parsed, vacuous } = vacuousCitationCounts(input.schema, input.results);
  if (parsed > 0 && vacuous === parsed) details.push(schemaRequestsSources(input.schema) ? C.behaviourCitationNoValues : C.behaviourCitationNotApplicable);
  else if (vacuous > 0) details.push(C.behaviourCitationPartial(vacuous, parsed));
  return { ...base, value: C.behaviourValue(pct(overall)), details, state: "scored" };
}

/** Parsed responses (ok with data), and how many of them had no sourceable value (a vacuous full citation mark). */
export function vacuousCitationCounts(schema: Pick<ResultSchema, "id" | "fields">, results: AdaptiveModelResult[]): { parsed: number; vacuous: number } {
  let parsed = 0;
  let vacuous = 0;
  for (const result of results) {
    if (!result.ok || !result.data) continue;
    parsed += 1;
    if (sourceableValueCounts(schema, [result]).total === 0) vacuous += 1;
  }
  return { parsed, vacuous };
}

/** The four signals, in their fixed display order. */
export function buildTrustSignals(input: TrustSignalsInput): TrustSignal[] {
  return [gateSignal({ ...input, schemaId: input.schema.id }), coverageSignal(input), sourcesSignal(input), behaviourSignal(input)];
}
