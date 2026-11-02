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

/** Messages that describe the saved copy, not the model's live outcome. Rendered as-is, never as "incompatible format". */
export const SAVED_COPY_NOTICES: ReadonlySet<string> = new Set([SAVED_COPY_SHORTENED, SAVED_COPY_UNSTRUCTURED]);
