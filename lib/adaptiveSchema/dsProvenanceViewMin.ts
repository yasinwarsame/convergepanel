/**
 * AI Integrity Order 6, slice S-1a-min — `buildDsProvenanceViewMin`, the
 * minimum-scope Decision Support provenance view (sealed contract: B §3.5,
 * R17 package; owner selections D-1(a), OS-1(b), D-2, D-11(A), U-02(1),
 * R1-10R, OD-R9-1, OD-R9-2).
 *
 * A pure, deterministic, never-throwing function over data the caller has
 * ALREADY been authorized to read:
 *   - `publicResults` / `publicAdaptiveOutput` are the same viewer's
 *     `RunReadPayload.results` / `RunReadPayload.adaptive.output` (P1/W1).
 *     They are the authorized projection, never raw persisted rows.
 *   - `governanceRecord` is the stored record, read ONLY through the
 *     canonical `parseGovernanceRecord`.
 *   - `surfaceRequest` is the route's own viewer-context derivation, passed
 *     through unchanged. The builder never computes an authorization flag,
 *     never compares a uid and never reads an assignment.
 *
 * No I/O, logging, clock, randomness, environment or configuration read; no
 * input mutation. Not wired into any route, renderer or export in S-1a-min.
 *
 * Deliberately NOT produced (scoped deferrals, B §3.5.8): any
 * provider-independence verdict, flag, count or grouping (OS-1(b)); any
 * consensus tier or recomputed gate/consensus/certainty/trust outcome;
 * publisher class or source standing; reviewer, panel, finalizer, assignee
 * or comment identity; any history value; any decision time other than the
 * parsed `reviewedAt` (OD-R9-1); any operational-use authorization.
 */

import { parsePersistedAdaptiveOutput } from "./persistedOutput";
import { parseGovernanceRecord } from "./governanceRecordParser";

// ─── Contract constants (sealed AA-3 semantics; exact text) ───────────────

export const DS_PROVENANCE_MIN_VERSION = 1 as const;

export const OPTION_CLUSTERING_UNVERIFIED_TEXT =
  "Options were grouped by text similarity. Different options with similar wording (for example 3.5% vs 35%, or Approve vs Disapprove) can be merged; agreement on an option is not established.";
export const OPTION_CLUSTERING_KNOWN_DEFECT = "R5-P1-08";
export const REVIEW_HISTORY_NOT_SHOWN_TEXT =
  "This provenance record covers only the current review decision. It does not include earlier decisions, resubmissions or the completeness of the review history.";
export const USE_AUTHORIZATION_NOT_AUTHORIZED = "not_authorized_no_policy" as const;

const DISPATCHED_MODELS_LABEL = "models dispatched";
const RECOMMENDING_MODELS_LABEL = "models that gave a recommendation";
const LARGEST_AGREEING_GROUP_LABEL = "largest group of models recommending the same action";
const SELF_REPORTED_LABEL = "self-reported by models";

const PUBLIC_STATUSES = new Set(["ok", "substituted", "failed"]);
const DECIDED_VIA_VALUES = new Set(["single_reviewer", "multi_reviewer_panel", "multi_reviewer_owner_override"]);
const PENDING_REVIEW_STATUSES = new Set(["unreviewed", "pending"]);
const DECIDED_REVIEW_STATUSES = new Set(["approved", "approved_with_conditions", "changes_requested", "rejected"]);

// ─── Types ─────────────────────────────────────────────────────────────────

export type DsSurfaceRequestMin =
  | { surfaceId: "P1"; path: "personal"; role: "owner"; mayReadDecisionContent: true }
  | { surfaceId: "P1"; path: "personal"; role: "personal_reviewer"; mayReadDecisionContent: boolean }
  | { surfaceId: "P1"; path: "team_bound"; role: "team_member" | "team_reviewer"; mayReadDecisionContent: true }
  | { surfaceId: "P2"; role: "owner"; mayReadDecisionReviewer: true }
  | { surfaceId: "P2"; role: "personal_reviewer"; mayReadDecisionReviewer: boolean }
  | { surfaceId: "W1"; role: "team_member" | "team_reviewer" }
  | { surfaceId: "W2"; admission: "normal" | "drain" };

