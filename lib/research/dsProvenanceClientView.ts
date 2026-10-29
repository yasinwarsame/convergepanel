/**
 * Order 6 / S-2a — strict client reading of the `dsProvenance` field a page's OWN route returned, mapped to the
 * owner-approved first-slice display (OD-1; Q1–Q6). Pure: no I/O, no clock, no environment, never throws.
 *
 * Each page passes the surface it is (P1 personal research page, W1 Team research page, P2 reviewer inbox). A view for
 * another surface, any key or value outside the closed route-view schema (dsProvenanceRouteAdapter.ts /
 * dsProvenanceViewMin.ts), or a review state the routes never send yields `null`: no section, no placeholder.
 *
 * Mapping (the S-2a display mapping, approved by the owner):
 *   - sources (P1/W1): a list with a non-blank entry → "Sources listed; not independently verified" and the entries as
 *     model-authored text; a list known to be empty (or only blank entries, the S-E.1 rule) → "No sources listed";
 *     no recorded list (legacy output, `"unknown"`) → "Unknown". An entry the builder could only record as "unknown"
 *     is omitted.
 *   - strength (P1/W1): the label and the S-E.1 caption only, and only when the view carries at least one self-reported
 *     rating (Q6: no individual values).
 *   - counts (P1/W1): the approved D-2 sentence, only when the view's numbers are safe integers, the sentence is
 *     exactly the template for them, and they equal the recorded fields of the Decision Support result in the same
 *     response; otherwise the row is omitted (Q5). The builder's own label for the largest group is never used.
 *   - review: `humanReviewNeeded` false/true → the E-6 sentence / "Flagged for human review" ("unknown" → omitted);
 *     a decided review → "Review recorded"; a pending review → no status line (Q2); `reviewedAt` only when present and
 *     a valid ISO date-time, formatted `YYYY-MM-DD HH:mm UTC`; conditions only as recorded, non-blank.
 *   - use authorization: the only schema value, `not_authorized_no_policy` → "Not authorized for use".
 * Never displayed: per-model slots, rules, computedAt, decidedVia, the decision value, coverage/contested flags, the
 * L4 texts (the D-9 text is already on the page: Q1/OD-3).
 */

import {
  DS_PROVENANCE_MIN_VERSION,
  OPTION_CLUSTERING_KNOWN_DEFECT,
  OPTION_CLUSTERING_UNVERIFIED_TEXT,
  REVIEW_HISTORY_NOT_SHOWN_TEXT,
  USE_AUTHORIZATION_NOT_AUTHORIZED,
} from "@/lib/adaptiveSchema/dsProvenanceViewMin";

export type DsProvenancePageSurface = "P1" | "W1" | "P2";

export type DsProvenanceDisplay = {
  surface: DsProvenancePageSurface;
  sources: { kind: "listed"; items: string[] } | { kind: "none" } | { kind: "unknown" } | null;
  strength: boolean;
  counts: string | null;
  reviewNeeded: "not_flagged" | "flagged" | null;
  reviewRecorded: boolean;
  reviewedAt: string | null;
  conditions: string[];
  notAuthorizedForUse: true;
};

/** The recorded counts of the Decision Support result in the same response (result.totalModels etc.). */
export type RecordedDsCounts = { totalModels: unknown; totalModelsWithRecommendation: unknown; supportCount: unknown };

type Obj = Record<string, unknown>;
/** A plain JSON object (realm-independent: a parsed response body may come from another realm's `Object`). */
const isObj = (v: unknown): v is Obj => Object.prototype.toString.call(v) === "[object Object]" && !Array.isArray(v);
const keysAre = (o: Obj, required: string[], optional: string[] = []) => {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
};
const UNKNOWN = "unknown";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const countOrUnknown = (v: unknown) => isCount(v) || v === UNKNOWN;
const stringOrUnknown = (v: unknown) => typeof v === "string";
const boolOrUnknown = (v: unknown) => typeof v === "boolean" || v === UNKNOWN;

