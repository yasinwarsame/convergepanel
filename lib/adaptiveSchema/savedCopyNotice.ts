/**
 * Ruling B (2026-11-02): fixed wording for a reopened Milestone-2 response whose saved copy the storage cap
 * (MAX_CHARS_STORAGE_PER_MODEL) shortened, so it no longer validates. Client-safe: shared by the server-side
 * reconstruction (reconstructModelResults.ts) and the comparison notes (shared.tsx).
 */
export const SAVED_COPY_SHORTENED = "The saved copy of this response was shortened for storage, so it can no longer be shown in this format.";
