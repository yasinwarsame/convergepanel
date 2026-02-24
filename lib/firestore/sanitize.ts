/**
 * Firestore Sanitization Utilities
 * =================================
 * 
 * Provides safe sanitization for Firestore document data to prevent
 * "Unsupported field value: undefined" errors.
 * 
 * POLICIES:
 * ---------
 * 1. OBJECTS: undefined keys are OMITTED (key removed entirely)
 *    - Example: {a: 1, b: undefined} → {a: 1}
 * 
 * 2. ARRAYS: undefined elements are converted to `null` (preserves indices)
 *    - Example: [1, undefined, 3] → [1, null, 3]
 * 
 * 3. DATES/TIMESTAMPS: Pass through unchanged
 *    - Firestore client SDK accepts Date objects
 * 
 * 4. NON-PLAIN OBJECTS: Pass through unchanged (class instances, etc.)
 *    - Preserves prototypes and custom classes
 * 
 * USAGE:
 * ------
 * Prefer using the safe wrappers (safeSetDoc, safeUpdateDoc) from
 * './safeWrite.ts' which call sanitize internally.
 * 
 * @module lib/firestore/sanitize
 */

import type { Timestamp as ClientTimestamp } from "firebase/firestore";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Checks if a value is a plain object (not an array, class instance, etc.)
 * Handles Object.create(null) correctly.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks if a value is a Firestore Timestamp (client or admin SDK).
 * Uses duck-typing to support both firebase/firestore and firebase-admin.
 */
function isFirestoreTimestampLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { toDate?: unknown };
  return typeof v.toDate === "function";
}

// =============================================================================
// CORE SANITIZER
// =============================================================================

/**
 * Sanitizes an object for Firestore by removing undefined fields recursively.
 * Preserves non-undefined falsy values like null, false, 0, and empty strings.
 * Preserves Dates, Firestore Timestamps, and other non-plain objects.
 * Arrays preserve order; undefined elements are converted to null.
 * 
 * @param data - The value to sanitize (can be any type)
 * @returns Sanitized value safe for Firestore
 * 
 * @example
 * // Objects: undefined keys omitted
 * sanitizeForFirestore({ name: undefined, email: "test@example.com" })
 * // Result: { email: "test@example.com" }
 * 
 * @example
 * // Arrays: undefined → null, preserves indices
 * sanitizeForFirestore([1, undefined, 3])
 * // Result: [1, null, 3]
 * 
 * @example
 * // Nested: combines both rules
 * sanitizeForFirestore({ x: [undefined, { y: undefined, z: 0 }] })
 * // Result: { x: [null, { z: 0 }] }
 */
export function sanitizeForFirestore<T>(data: T): T {
  if (data === undefined) {
    // Parent decides:
    // - arrays: convert to null
    // - objects: omit key
    return undefined as T;
  }

  if (data === null || typeof data !== "object") {
    return data;
  }

  // Preserve known Firestore / Date types
  // Use duck-typing for Timestamp to support both client and admin SDKs
  if (data instanceof Date || isFirestoreTimestampLike(data)) {
    return data;
  }

  // Preserve other non-plain objects (custom classes, RegExp, Map, etc.)
  // Use proper prototype-based check to handle Object.create(null) correctly
  if (!isPlainObject(data) && !Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => {
      const sanitized = sanitizeForFirestore(item);
      return sanitized === undefined ? null : sanitized; // Firestore-safe, preserves indices
    }) as T;
  }

  // Plain object: omit keys with undefined values
  const sanitizedData: Record<string, unknown> = {};
  for (const key in data) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

    const sanitizedValue = sanitizeForFirestore((data as Record<string, unknown>)[key]);
    if (sanitizedValue !== undefined) {
      sanitizedData[key] = sanitizedValue; // omit undefined keys
    }
  }
  return sanitizedData as T;
}

// =============================================================================
// DEV-ONLY ASSERTION HELPER
// =============================================================================

/**
 * Deep-check for undefined values and throw with exact path if found.
 * Use this in development/test environments to catch undefined early.
 * 
 * @param value - The value to check
 * @param rootPath - Optional root path for error messages
 * @throws Error with exact path if undefined is found
 * 
 * @example
 * if (process.env.NODE_ENV !== 'production') {
 *   assertNoUndefinedDeep(data);
 * }
 */
export function assertNoUndefinedDeep(
  value: unknown,
  rootPath: string = "root"
): void {
  checkForUndefined(value, rootPath);
}

function checkForUndefined(value: unknown, path: string): void {
  if (value === undefined) {
    throw new Error(
      `[assertNoUndefinedDeep] Found undefined at path: ${path}. ` +
      `Firestore does not accept undefined values.`
    );
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  // Skip Date and Timestamp-like objects (client or admin SDK)
  if (value instanceof Date || isFirestoreTimestampLike(value)) {
    return;
  }

  // Skip non-plain objects (custom classes, etc.)
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      checkForUndefined(item, `${path}[${index}]`);
    });
    return;
  }

  for (const [key, val] of Object.entries(value)) {
    checkForUndefined(val, `${path}.${key}`);
  }
}

// =============================================================================
// CONVENIENCE WRAPPERS
// =============================================================================

/**
 * Strip undefined values from a top-level object (non-recursive).
 * 
 * Use this for simple cases where you only need top-level sanitization.
 * For nested structures, use sanitizeForFirestore instead.
 * 
 * @param obj - The object to strip undefined values from
 * @returns New object with undefined keys removed
 */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * Prepare data for Firestore write operations.
 * 
 * Convenience wrapper that sanitizes data and provides type safety.
 * Prefer using safeSetDoc/safeUpdateDoc from './safeWrite.ts' instead.
 * 
 * @param data - The document data to prepare
 * @returns Sanitized data safe for Firestore
 */
export function prepareForFirestore<T extends Record<string, unknown>>(data: T): Partial<T> {
  return sanitizeForFirestore(data) as Partial<T>;
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================

/**
 * Type for data that has been sanitized for Firestore.
 * Use this to annotate values that have passed through sanitizeForFirestore.
 */
export type FirestoreSafe<T> = T;