export interface DsProvenanceViewMinInput {
  publicResults: unknown;
  publicAdaptiveOutput: unknown;
  governanceRecord: unknown;
  surfaceRequest: unknown;
}

export type DsProvenanceNotBuiltReason = "surface_not_in_initial_scope" | "viewer_context_mismatch" | "input_not_decision_support";

type Unknown = "unknown";
type NotRecorded = "not_recorded";

export interface DsProvenanceSlotMin {
  slotId: string;
  status: "ok" | "substituted" | "failed" | Unknown;
  requestedModel: string;
  answeredByProvider: string;
  /** Present only on a slot whose projected status is `substituted`. */
  substitutedFrom?: string;
  contributedRecommendation: Unknown;
}

export interface DsProvenanceL2Min {
  recommendation: { action: string | Unknown; recommendedOptionId?: string | Unknown; isContested: boolean | Unknown };
  dispatchedModels: number | Unknown;
  recommendingModels: number | Unknown;
  largestAgreeingGroup: number | Unknown;
  dispatchedModelsLabel: typeof DISPATCHED_MODELS_LABEL;
  recommendingModelsLabel: typeof RECOMMENDING_MODELS_LABEL;
  largestAgreeingGroupLabel: typeof LARGEST_AGREEING_GROUP_LABEL;
  denominatorStatement: string;
  humanReviewNeeded: boolean | Unknown;
  rules: { envelopeVersion: 1; aggregation: NotRecorded; optionMatcher: NotRecorded; thresholds: NotRecorded; prompt: NotRecorded };
  computedAt: string | Unknown;
}

export interface DsProvenanceL3Min {
  sourcesListedByModels: { list: string[] | Unknown; count: number | Unknown };
  modelSelfReportedEvidenceStrength:
    | Array<{ optionId: string | Unknown; criterionId: string | Unknown; evidenceStrength: string | Unknown }>
    | Unknown;
  modelSelfReportedEvidenceStrengthLabel: typeof SELF_REPORTED_LABEL;
  sourceCheck: "not_evaluated";
  freshness: "not_evaluated";
}

export interface DsProvenanceL4Min {
  option_clustering_unverified: true;
  option_clustering_unverified_text: typeof OPTION_CLUSTERING_UNVERIFIED_TEXT;
  option_clustering_unverified_knownDefect: typeof OPTION_CLUSTERING_KNOWN_DEFECT;
  evidence_self_reported: true;
  sources_unchecked: true;
  freshness_not_evaluated: true;
  retry_text_not_retained: true;
  rules_unversioned: true;
  historical_rules_unknown: true;
  review_history_not_shown: true;
  review_history_not_shown_text: typeof REVIEW_HISTORY_NOT_SHOWN_TEXT;
  /** P1/W1 only (data-derived). */
  coverage_partial?: boolean | Unknown;
  /** P1/W1 only (data-derived). */
  contested?: boolean | Unknown;
}

export type DsProvenanceHumanReviewMin =
  | { state: "none" }
  | { state: "pending"; decision: "unreviewed" | "pending"; reviewedContent: "run_result_by_id_only" }
  | {
      state: "decided";
      decision: "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
      reviewedContent: "run_result_by_id_only";
      decidedVia?: "single_reviewer" | "multi_reviewer_panel" | "multi_reviewer_owner_override" | "single_or_legacy" | Unknown;
      reviewedAt?: string;
      conditions?: string[];
    };

export type DsProvenanceViewMin =
  | { kind: "not_built"; version: 1; reason: DsProvenanceNotBuiltReason }
  | {
      kind: "ds_provenance_min";
      version: 1;
      surfaceId: "P1" | "P2" | "W1" | "W2";
      /** The slot list in projected order, or `{ slots: "unknown" }` when the projection is not an array. */
      l1?: DsProvenanceSlotMin[] | { slots: Unknown };
      l2?: DsProvenanceL2Min;
      l3?: DsProvenanceL3Min;
      l4: DsProvenanceL4Min;
      /** Exactly one of `humanReview` / `humanReviewUnavailable` is present. */
      humanReview?: DsProvenanceHumanReviewMin;
      humanReviewUnavailable?: true;
      useAuthorization: typeof USE_AUTHORIZATION_NOT_AUTHORIZED;
    };

