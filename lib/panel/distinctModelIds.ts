/**
 * Governance input authority (F1) — "at least two models" means at least two
 * DISTINCT model ids. A direct API caller could otherwise send
 * `["chatgpt", "chatgpt"]`, satisfy the minimum with one provider, and have one
 * model's answers counted as two independent perspectives.
 *
 * Returns the ids in first-occurrence order with later repeats dropped. Pure;
 * never adds, reorders or validates ids — callers keep their own known-id
 * filtering and minimum checks, applied to this result.
 */
export function distinctModelIds<T>(ids: readonly T[]): T[] {
  return Array.from(new Set(ids));
}
