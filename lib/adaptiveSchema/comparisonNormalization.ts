/**
 * The scalar comparison normalizer — the one rule the shipped field comparator (fieldAlignment.alignScalarField) uses
 * to decide whether two answers are the same, kept in a client-safe module so presentation (positionPresentation.ts)
 * groups answers exactly as the comparator does. Moved here unchanged from fieldAlignment.ts; behaviour is identical.
 *
 * Pure and client-safe: no "server-only", no I/O.
 */

/** Trimmed, lower-cased, common punctuation removed, whitespace runs collapsed: "St. Louis" and "st louis" are equal. */
export function normalizeForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/[.,;:!?'"]/g, "").replace(/\s+/g, " ");
}
