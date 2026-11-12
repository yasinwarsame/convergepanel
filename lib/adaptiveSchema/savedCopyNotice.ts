/**
 * Ruling B (2026-11-02): fixed wording for a reopened Milestone-2 response whose saved copy the storage cap
 * (MAX_CHARS_STORAGE_PER_MODEL) shortened, so it no longer validates. Client-safe: shared by the server-side
 * reconstruction (reconstructModelResults.ts) and the comparison notes (shared.tsx).
 */
export const SAVED_COPY_SHORTENED = "The saved copy of this response was shortened for storage, so it can no longer be shown in this format.";

/**
 * Review R2 MINOR-A: the saved text is the model's FIRST answer. A corrective retry adopted live is not saved, so a
 * saved copy that does not validate does not prove the model was excluded. Neutral, fixed wording, never parse details.
 */
export const SAVED_COPY_UNSTRUCTURED = "The saved copy of this response can't be shown in this format. Its contribution, if any, is reflected in the report above.";

/**
 * Owner-authorized (2026-11-07): the text that follows the slot's display name when the run's persisted record
 * ESTABLISHES that this slot's corrective retry succeeded and was included in the report, while its saved copy (the
 * first answer) cannot be shown. Rendered as `<SlotName/>` + this suffix, e.g. "Gemini's response was successfully
 * retried…". Only `retriedIncludedSlotsFromRecord` (savedCopyRetryEvidence.ts) can select it.
 */
export const SAVED_COPY_RETRIED_AFTER_NAME =
  "'s response was successfully retried and included in this report. The corrected response was not preserved as a separately viewable saved copy.";

/** The parseError carried by such a row: the same sentence with a fixed subject, so any surface printing it raw stays accurate. */
export const SAVED_COPY_RETRIED_INCLUDED = `This model${SAVED_COPY_RETRIED_AFTER_NAME}`;

/**
 * Case 5 (2026-11-11): the slot answered, but no saved text exists to show, and nothing in the record shows whether the
 * answer was used. Claims neither inclusion nor exclusion.
 */
export const SAVED_COPY_MISSING = "No saved copy of this response is available, and this record does not show whether it was used in the report.";

/**
 * Labels for a saved copy SHOWN AS SAVED TEXT on a reopened report (the copy is authentic, but it cannot be shown in
 * the report's format). Neither says the text was or was not used: the saved text is the model's first answer, and a
 * corrected answer adopted live is not saved separately.
 */
export const SAVED_TEXT_UNSTRUCTURED_LABEL =
  "Shown as saved text: this copy can't be read in this report's format. It is the model's first answer and may differ from what the report used.";
export const SAVED_TEXT_SHORTENED_LABEL =
  "Shown as saved text: this copy was shortened for storage, so it ends early and can't be read in this report's format. It is the model's first answer and may differ from what the report used.";

/**
 * Review D1: the saved first answer was shortened for storage AND the record ties a retry to this slot (a recorded retry
 * call plus report cells attributed to it). The first answer is not shown. A shortened copy can't show that the first
 * answer failed in full, so the retry's success is not claimed — only what the record holds.
 */
export const SAVED_COPY_RETRIED_SHORTENED =
  "A retry was recorded for this response and the report includes data from this slot. The saved first answer was shortened for storage, and any corrected response was not preserved separately.";

/** Messages that describe the saved copy, not the model's live outcome. Rendered as-is, never as "incompatible format". */
export const SAVED_COPY_NOTICES: ReadonlySet<string> = new Set([SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED, SAVED_COPY_RETRIED_INCLUDED, SAVED_COPY_MISSING, SAVED_COPY_RETRIED_SHORTENED]);
