/**
 * Step 6 D5.2A — score-type (family) review thresholds for System A.
 *
 * System A's three score families compute their 0–100 score with different
 * formulas, so one shared review threshold cannot mean the same thing for all
 * of them. This module is the single contract for the optional per-family
 * override of the general review boundary (`minConsensusToAvoidReview`).
 *
 * Only VIDEO and RESEARCH can be overridden. Claims are deliberately excluded:
 * D5/D5.2 characterization showed every approvable claim scores ≥ 92 (≥ 82 for
 * any panel size), so candidate thresholds 60–85 change zero claim decisions —
 * a claim control would advertise authority that does not exist.
 *
 * Absence of an override means "uses the shared value". With no override
 * stored (Production today) every decision is identical to the pre-D5.2A
 * evaluator; this module never changes a sensitive, evidence, model-health,
 * verdict or source rule.
 *
 * Pure: no I/O, no logging. Callers that read persisted policy log the names
 * (never the values) of discarded entries.
 */
import type { GovernanceScoreFamily } from "./evaluateGovernance";

/** The closed set of families that may carry their own review threshold. */
export const FAMILY_REVIEW_THRESHOLD_FAMILIES = ["video_agreement_v1", "research_synthesis_v1"] as const;

export type FamilyReviewThresholdFamily = (typeof FAMILY_REVIEW_THRESHOLD_FAMILIES)[number];

/** Runtime policy shape: an entry present means an active override. */
export type FamilyReviewThresholds = Partial<Record<FamilyReviewThresholdFamily, number>>;

/** Mutation shape (policy POST / store): a number sets an override, `null` clears it. */
export type FamilyReviewThresholdsMutation = Partial<Record<FamilyReviewThresholdFamily, number | null>>;

export type GeneralReviewThresholdSource = "family" | "shared";

export function isFamilyReviewThresholdFamily(key: string): key is FamilyReviewThresholdFamily {
  return (FAMILY_REVIEW_THRESHOLD_FAMILIES as readonly string[]).includes(key);
}

/** A threshold value the evaluator may use: a finite number in [0, 100]. */
export function isValidReviewThresholdValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a PERSISTED family map. Only recognized families with valid values
 * survive; everything else (claim keys, unknown keys, strings, NaN, ±∞,
 * out-of-range numbers, nulls, arrays, a non-object map) is discarded and
 * named in `discarded` so the caller can warn. Never throws.
 *
 * `thresholds` is `undefined` when nothing valid remains, so a legacy or fully
 * malformed document reads exactly like one with no map at all.
 */
export function readPersistedFamilyReviewThresholds(raw: unknown): {
  thresholds: FamilyReviewThresholds | undefined;
  discarded: string[];
} {
  if (raw === undefined) return { thresholds: undefined, discarded: [] };
  if (!isPlainObject(raw)) return { thresholds: undefined, discarded: ["scoreFamilyReviewThresholds"] };
  const thresholds: FamilyReviewThresholds = {};
  const discarded: string[] = [];
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (isFamilyReviewThresholdFamily(key) && isValidReviewThresholdValue(value)) thresholds[key] = value;
    else discarded.push(`scoreFamilyReviewThresholds.${key}`);
  }
  return { thresholds: Object.keys(thresholds).length > 0 ? thresholds : undefined, discarded };
}

/**
 * The general review boundary in effect for one score family.
 *
 * video / research: a valid override → `{ value: override, source: "family" }`;
 * otherwise the shared `minConsensusToAvoidReview` with source "shared".
 * claim: ALWAYS the shared value — a claim entry is never honoured even if
 * one were somehow present at runtime.
 *
 * Defensive against a policy object built without `readPersistedFamilyReviewThresholds`:
 * only own properties of a plain-object map with a valid value count.
 */
export function resolveGeneralReviewThreshold(
  policy: { minConsensusToAvoidReview: number; scoreFamilyReviewThresholds?: unknown },
  family: GovernanceScoreFamily
): { value: number; source: GeneralReviewThresholdSource } {
  if (isFamilyReviewThresholdFamily(family)) {
    const map = policy.scoreFamilyReviewThresholds;
    if (isPlainObject(map) && Object.prototype.hasOwnProperty.call(map, family)) {
      const value = map[family];
      if (isValidReviewThresholdValue(value)) return { value, source: "family" };
    }
  }
  return { value: policy.minConsensusToAvoidReview, source: "shared" };
}

/**
 * Validate a family-map MUTATION from the policy API (stricter than the read
 * path: anything malformed is an error, nothing is silently dropped).
 */
export function validateFamilyReviewThresholdsMutation(raw: unknown):
  | { ok: true; mutation: FamilyReviewThresholdsMutation }
  | { ok: false; fields: Record<string, string> } {
  const FIELD = "scoreFamilyReviewThresholds";
  if (!isPlainObject(raw)) return { ok: false, fields: { [FIELD]: "Must be an object keyed by score type" } };
  const keys = Object.keys(raw);
  if (keys.length === 0) return { ok: false, fields: { [FIELD]: "Provide at least one score type" } };
  const fields: Record<string, string> = {};
  const mutation: FamilyReviewThresholdsMutation = {};
  for (const key of keys) {
    const value = raw[key];
    if (!isFamilyReviewThresholdFamily(key)) {
      fields[`${FIELD}.${key}`] =
        key === "claim_verification_v1"
          ? "Claim verification has no score-type review threshold"
          : "Unknown score type";
      continue;
    }
    if (value === null) mutation[key] = null;
    else if (isValidReviewThresholdValue(value)) mutation[key] = value;
    else fields[`${FIELD}.${key}`] = "Must be a number between 0 and 100, or null to use the default";
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, mutation };
}

/** Apply a mutation to the current runtime map. Returns `undefined` when no override remains. */
export function applyFamilyReviewThresholdsMutation(
  current: FamilyReviewThresholds | undefined,
  mutation: FamilyReviewThresholdsMutation
): FamilyReviewThresholds | undefined {
  const next: FamilyReviewThresholds = { ...(current ?? {}) };
  for (const family of FAMILY_REVIEW_THRESHOLD_FAMILIES) {
    if (!Object.prototype.hasOwnProperty.call(mutation, family)) continue;
    const value = mutation[family];
    if (value === null || value === undefined) delete next[family];
    else next[family] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Dotted change names for a mutation, e.g. `scoreFamilyReviewThresholds.video_agreement_v1`. */
export function familyReviewThresholdChangeNames(mutation: FamilyReviewThresholdsMutation): string[] {
  return FAMILY_REVIEW_THRESHOLD_FAMILIES.filter((f) => Object.prototype.hasOwnProperty.call(mutation, f)).map(
    (f) => `scoreFamilyReviewThresholds.${f}`
  );
}