// ─── Safe readers (never trigger a throw path that escapes the builder) ───

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An own, defined property. A key whose value is `undefined` is treated as absent (it is absent from any serialized view). */
function present(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

/** Own-property read only: an inherited (e.g. prototype-polluted) key is never input. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** A count printable in plain base-10 digits (D-2): a safe, non-negative integer; -0 is normalised to 0. */
function nonNegativeInteger(value: unknown): number | Unknown {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? (value === 0 ? 0 : value) : "unknown";
}

/** Maps every index, holes included (a hole reads as `undefined`), so sparse input never yields a sparse output. */
function mapDense<T>(arr: unknown[], fn: (value: unknown) => T): T[] {
  return Array.from({ length: arr.length }, (_, i) => fn(Object.prototype.hasOwnProperty.call(arr, i) ? arr[i] : undefined));
}

function copiedString(value: unknown): string | Unknown {
  return typeof value === "string" ? value : "unknown";
}

function copiedBoolean(value: unknown): boolean | Unknown {
  return typeof value === "boolean" ? value : "unknown";
}

function notBuilt(reason: DsProvenanceNotBuiltReason): DsProvenanceViewMin {
  return { kind: "not_built", version: DS_PROVENANCE_MIN_VERSION, reason };
}

// ─── Viewer context (exact shapes only; B §3.5.2) ─────────────────────────

const SURFACES_IN_SCOPE = new Set(["P1", "P2", "W1", "W2"]);

function exactKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

/**
 * Validates the exact context shape and returns a FRESH literal built from values read once, so nothing
 * the caller's object does after validation (getters, later mutation) can change what the builder uses.
 */
function validContext(ctx: Record<string, unknown>, surfaceId: string): DsSurfaceRequestMin | null {
  switch (surfaceId) {
    case "P1": {
      if (!exactKeys(ctx, ["surfaceId", "path", "role", "mayReadDecisionContent"])) return null;
      const path = own(ctx, "path"), role = own(ctx, "role"), m = own(ctx, "mayReadDecisionContent");
      if (path === "personal" && role === "owner" && m === true) return { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true };
      if (path === "personal" && role === "personal_reviewer" && typeof m === "boolean") return { surfaceId: "P1", path: "personal", role: "personal_reviewer", mayReadDecisionContent: m };
      if (path === "team_bound" && (role === "team_member" || role === "team_reviewer") && m === true) return { surfaceId: "P1", path: "team_bound", role, mayReadDecisionContent: true };
      return null;
    }
    case "P2": {
      if (!exactKeys(ctx, ["surfaceId", "role", "mayReadDecisionReviewer"])) return null;
      const role = own(ctx, "role"), m = own(ctx, "mayReadDecisionReviewer");
      if (role === "owner" && m === true) return { surfaceId: "P2", role: "owner", mayReadDecisionReviewer: true };
      if (role === "personal_reviewer" && typeof m === "boolean") return { surfaceId: "P2", role: "personal_reviewer", mayReadDecisionReviewer: m };
      return null;
    }
    case "W1": {
      if (!exactKeys(ctx, ["surfaceId", "role"])) return null;
      const role = own(ctx, "role");
      return role === "team_member" || role === "team_reviewer" ? { surfaceId: "W1", role } : null;
    }
    case "W2": {
      if (!exactKeys(ctx, ["surfaceId", "admission"])) return null;
      const admission = own(ctx, "admission");
      return admission === "normal" || admission === "drain" ? { surfaceId: "W2", admission } : null;
    }
    default:
      return null;
  }
}

// ─── L1 (P1/W1): per-slot facts from the authorized projection ─────────────

function recordedField(row: Record<string, unknown>, key: string): string {
  if (!present(row, key)) return "not_recorded";
  const value = own(row, key);
  return typeof value === "string" && value.trim() !== "" ? value : "unknown";
}

function buildSlot(row: unknown): DsProvenanceSlotMin {
  if (!isPlainObject(row)) {
    return { slotId: "unknown", status: "unknown", requestedModel: "unknown", answeredByProvider: "unknown", contributedRecommendation: "unknown" };
  }
  const rowStatus = own(row, "status");
  const modelId = own(row, "modelId");
  const status = typeof rowStatus === "string" && PUBLIC_STATUSES.has(rowStatus) ? (rowStatus as DsProvenanceSlotMin["status"]) : "unknown";
  const slot: DsProvenanceSlotMin = {
    slotId: typeof modelId === "string" ? modelId : "unknown",
    status,
    requestedModel: recordedField(row, "requestedModel"),
    answeredByProvider: recordedField(row, "provider"),
    contributedRecommendation: "unknown",
  };
  if (status === "substituted") {
    return {
      slotId: slot.slotId,
      status: slot.status,
      requestedModel: slot.requestedModel,
      answeredByProvider: slot.answeredByProvider,
      substitutedFrom: recordedField(row, "substitutedFrom"),
      contributedRecommendation: "unknown",
    };
  }
  return slot;
}

function buildL1(publicResults: unknown): DsProvenanceSlotMin[] | { slots: Unknown } {
  if (!Array.isArray(publicResults)) return { slots: "unknown" };
  return mapDense(publicResults, buildSlot);
}

// ─── L2 (P1/W1): projected DS recommendation, verbatim, with D-2 counts ────

function denominatorStatement(m: number | Unknown, k: number | Unknown, n: number | Unknown): string {
  if (m === "unknown" || k === "unknown" || n === "unknown") return "unknown";
  return `${m} ${m === 1 ? "model" : "models"} dispatched; ${k} gave a recommendation; largest group recommending the same action: ${n}.`;
}

function recommendationOf(result: Record<string, unknown>): Record<string, unknown> {
  const rec = own(result, "recommendation");
  return isPlainObject(rec) ? rec : {};
}

function dsCounts(result: Record<string, unknown>): { m: number | Unknown; k: number | Unknown; n: number | Unknown } {
  const rec = recommendationOf(result);
  return {
    m: nonNegativeInteger(own(result, "totalModels")),
    k: nonNegativeInteger(own(rec, "totalModelsWithRecommendation")),
    n: nonNegativeInteger(own(rec, "supportCount")),
  };
}

function buildL2(output: Record<string, unknown>, result: Record<string, unknown>): DsProvenanceL2Min {
  const rec = recommendationOf(result);
  const { m, k, n } = dsCounts(result);
  const recommendation: DsProvenanceL2Min["recommendation"] = present(rec, "recommendedOptionId")
    ? { action: copiedString(own(rec, "action")), recommendedOptionId: copiedString(own(rec, "recommendedOptionId")), isContested: copiedBoolean(own(rec, "isContested")) }
    : { action: copiedString(own(rec, "action")), isContested: copiedBoolean(own(rec, "isContested")) };
  return {
    recommendation,
    dispatchedModels: m,
    recommendingModels: k,
    largestAgreeingGroup: n,
    dispatchedModelsLabel: DISPATCHED_MODELS_LABEL,
    recommendingModelsLabel: RECOMMENDING_MODELS_LABEL,
    largestAgreeingGroupLabel: LARGEST_AGREEING_GROUP_LABEL,
    denominatorStatement: denominatorStatement(m, k, n),
    humanReviewNeeded: copiedBoolean(own(result, "humanReviewNeeded")),
    rules: { envelopeVersion: 1, aggregation: "not_recorded", optionMatcher: "not_recorded", thresholds: "not_recorded", prompt: "not_recorded" },
    computedAt: copiedString(own(output, "generatedAt")),
  };
}

// ─── L3 (P1/W1): model-listed sources and self-reported strength only ──────

function buildL3(result: Record<string, unknown>): DsProvenanceL3Min {
  // An absent or non-array value is "unknown", never an empty list: DS outputs persisted before the result carried
  // `sources` (b8e3e62, 2026-08-29) have no projected value, and "0 sources listed" would be a fact the projection lacks.
  const sources = own(result, "sources");
  const sourcesListedByModels: DsProvenanceL3Min["sourcesListedByModels"] = Array.isArray(sources)
    ? { list: mapDense(sources, copiedString), count: sources.length }
    : { list: "unknown", count: "unknown" };

  const assessments = own(result, "assessments");
  const strength: DsProvenanceL3Min["modelSelfReportedEvidenceStrength"] = Array.isArray(assessments)
    ? mapDense(assessments, (a) =>
        isPlainObject(a)
          ? { optionId: copiedString(own(a, "optionId")), criterionId: copiedString(own(a, "criterionId")), evidenceStrength: copiedString(own(a, "evidenceStrength")) }
          : { optionId: "unknown", criterionId: "unknown", evidenceStrength: "unknown" },
      )
    : "unknown";

  return {
    sourcesListedByModels,
    modelSelfReportedEvidenceStrength: strength,
    modelSelfReportedEvidenceStrengthLabel: SELF_REPORTED_LABEL,
    sourceCheck: "not_evaluated",
    freshness: "not_evaluated",
  };
}

// ─── L4: run-independent constants (every surface) + data-derived (P1/W1) ──

function buildL4(result: Record<string, unknown> | null): DsProvenanceL4Min {
  const l4: DsProvenanceL4Min = {
    option_clustering_unverified: true,
    option_clustering_unverified_text: OPTION_CLUSTERING_UNVERIFIED_TEXT,
    option_clustering_unverified_knownDefect: OPTION_CLUSTERING_KNOWN_DEFECT,
    evidence_self_reported: true,
    sources_unchecked: true,
    freshness_not_evaluated: true,
    retry_text_not_retained: true,
    rules_unversioned: true,
    historical_rules_unknown: true,
    review_history_not_shown: true,
    review_history_not_shown_text: REVIEW_HISTORY_NOT_SHOWN_TEXT,
  };
  if (result === null) return l4;
  const { m, k } = dsCounts(result);
  l4.coverage_partial = m === "unknown" || k === "unknown" ? "unknown" : k < m;
  l4.contested = copiedBoolean(own(recommendationOf(result), "isContested"));
  return l4;
}

// ─── L5: human review, read only through parseGovernanceRecord ────────────

function p2ReviewedAtGate(hr: Record<string, unknown>, mayReadDecisionReviewer: unknown): boolean {
  // Exactly the baseline singleReviewer gate (reviewGovernanceViewModel.ts:227): reviewerId truthy (NOT trimmed),
  // decidedVia absent or "single_reviewer", and the route-derived reviewer-identity authority.
  const reviewerId = own(hr, "reviewerId");
  return (
    mayReadDecisionReviewer === true &&
    typeof reviewerId === "string" &&
    reviewerId.length > 0 &&
    (!present(hr, "decidedVia") || own(hr, "decidedVia") === "single_reviewer")
  );
}

function buildL5(governanceRecord: unknown, ctx: DsSurfaceRequestMin): { humanReview: DsProvenanceHumanReviewMin } | { humanReviewUnavailable: true } {
  const parsed = parseGovernanceRecord(governanceRecord);
  if (!parsed.ok) {
    return parsed.reason === "absent" ? { humanReview: { state: "none" } } : { humanReviewUnavailable: true };
  }
  const hr = own(parsed.record as unknown as Record<string, unknown>, "humanReview") as Record<string, unknown>;
  const status = own(hr, "status");
  if (typeof status === "string" && PENDING_REVIEW_STATUSES.has(status)) {
    return { humanReview: { state: "pending", decision: status as "unreviewed" | "pending", reviewedContent: "run_result_by_id_only" } };
  }
  if (typeof status !== "string" || !DECIDED_REVIEW_STATUSES.has(status)) {
    // Unreachable after a successful parse (the parser validates the status vocabulary); fail closed.
    return { humanReviewUnavailable: true };
  }

  const decided: Extract<DsProvenanceHumanReviewMin, { state: "decided" }> = {
    state: "decided",
    decision: status as Extract<DsProvenanceHumanReviewMin, { state: "decided" }>["decision"],
    reviewedContent: "run_result_by_id_only",
  };
  const s = ctx.surfaceId;
  const role = "role" in ctx ? ctx.role : undefined;

  // decidedVia: P1 owner / team roles, W1, W2. Never P2, never a personal reviewer (D-11(A)).
  if ((s === "P1" && (role === "owner" || role === "team_member" || role === "team_reviewer")) || s === "W1" || s === "W2") {
    const decidedVia = own(hr, "decidedVia");
    decided.decidedVia = !present(hr, "decidedVia")
      ? "single_or_legacy"
      : typeof decidedVia === "string" && DECIDED_VIA_VALUES.has(decidedVia)
        ? (decidedVia as "single_reviewer" | "multi_reviewer_panel" | "multi_reviewer_owner_override")
        : "unknown";
  }

  const mayReadContent = (s === "P1" && "mayReadDecisionContent" in ctx && ctx.mayReadDecisionContent === true) || s === "W1" || s === "W2";
  const p2Gate = s === "P2" && p2ReviewedAtGate(hr, "mayReadDecisionReviewer" in ctx ? ctx.mayReadDecisionReviewer : false);
  const reviewedAt = own(hr, "reviewedAt");
  if (typeof reviewedAt === "string" && (mayReadContent || p2Gate)) {
    decided.reviewedAt = reviewedAt;
  }
  const conditions = own(hr, "conditions");
  if (Array.isArray(conditions) && mayReadContent) {
    decided.conditions = conditions.filter((c): c is string => typeof c === "string");
  }
  return { humanReview: decided };
}

// ─── Builder ──────────────────────────────────────────────────────────────

/**
 * Never throws: any unexpected exception (only reachable through hostile
 * getters or proxies on the input) is converted into the fail-closed
 * `not_built` / `input_not_decision_support` result, with no run data.
 */
export function buildDsProvenanceViewMin(input: unknown): DsProvenanceViewMin {
  try {
    return build(input);
  } catch {
    return notBuilt("input_not_decision_support");
  }
}

function build(input: unknown): DsProvenanceViewMin {
  // Each input field is read exactly once, as an own property.
  const inp = isPlainObject(input) ? input : {};
  const rawCtx = own(inp, "surfaceRequest");
  const publicResults = own(inp, "publicResults");
  const publicAdaptiveOutput = own(inp, "publicAdaptiveOutput");
  const governanceRecord = own(inp, "governanceRecord");

  const surfaceId = isPlainObject(rawCtx) ? own(rawCtx, "surfaceId") : undefined;
  if (!isPlainObject(rawCtx) || typeof surfaceId !== "string" || !SURFACES_IN_SCOPE.has(surfaceId)) {
    return notBuilt("surface_not_in_initial_scope");
  }
  const ctx = validContext(rawCtx, surfaceId);
  if (ctx === null) return notBuilt("viewer_context_mismatch");

  // D-1(a): Decision Support only, validated by the canonical parser (P2/W2 use the same viewer's P1/W1 projection only for this gate).
  const parsedOutput = parsePersistedAdaptiveOutput(publicAdaptiveOutput);
  if (!parsedOutput.ok || parsedOutput.output.schemaId !== "decision_support") return notBuilt("input_not_decision_support");
  const output = parsedOutput.output as unknown as Record<string, unknown>;
  const result = own(output, "result") as Record<string, unknown>;

  const projectionSurface = ctx.surfaceId === "P1" || ctx.surfaceId === "W1";
  const l5 = buildL5(governanceRecord, ctx);

  if (projectionSurface) {
    return {
      kind: "ds_provenance_min",
      version: DS_PROVENANCE_MIN_VERSION,
      surfaceId: ctx.surfaceId,
      l1: buildL1(publicResults),
      l2: buildL2(output, result),
      l3: buildL3(result),
      l4: buildL4(result),
      ...l5,
      useAuthorization: USE_AUTHORIZATION_NOT_AUTHORIZED,
    };
  }
  // P2/W2: no L1–L3 and no data-derived L4 (I-6 content ceiling).
  return {
    kind: "ds_provenance_min",
    version: DS_PROVENANCE_MIN_VERSION,
    surfaceId: ctx.surfaceId,
    l4: buildL4(null),
    ...l5,
    useAuthorization: USE_AUTHORIZATION_NOT_AUTHORIZED,
  };
}
