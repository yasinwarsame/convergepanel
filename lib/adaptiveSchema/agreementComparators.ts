/**
 * Agreement Comparators (R2)
 *
 * "Agreement" is schema-dependent — this module is the registry of HOW to
 * turn a row's already-built cells (from alignment.ts's claim clustering or
 * fieldAlignment.ts's metric/scenario/step/scalar unitizers) into a final
 * per-row agreementScore (0–1) and status. It never builds cells itself.
 *
 * Every comparator starts from `defaultStanceBasedScore`, which is the
 * generic/creative_generative fallback (current behavior), then layers on
 * the schema-specific semantics described in the corrective prompt.
 */

import "server-only";
import { AlignedClaim, AlignedClaimCell, AlignedClaimStatus, ClaimCellStance, QueryType } from "./types";
import { EVIDENCE_TIER_WEIGHT } from "./config";
import { normalizeLabel } from "./fieldAlignment";

function stanceWeight(stance: ClaimCellStance): number {
  switch (stance) {
    case "agrees":
      return 1;
    case "partial":
      return 0.5;
    case "unclear":
      return 0.25;
    case "disputes":
    default:
      return 0;
  }
}

/** Generic/creative_generative fallback: plain stance-weighted average. Reused as the base for every other comparator. */
export function defaultStanceBasedScore(row: AlignedClaim): AlignedClaim {
  const nonNullCells = row.cells.filter((c): c is AlignedClaimCell => !!c);

  if (nonNullCells.length <= 1) {
    return { ...row, agreementScore: 0, status: "single_source" };
  }

  const agreementScore =
    nonNullCells.reduce((sum, c) => sum + stanceWeight(c.stance), 0) / nonNullCells.length;
  const disputesCount = nonNullCells.filter((c) => c.stance === "disputes").length;
  const agreesCount = nonNullCells.filter((c) => c.stance === "agrees").length;

  let status: AlignedClaimStatus;
  if (disputesCount === 0 && agreementScore >= 0.85) {
    status = "consensus";
  } else if (agreesCount > disputesCount && agreementScore >= 0.5) {
    status = "majority";
  } else {
    status = "split";
  }

  return { ...row, agreementScore, status };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / union.size;
}

/**
 * contested_empirical: agreement is measured on stance toward each disputed
 * claim AND on the meta-level ("do models agree that experts disagree?").
 * Models describing the same expert camps count as agreement even when they
 * weight the camps differently — approximated here via camp-label overlap
 * (Jaccard) across every pair of cells that attached camps.
 */
function contestedEmpiricalComparator(row: AlignedClaim): AlignedClaim {
  const base = defaultStanceBasedScore(row);
  const cellsWithCamps = row.cells.filter(
    (c): c is AlignedClaimCell => !!c && !!c.camps && c.camps.length > 0
  );
  if (cellsWithCamps.length < 2) return base;

  const campSets = cellsWithCamps.map((c) => new Set(c.camps!.map((camp) => normalizeLabel(camp.label))));
  let pairSum = 0;
  let pairCount = 0;
  for (let i = 0; i < campSets.length; i++) {
    for (let j = i + 1; j < campSets.length; j++) {
      pairSum += jaccard(campSets[i], campSets[j]);
      pairCount += 1;
    }
  }
  const metaAgreement = pairCount > 0 ? pairSum / pairCount : 0;
  const blended = 0.5 * base.agreementScore + 0.5 * metaAgreement;

  // High meta-agreement (models converge on the SHAPE of the dispute, e.g.
  // the same named camps) means the panel is doing its job even though
  // individual stances differ — don't let that read as a raw "split".
  let status = base.status;
  if (base.status === "split" && metaAgreement >= 0.6) status = "majority";

  return { ...base, agreementScore: blended, status };
}

/**
 * legal_regulatory: jurisdiction is a hard key. The jurisdiction row itself
 * (built by fieldAlignment.alignScalarField, conventionally id ==
 * "jurisdiction") gets a distinct "jurisdiction_mismatch" disagreementType
 * instead of an ordinary agreement score when models cite different
 * jurisdictions — that's a scope mismatch, not a genuine legal disagreement,
 * so it must never be blended into agreementScore the way a real split is.
 * unsettledIssues claim rows score normally.
 */
function legalRegulatoryComparator(row: AlignedClaim): AlignedClaim {
  const base = defaultStanceBasedScore(row);
  if (row.id !== "jurisdiction") return base;

  const nonNullCells = row.cells.filter((c): c is AlignedClaimCell => !!c);
  const mismatched = nonNullCells.some((c) => c.stance === "disputes");
  if (!mismatched) return base;

  return { ...base, agreementScore: base.agreementScore, status: "split", disagreementType: "jurisdiction_mismatch" };
}

