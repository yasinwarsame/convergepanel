/**
 * Project/Research Assignment — the ONE shared, pure normalization module
 * for assignment values. Used by every reader (list rows, detail, DTOs) AND
 * by both mutations' OCC / no-op comparisons, so a stored value has exactly
 * one deterministic representation everywhere and readers can never
 * disagree with the write path (brief §6.6).
 *
 * Request-side canonicalization (`canonicalizeAssigneeUids`) runs with no
 * Firestore I/O BEFORE any membership read: shape check → deduplicate →
 * canonical sort → cap. That is what bounds the transaction to at most
 * `MAX_PROJECT_ASSIGNEES` target-membership reads regardless of how large
 * or duplicate-heavy the raw request was (brief §6.2).
 *
 * Stored-side normalization (`normalizeStoredAssigneeUids`,
 * `normalizeStoredAssigneeUid`) maps any malformed persisted value to a
 * safe canonical value (`[]` / `null`) and REPORTS the anomaly so the
 * caller can log it server-side. Raw malformed values never leave the
 * server, never crash a page, and are never authorization input. Because
 * the mutations compare against the same normalized value, a malformed
 * field is repairable by an authorized write with the matching expected
 * state — never a permanent OCC conflict loop.
 *
 * No Firestore import, no `server-only`: pure and testable anywhere.
 */

import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

/** D3 — a validation/storage bound, deliberately NOT a seat rule. */
export const MAX_PROJECT_ASSIGNEES = 20;

/** The repository's uid-shape check, reused (never a second regex). */
export function isValidAssigneeUidShape(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && getPersonalWorkspaceId(value).ok;
}

/** Fixed comparator — code-unit order, so the canonical form is stable across runtimes and locales. */
function compareUids(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type CanonicalizeAssigneeUidsResult =
  | { ok: true; uids: string[] }
  | { ok: false; reason: "invalid_shape" }
  | { ok: false; reason: "too_many_assignees" };

/**
 * Pure. Order of checks is the point: the shape of EVERY raw element is
 * validated first (cheap, no I/O), then duplicates collapse, then the cap
 * applies to the UNIQUE count. A 1,000-element request that collapses to
 * 5 unique uids is valid; one that collapses to 21 is `too_many_assignees`
 * — and neither has cost a single membership read.
 */
export function canonicalizeAssigneeUids(input: unknown): CanonicalizeAssigneeUidsResult {
  if (!Array.isArray(input)) return { ok: false, reason: "invalid_shape" };
  for (const entry of input) {
    if (!isValidAssigneeUidShape(entry)) return { ok: false, reason: "invalid_shape" };
  }
  const unique = Array.from(new Set(input as string[])).sort(compareUids);
  if (unique.length > MAX_PROJECT_ASSIGNEES) return { ok: false, reason: "too_many_assignees" };
  return { ok: true, uids: unique };
}

export type NormalizedAssigneeUids = { uids: string[]; malformed: boolean };

/**
 * Pure. absent/undefined ⇒ `[]`; a valid array of well-shaped strings ⇒ the
 * canonical deduplicated, sorted values (`malformed: false` even if the
 * stored order or duplicates differed — order is not a semantic
 * difference); anything else ⇒ `[]` with `malformed: true`.
 */
export function normalizeStoredAssigneeUids(raw: unknown): NormalizedAssigneeUids {
  if (raw === undefined) return { uids: [], malformed: false };
  if (!Array.isArray(raw)) return { uids: [], malformed: true };
  for (const entry of raw) {
    if (!isValidAssigneeUidShape(entry)) return { uids: [], malformed: true };
  }
  const unique = Array.from(new Set(raw as string[])).sort(compareUids);
  // A stored list longer than the cap is still returned in full for
  // display/repair purposes; the cap is enforced on WRITES, and the next
  // authorized write replaces it with a capped canonical list.
  return { uids: unique, malformed: false };
}

export type NormalizedAssigneeUid = { uid: string | null; malformed: boolean };

/** Pure. absent/null ⇒ `null`; a well-shaped string ⇒ that value; anything else ⇒ `null` with `malformed: true`. */
export function normalizeStoredAssigneeUid(raw: unknown): NormalizedAssigneeUid {
  if (raw === undefined || raw === null) return { uid: null, malformed: false };
  if (isValidAssigneeUidShape(raw)) return { uid: raw, malformed: false };
  return { uid: null, malformed: true };
}

/** Pure. Both inputs must already be canonical (sorted, unique). */
export function assigneeUidsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Pure. The bounded change set an audit event records. */
export function diffAssigneeUids(previous: readonly string[], next: readonly string[]): { addedUids: string[]; removedUids: string[] } {
  const prev = new Set(previous);
  const nxt = new Set(next);
  return {
    addedUids: next.filter((uid) => !prev.has(uid)),
    removedUids: previous.filter((uid) => !nxt.has(uid)),
  };
}
