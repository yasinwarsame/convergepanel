/**
 * Readable labels for the generic schema's claim metadata (presentation follow-up to #276, owner-approved 2026-11-02).
 *
 * Display-only and one-to-one: each stored value maps to exactly one label, and nothing else is accepted. A value
 * outside these tables is not relabelled; the caller falls back to showing the object as stored. The stored value is
 * never changed. Confidence here is the answering model's own label for its claim. It is not a verified finding of the
 * panel, and the UI says so.
 *
 * Values mirror ClaimZod in lib/adaptiveSchema/validator.ts.
 */

export const STANCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  asserts: "Asserts",
  disputes: "Disputes",
  uncertain: "Uncertain",
});

export const CONFIDENCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  settled: "Settled",
  majority_view: "Majority view",
  contested: "Contested",
  speculative: "Speculative",
});

export const EVIDENCE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  empirical: "Empirical",
  theoretical: "Theoretical",
  anecdotal: "Anecdotal",
  authoritative: "Authoritative",
});

/** The label for `value` in `table`, or null when the value is not one of the table's own keys. */
export function claimLabel(table: Readonly<Record<string, string>>, value: unknown): string | null {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(table, value)) return null;
  return table[value];
}
