/**
 * Item 6A — read-only disclosure for a FROZEN Decision Receipt written before criterion provenance was checked against
 * the user's request. The frozen record is never modified; this notice is the only addition, and it renders only when
 * the Receipt's basis contains a criterion line ending in the retired "(user-provided)" suffix. Shared by every surface
 * that renders a frozen Receipt (workspace review, personal review) so the rule lives in one place.
 */
import { LEGACY_FROZEN_RECEIPT_NOTICE, receiptHasLegacyUserProvidedCriteria } from "@/lib/adaptiveSchema/criterionProvenance";

export default function LegacyReceiptProvenanceNotice({ basis }: { basis: readonly string[] }) {
  if (!receiptHasLegacyUserProvidedCriteria(basis)) return null;
  return (
    <p className="mt-4 rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted" data-testid="receipt-legacy-provenance-notice">
      {LEGACY_FROZEN_RECEIPT_NOTICE}
    </p>
  );
}
