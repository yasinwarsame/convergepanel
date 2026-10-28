/**
 * Order 6 / S-E.1 — Decision Support wording on receipt surfaces (K-3: Decision Support only).
 *
 * A DS receipt's conclusion and basis name the recommended option and option × criterion cells, which come from the
 * current text-similarity grouping, so the D-9 disclosure travels with every DS receipt. The receipt carries no option
 * count, so the disclosure is shown on every DS receipt rather than inferred from the conclusion text.
 *
 * E-6: a DS receipt that was not flagged states that the system did not flag it, never that review is unnecessary.
 * Every other schema keeps its existing markup exactly.
 */

import { DS_NOT_FLAGGED_FOR_REVIEW, DS_OPTION_GROUPING_DISCLOSURE, isDecisionSupportSchema } from "@/lib/adaptiveSchema/dsLabelWording";

export function ReceiptReviewFlag({ schemaId, humanReviewNeeded }: { schemaId: unknown; humanReviewNeeded: boolean }) {
  if (humanReviewNeeded) return <span>Human review needed</span>;
  return <span>{isDecisionSupportSchema(schemaId) ? DS_NOT_FLAGGED_FOR_REVIEW : "Human review not flagged as needed"}</span>;
}

export function ReceiptGroupingDisclosure({ schemaId, className }: { schemaId: unknown; className: string }) {
  if (!isDecisionSupportSchema(schemaId)) return null;
  return <p className={className}>{DS_OPTION_GROUPING_DISCLOSURE}</p>;
}