const L4_CONSTANTS: Obj = {
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
const SLOT_STATUSES = new Set(["ok", "substituted", "failed", UNKNOWN]);
const PENDING = new Set(["unreviewed", "pending"]);
const DECIDED = new Set(["approved", "approved_with_conditions", "changes_requested", "rejected"]);
const DECIDED_VIA = new Set(["single_reviewer", "multi_reviewer_panel", "multi_reviewer_owner_override", "single_or_legacy", UNKNOWN]);
const DS_LABELS = {
  dispatchedModelsLabel: "models dispatched",
  recommendingModelsLabel: "models that gave a recommendation",
  largestAgreeingGroupLabel: "largest group of models recommending the same action",
};

function validL4(l4: unknown, projection: boolean): boolean {
  if (!isObj(l4)) return false;
  const constantKeys = Object.keys(L4_CONSTANTS);
  if (!keysAre(l4, projection ? [...constantKeys, "coverage_partial", "contested"] : constantKeys)) return false;
  if (!constantKeys.every((k) => l4[k] === L4_CONSTANTS[k])) return false;
  return !projection || (boolOrUnknown(l4.coverage_partial) && boolOrUnknown(l4.contested));
}

function validSlot(s: unknown): boolean {
  if (!isObj(s)) return false;
  const substituted = s.status === "substituted";
  if (!keysAre(s, ["slotId", "status", "requestedModel", "answeredByProvider", "contributedRecommendation", ...(substituted ? ["substitutedFrom"] : [])])) return false;
  return (
    typeof s.slotId === "string" && SLOT_STATUSES.has(s.status as string) && typeof s.requestedModel === "string" && typeof s.answeredByProvider === "string" &&
    s.contributedRecommendation === UNKNOWN && (!substituted || typeof s.substitutedFrom === "string")
  );
}

function validL1(l1: unknown): boolean {
  if (Array.isArray(l1)) return l1.every(validSlot);
  return isObj(l1) && keysAre(l1, ["slots"]) && l1.slots === UNKNOWN;
}

function validL2(l2: unknown): l2 is Obj {
  if (!isObj(l2)) return false;
  if (!keysAre(l2, ["recommendation", "dispatchedModels", "recommendingModels", "largestAgreeingGroup", ...Object.keys(DS_LABELS), "denominatorStatement", "humanReviewNeeded", "rules", "computedAt"])) return false;
  const rec = l2.recommendation;
  if (!isObj(rec) || !keysAre(rec, ["action", "isContested"], ["recommendedOptionId"]) || !stringOrUnknown(rec.action) || !boolOrUnknown(rec.isContested)) return false;
  if ("recommendedOptionId" in rec && !stringOrUnknown(rec.recommendedOptionId)) return false;
  if (!countOrUnknown(l2.dispatchedModels) || !countOrUnknown(l2.recommendingModels) || !countOrUnknown(l2.largestAgreeingGroup)) return false;
  if (!Object.entries(DS_LABELS).every(([k, v]) => l2[k] === v)) return false;
  if (typeof l2.denominatorStatement !== "string" || !boolOrUnknown(l2.humanReviewNeeded) || typeof l2.computedAt !== "string") return false;
  const r = l2.rules;
  return isObj(r) && keysAre(r, ["envelopeVersion", "aggregation", "optionMatcher", "thresholds", "prompt"]) && r.envelopeVersion === 1 &&
    ["aggregation", "optionMatcher", "thresholds", "prompt"].every((k) => r[k] === "not_recorded");
}

function validL3(l3: unknown): l3 is Obj {
  if (!isObj(l3)) return false;
  if (!keysAre(l3, ["sourcesListedByModels", "modelSelfReportedEvidenceStrength", "modelSelfReportedEvidenceStrengthLabel", "sourceCheck", "freshness"])) return false;
  const src = l3.sourcesListedByModels;
  if (!isObj(src) || !keysAre(src, ["list", "count"])) return false;
  if (Array.isArray(src.list)) {
    if (!src.list.every((s) => typeof s === "string") || src.count !== src.list.length) return false;
  } else if (!(src.list === UNKNOWN && src.count === UNKNOWN)) return false;
  const strength = l3.modelSelfReportedEvidenceStrength;
  if (strength !== UNKNOWN) {
    if (!Array.isArray(strength)) return false;
    const entryOk = (e: unknown) => isObj(e) && keysAre(e, ["optionId", "criterionId", "evidenceStrength"]) && ["optionId", "criterionId", "evidenceStrength"].every((k) => typeof e[k] === "string");
    if (!strength.every(entryOk)) return false;
  }
  return l3.modelSelfReportedEvidenceStrengthLabel === "self-reported by models" && l3.sourceCheck === "not_evaluated" && l3.freshness === "not_evaluated";
}

/** The review the route attached, or null when its shape is not one the routes send to this surface. */
function validReview(hr: unknown, surface: DsProvenancePageSurface): Obj | null {
  if (!isObj(hr)) return null;
  if (hr.state === "pending") return keysAre(hr, ["state", "decision", "reviewedContent"]) && PENDING.has(hr.decision as string) && hr.reviewedContent === "run_result_by_id_only" ? hr : null;
  if (hr.state !== "decided") return null;
  // P2 never carries decidedVia or conditions (D-11(A)); a P2 view that does is not one the route sends.
  const optional = surface === "P2" ? ["reviewedAt"] : ["decidedVia", "reviewedAt", "conditions"];
  if (!keysAre(hr, ["state", "decision", "reviewedContent"], optional)) return null;
  if (!DECIDED.has(hr.decision as string) || hr.reviewedContent !== "run_result_by_id_only") return null;
  if ("decidedVia" in hr && !DECIDED_VIA.has(hr.decidedVia as string)) return null;
  if ("reviewedAt" in hr && typeof hr.reviewedAt !== "string") return null;
  if ("conditions" in hr && !(Array.isArray(hr.conditions) && hr.conditions.every((c) => typeof c === "string"))) return null;
  return hr;
}

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `YYYY-MM-DD HH:mm UTC`, or null when the value is not a valid ISO 8601 instant with an explicit offset. Calendar
 * fields are checked before parsing (R1 NIT-1): `Date.parse` would roll "2026-02-30" into March, showing a date that
 * was never stored.
 */
export function formatReviewedAtUtc(value: string): string | null {
  const m = ISO_INSTANT.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  if (m[7] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** The approved D-2 sentence for these counts (the builder's `denominatorStatement` template). */
export function d2Sentence(m: number, k: number, n: number): string {
  return `${m} ${m === 1 ? "model" : "models"} dispatched; ${k} gave a recommendation; largest group recommending the same action: ${n}.`;
}

function countsOf(l2: Obj, recorded: RecordedDsCounts | null): string | null {
  const m = l2.dispatchedModels, k = l2.recommendingModels, n = l2.largestAgreeingGroup;
  if (!isCount(m) || !isCount(k) || !isCount(n) || k > m || n > k) return null;
  if (l2.denominatorStatement !== d2Sentence(m, k, n)) return null;
  if (!recorded || recorded.totalModels !== m || recorded.totalModelsWithRecommendation !== k || recorded.supportCount !== n) return null;
  return l2.denominatorStatement;
}

function sourcesOf(l3: Obj): DsProvenanceDisplay["sources"] {
  const list = (l3.sourcesListedByModels as Obj).list;
  if (!Array.isArray(list)) return { kind: "unknown" };
  const items = (list as string[]).filter((s) => s.trim() !== "" && s !== UNKNOWN);
  if (items.length > 0) return { kind: "listed", items };
  // Known empty, or only blank entries (the S-E.1 rule): nothing listed. A list holding only builder stand-ins for
  // non-string entries is not known to be empty.
  return (list as string[]).some((s) => s === UNKNOWN) ? { kind: "unknown" } : { kind: "none" };
}

export function readDsProvenanceForPage(raw: unknown, surface: DsProvenancePageSurface, recorded: RecordedDsCounts | null = null): DsProvenanceDisplay | null {
  try {
    return read(raw, surface, recorded);
  } catch {
    return null;
  }
}

function read(raw: unknown, surface: DsProvenancePageSurface, recorded: RecordedDsCounts | null): DsProvenanceDisplay | null {
  if (!isObj(raw)) return null;
  const projection = surface !== "P2";
  const top = ["kind", "version", "surfaceId", "l4", "humanReview", "useAuthorization", ...(projection ? ["l1", "l2", "l3"] : [])];
  if (!keysAre(raw, top)) return null;
  if (raw.kind !== "ds_provenance_min" || raw.version !== DS_PROVENANCE_MIN_VERSION || raw.surfaceId !== surface) return null;
  if (raw.useAuthorization !== USE_AUTHORIZATION_NOT_AUTHORIZED) return null;
  if (!validL4(raw.l4, projection)) return null;
  const review = validReview(raw.humanReview, surface);
  if (!review) return null;

  let sources: DsProvenanceDisplay["sources"] = null;
  let strength = false;
  let counts: string | null = null;
  let reviewNeeded: DsProvenanceDisplay["reviewNeeded"] = null;
  if (projection) {
    if (!validL1(raw.l1) || !validL2(raw.l2) || !validL3(raw.l3)) return null;
    sources = sourcesOf(raw.l3);
    const s = (raw.l3 as Obj).modelSelfReportedEvidenceStrength;
    strength = Array.isArray(s) && s.length > 0;
    counts = countsOf(raw.l2, recorded);
    const needed = (raw.l2 as Obj).humanReviewNeeded;
    reviewNeeded = needed === false ? "not_flagged" : needed === true ? "flagged" : null;
  }

  const decided = review.state === "decided";
  const reviewedAt = decided && typeof review.reviewedAt === "string" ? formatReviewedAtUtc(review.reviewedAt) : null;
  const conditions = decided && Array.isArray(review.conditions) ? (review.conditions as string[]).filter((c) => c.trim() !== "") : [];
  return { surface, sources, strength, counts, reviewNeeded, reviewRecorded: decided, reviewedAt, conditions, notAuthorizedForUse: true };
}
