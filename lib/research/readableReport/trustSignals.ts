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
  AdaptiveModelResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  Metric,
  ResultSchema,
} from "@/lib/adaptiveSchema/types";
import { GATE_STATUS_WORD, gateNotice, pageGateValue, readGateStatus, type GateDisplayStatus } from "@/lib/adaptiveSchema/gatePresentation";
import { READABLE_TRUST_COPY as C } from "./copy";

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
  synthesisReport?: Pick<AdaptiveSynthesisReport, "gate"> | null;
  trustSummary?: AdaptiveTrustSummary | null;
  /** The run's recorded per-slot call status (RunSlotStatusContext); null when the page was not handed it. */
  slotStatuses: ReadonlyMap<string, string> | null;
}

const pct = (x: number) => Math.round(x * 100);
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

// ── 1. Verification gate ────────────────────────────────────────────────────

export function gateSignal(input: Pick<TrustSignalsInput, "gate" | "synthesisReport">): TrustSignal {
  const base = { id: "gate" as const, name: C.gateName, definition: C.gateDefinition };
  const { gate, synthesisReport } = input;
  if (!gate && !synthesisReport) return { ...base, value: C.gateNotRecorded, details: [C.gateNotRecordedDetail], state: "not_recorded" };

  // The stored value the rest of the page shows (F4): the report's copy when a report exists.
  const status: GateDisplayStatus = readGateStatus(pageGateValue(synthesisReport ?? null, gate?.status));
  const details: string[] = [];
  const notice = gateNotice(status);
  // D8: an unrecognized stored value supports no verification result, so its stored inputs are not presented beside it.
  if (status !== "unrecognized") {
    if (gate && isFiniteNumber(gate.runCertainty) && isFiniteNumber(gate.loadBearingSplitCount) && Array.isArray(gate.loadBearingClaims)) {
      details.push(`${C.gateInputsHeading}: ${C.gateCertainty(pct(gate.runCertainty))}; ${C.gateSplitTop(gate.loadBearingSplitCount, gate.loadBearingClaims.length)}`);
    } else {
      details.push(C.gateInputsNotRecorded);
    }
  }
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
  return [gateSignal(input), coverageSignal(input), sourcesSignal(input), behaviourSignal(input)];
}
