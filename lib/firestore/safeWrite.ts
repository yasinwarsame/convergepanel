/**
 * Safe Firestore Write Utilities
 * ===============================
 * 
 * Provides type-safe wrappers around Firestore write operations that
 * automatically sanitize data to prevent undefined value errors.
 * 
 * USE THESE INSTEAD OF DIRECT FIRESTORE CALLS:
 * - safeSetDoc instead of setDoc
 * - safeUpdateDoc instead of updateDoc  
 * - safeAddDoc instead of addDoc
 * 
 * BENEFITS:
 * - Automatic undefined sanitization
 * - Dev-mode assertions for early error detection
 * - Type-safe with full TypeScript support
 * - Preserves Firestore special types (Timestamp, FieldValue, etc.)
 * 
 * @module lib/firestore/safeWrite
 */

import {
  doc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  DocumentReference,
  CollectionReference,
  SetOptions,
  UpdateData,
  WithFieldValue,
  DocumentData,
  PartialWithFieldValue,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { sanitizeForFirestore, assertNoUndefinedDeep } from "./sanitize";

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Enable dev-mode assertions for undefined detection.
 * In production, assertions are skipped for performance.
 */
const DEV_MODE = process.env.NODE_ENV !== "production";

/**
 * Log sanitization in dev mode for debugging
 */
const DEBUG_SANITIZE = false; // Set to true for verbose logging

// =============================================================================
// SAFE WRITE WRAPPERS
// =============================================================================

/**
 * Safe wrapper around Firestore setDoc that sanitizes data before writing.
 * 
 * @param ref - Document reference to write to
 * @param data - Data to write (will be sanitized)
 * @param options - Optional SetOptions (merge, mergeFields)
 * @returns Promise that resolves when write completes
 * 
 * @example
 * // Simple set
 * await safeSetDoc(doc(db, "users", uid), {
 *   email: "test@example.com",
 *   name: undefined, // Will be omitted
 * });
 * 
 * @example
 * // With merge
 * await safeSetDoc(doc(db, "users", uid), { name: "John" }, { merge: true });
 */
export async function safeSetDoc<T extends DocumentData>(
  ref: DocumentReference<T>,
  data: WithFieldValue<T>,
  options?: SetOptions
): Promise<void> {
  // Dev-mode assertion to catch undefined early with path info
  if (DEV_MODE) {
    try {
      assertNoUndefinedDeep(data, "data");
    } catch (e) {
      // Log warning but continue with sanitization
      console.warn("[safeSetDoc]", (e as Error).message, "- will be sanitized");
    }
  }

  // Sanitize data to remove undefined values
  const sanitized = sanitizeForFirestore(data);

  if (DEBUG_SANITIZE && DEV_MODE) {
    console.log("[safeSetDoc] Original:", data);
    console.log("[safeSetDoc] Sanitized:", sanitized);
  }

  // Call Firestore with sanitized data
  if (options) {
    return setDoc(ref, sanitized as WithFieldValue<T>, options);
  }
  return setDoc(ref, sanitized as WithFieldValue<T>);
}

/**
 * Safe wrapper around Firestore updateDoc that sanitizes data before writing.
 * 
 * @param ref - Document reference to update
 * @param data - Data to update (will be sanitized)
 * @returns Promise that resolves when update completes
 * 
 * @example
 * await safeUpdateDoc(doc(db, "users", uid), {
 *   name: newName || undefined, // Will be omitted if empty
 *   updatedAt: serverTimestamp(),
 * });
 */
export async function safeUpdateDoc<T extends DocumentData>(
  ref: DocumentReference<T>,
  data: UpdateData<T>
): Promise<void> {
  // Dev-mode assertion
  if (DEV_MODE) {
    try {
      assertNoUndefinedDeep(data, "data");
    } catch (e) {
      console.warn("[safeUpdateDoc]", (e as Error).message, "- will be sanitized");
    }
  }

  // Sanitize data
  const sanitized = sanitizeForFirestore(data);

  if (DEBUG_SANITIZE && DEV_MODE) {
    console.log("[safeUpdateDoc] Original:", data);
    console.log("[safeUpdateDoc] Sanitized:", sanitized);
  }

  return updateDoc(ref, sanitized as UpdateData<T>);
}

/**
 * Safe wrapper around Firestore addDoc that sanitizes data before writing.
 * 
 * @param collectionRef - Collection reference to add to
 * @param data - Data to add (will be sanitized)
 * @returns Promise with the new document reference
 * 
 * @example
 * const docRef = await safeAddDoc(collection(db, "posts"), {
 *   title: "Hello",
 *   author: authorName || undefined, // Will be omitted if empty
 *   createdAt: serverTimestamp(),
 * });
 */
export async function safeAddDoc<T extends DocumentData>(
  collectionRef: CollectionReference<T>,
  data: WithFieldValue<T>
): Promise<DocumentReference<T>> {
  // Dev-mode assertion
  if (DEV_MODE) {
    try {
      assertNoUndefinedDeep(data, "data");
    } catch (e) {
      console.warn("[safeAddDoc]", (e as Error).message, "- will be sanitized");
    }
  }

  // Sanitize data
  const sanitized = sanitizeForFirestore(data);

  if (DEBUG_SANITIZE && DEV_MODE) {
    console.log("[safeAddDoc] Original:", data);
    console.log("[safeAddDoc] Sanitized:", sanitized);
  }

  return addDoc(collectionRef, sanitized as WithFieldValue<T>);
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get a document reference with type safety.
 * Re-exported for convenience so callers don't need separate imports.
 */
export function getDocRef<T extends DocumentData>(
  path: string,
  ...pathSegments: string[]
): DocumentReference<T> {
  return doc(db, path, ...pathSegments) as DocumentReference<T>;
}

/**
 * Get a collection reference with type safety.
 * Re-exported for convenience.
 */
export function getCollectionRef<T extends DocumentData>(
  path: string,
  ...pathSegments: string[]
): CollectionReference<T> {
  return collection(db, path, ...pathSegments) as CollectionReference<T>;
}

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type { DocumentReference, CollectionReference, SetOptions };
