/**
 * Order 6 / S-2a — owner-approved display text for the Decision Support provenance section (OD-1, first slice;
 * Q2–Q6 rulings). Strings that already exist as S-E.1 approved wording are re-exported, not rewritten:
 *   - "Sources" (K-6), "Sources listed; not independently verified" and "No sources listed" (K-1 E-2/E-3, Q4);
 *   - the evidence-strength caption (Q3: reuse the exact S-E.1 caption);
 *   - "These counts are not a certainty measure." and "System did not flag this for human review." (K-1 E-6/E-7).
 *
 * Approved first-slice strings with no reachable source state are deliberately not defined here (see the S-2a mapping):
 * "Authorized for use" and "Use authorization not recorded" (the only stored value is `not_authorized_no_policy`),
 * "Review status not recorded" (routes never send an unavailable review), "Not recorded", and the per-entry
 * "(model-assigned)" qualifier (Q6: no individual strength entries in slice 1).
 */

export {
  DS_SOURCES_FIELD as DS_PROVENANCE_SOURCES_LABEL,
  DS_SOURCES_LISTED,
  DS_NO_SOURCES_LISTED,
  DS_STRENGTH_CAPTION,
  DS_NOT_A_CERTAINTY_MEASURE,
  DS_NOT_FLAGGED_FOR_REVIEW,
} from "./dsLabelWording";

export const DS_PROVENANCE_HEADING = "Provenance and review details";
export const DS_PROVENANCE_SUMMARY = "Recorded evidence and review details";
export const DS_PROVENANCE_UNKNOWN = "Unknown";
export const DS_PROVENANCE_STRENGTH_LABEL = "Model-assigned strength";
export const DS_PROVENANCE_COUNTS_LABEL = "Model recommendations";
export const DS_PROVENANCE_REVIEW_LABEL = "Review status";
export const DS_PROVENANCE_FLAGGED_FOR_REVIEW = "Flagged for human review";
export const DS_PROVENANCE_REVIEW_RECORDED = "Review recorded";
export const DS_PROVENANCE_REVIEWED_AT_LABEL = "Reviewed at";
export const DS_PROVENANCE_CONDITIONS_LABEL = "Review conditions";
export const DS_PROVENANCE_USE_LABEL = "Use authorization";
export const DS_PROVENANCE_NOT_AUTHORIZED_FOR_USE = "Not authorized for use";
export const DS_PROVENANCE_EMPTY = "No provenance or review details recorded";