/**
 * medical_health: evidence-tier stratification. A row's own agreementScore
 * is still stance-based (defaultStanceBasedScore already treats it
 * correctly), but its EVIDENCE-TIER WEIGHT (used by scoring.ts's run-level
 * certainty aggregation, not by this row score) must reflect the strongest
 * tier any cell in the row cites — RCT/authoritative tier disagreement
 * should count 3x an anecdotal one when the run score is computed. We stash
 * that as a temporary field scoring.ts reads; it's not part of AlignedClaim
 * proper since it's an aggregation input, not a display value.
 */
function medicalHealthComparator(row: AlignedClaim): AlignedClaim {
  return defaultStanceBasedScore(row);
}

/** financial_valuation / forecast_speculative / procedural: the unitizer (fieldAlignment.ts) already encoded the schema-specific numeric/order tolerance into each cell's stance — scoring the row is the same stance-weighted average as the fallback. */
const structuralFieldComparator = defaultStanceBasedScore;

/** factual_lookup: exact/normalized match already produced binary agrees/disputes stances in alignScalarField — any mismatch should read as a hard split, not a partial-credit average. */
function factualLookupComparator(row: AlignedClaim): AlignedClaim {
  const base = defaultStanceBasedScore(row);
  const nonNullCells = row.cells.filter((c): c is AlignedClaimCell => !!c);
  const anyMismatch = nonNullCells.some((c) => c.stance === "disputes");
  if (anyMismatch && base.status !== "single_source") {
    return { ...base, status: "split" };
  }
  return base;
}

export type AgreementComparator = (row: AlignedClaim) => AlignedClaim;

export const AGREEMENT_COMPARATORS: Record<QueryType, AgreementComparator> = {
  contested_empirical: contestedEmpiricalComparator,
  legal_regulatory: legalRegulatoryComparator,
  financial_valuation: structuralFieldComparator,
  factual_lookup: factualLookupComparator,
  procedural: structuralFieldComparator,
  medical_health: medicalHealthComparator,
  forecast_speculative: structuralFieldComparator,
  creative_generative: defaultStanceBasedScore,
  generic: defaultStanceBasedScore,
  // Query-routing redesign additions (Milestone 1): none of these schemas
  // have claim[] fields today — active graceful_limitation is scalar-only,
  // and disabled/handoff entries have no fields at all — so this comparator
  // is never actually exercised for them. Mapped to the generic fallback
  // purely for Record<QueryType, ...> exhaustiveness; revisit when any of
  // these schemas goes active with real claim[] fields.
  graceful_limitation: defaultStanceBasedScore,
  claim_verification: defaultStanceBasedScore,
  media_authenticity_review: defaultStanceBasedScore,
  document_qa: defaultStanceBasedScore,
  document_comparison: defaultStanceBasedScore,
  data_analysis: defaultStanceBasedScore,
  current_live_information: defaultStanceBasedScore,
  definition_explanation: defaultStanceBasedScore,
  causal_explanation: defaultStanceBasedScore,
  ranked_enumeration: defaultStanceBasedScore,
  checklist_taxonomy: defaultStanceBasedScore,
  comparison_matrix: defaultStanceBasedScore,
  deep_research: defaultStanceBasedScore,
  evidence_review: defaultStanceBasedScore,
  bias_blindspot_audit: defaultStanceBasedScore,
  decision_support: defaultStanceBasedScore,
  scenario_analysis: defaultStanceBasedScore,
  step_by_step_plan: defaultStanceBasedScore,
  transformation: defaultStanceBasedScore,
};

/** Evidence-tier weight for a row, used only by scoring.ts's run-level aggregation for medical_health. Defaults to the median weight (theoretical) when no cell carries an evidenceType. */
export function rowEvidenceTierWeight(row: AlignedClaim): number {
  const tiers = row.cells
    .filter((c): c is AlignedClaimCell => !!c && !!c.evidenceType)
    .map((c) => EVIDENCE_TIER_WEIGHT[c.evidenceType!]);
  if (tiers.length === 0) return 1.5;
  return Math.max(...tiers);
}

export function scoreAgreement(schemaId: QueryType, rows: AlignedClaim[]): AlignedClaim[] {
  const comparator = AGREEMENT_COMPARATORS[schemaId] ?? AGREEMENT_COMPARATORS.generic;
  return rows.map(comparator);
}
