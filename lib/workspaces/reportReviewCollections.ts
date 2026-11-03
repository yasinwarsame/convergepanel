/** Order B — Report Review subcollection names (write-once history). Shared so writers never import each other. */
export const REPORT_REVIEW_CYCLES_COLLECTION = "reportReviewCycles";
export const REPORT_REVIEW_EVENTS_COLLECTION = "reportReviewEvents";
/** Order A / S1 — write-once snapshot of the exact reviewed content, one per cycle (doc id = cycle number). */
export const REPORT_REVIEW_SNAPSHOTS_COLLECTION = "reportReviewSnapshots";
