/**
 * Firestore persistence: typed reads/writes and helpers for server-side data.
 */

import "server-only";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

/**
 * Firestore rejects `undefined` anywhere in a document. Recursively replace
 * `undefined` with `null` while preserving Timestamps, FieldValue sentinels, and primitives.
 *
 * Without the FieldValue guard, `FieldValue.increment(n)` is turned into `{ operand: n }`,
 * which writes a map instead of an atomic increment.
 */
export function sanitizeForFirestore(obj: unknown): unknown {
  if (obj === undefined) return null;
  if (obj === null) return null;
  if (obj instanceof Timestamp) return obj;
  if (obj instanceof FieldValue) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirestore);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    cleaned[key] = sanitizeForFirestore(value);
  }
  return cleaned;
}
