/**
 * Order 6 / S-E.1 — the decision-receipt source flag and its separator, shared by the receipt surfaces
 * (PersonalReviewDetail, AdaptiveReviewDetail, AdaptiveReviewListItem).
 *
 * Other schemas render exactly the markup they rendered before. A Decision Support receipt carries only the stored
 * `sourceBacked` flag, which is also true for a blank source list, so it cannot establish that sources were listed
 * (K-5): a true flag renders nothing, and a false flag renders "No sources listed" (K-3: DS only).
 */

import { dsReceiptSourcesLabel, isDecisionSupportSchema } from "@/lib/adaptiveSchema/dsLabelWording";

export default function ReceiptSourcesFlag({ schemaId, sourceBacked }: { schemaId: unknown; sourceBacked: boolean }) {
  const text = isDecisionSupportSchema(schemaId) ? dsReceiptSourcesLabel(sourceBacked) : sourceBacked ? "Source-backed" : "Not source-backed";
  if (text === null) return null;
  return (
    <>
      <span>{text}</span>
      <span aria-hidden>&middot;</span>
    </>
  );
}
