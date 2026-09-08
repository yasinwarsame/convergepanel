/**
 * Firestore-based Rate Limiting
 * 
 * Implements per-user rate limiting using Firestore with atomic increments and TTL cleanup.
 * This works on Vercel without requiring Redis.
 * 
 * Strategy:
 * - Store rate limit counters in Firestore with timestamp
 * - Use atomic increments to prevent race conditions
 * - Cleanup old entries periodically (TTL-style)
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "@/lib/logger";

export interface RateLimitConfig {
  maxRequests: number; // Max requests allowed in the time window
  windowSeconds: number; // Time window in seconds
  identifier: string; // Rate limit identifier (e.g., "run-panel:${uid}")
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfter?: number; // Seconds until retry allowed (only if !allowed)
}

/**
 * Check and increment rate limit counter
 * 
 * Returns whether the request is allowed and remaining quota.
 * Thread-safe using Firestore atomic operations.
 * 
 * @param config - Rate limit configuration
 * @returns Rate limit result with allowed status and remaining quota
 */
/**
 * Firestore document-ID constraints that matter here: non-empty, no `/`
 * (which would silently create a nested path or throw), not `.`/`..`, and
 * within the 1500-byte UTF-8 limit. Deliberately narrow — ordinary namespaced
 * keys (`run-panel:<uid>`, `set-admin:<ip>`) are unchanged, so no key
 * migration occurs.
 */
export function isValidRateLimitIdentifier(identifier: unknown): identifier is string {
  if (typeof identifier !== "string") return false;
  if (identifier.length === 0) return false;
  if (identifier.includes("/")) return false;
  if (identifier === "." || identifier === "..") return false;
  if (/^__.*__$/.test(identifier)) return false;
  if (Buffer.byteLength(identifier, "utf8") > 1500) return false;
  return true;
}

export async function checkRateLimit(
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (!adminDb) {
    logger.error("[rateLimit] Firestore not available, denying request");
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + config.windowSeconds * 1000),
      retryAfter: config.windowSeconds,
    };
  }

  const now = Date.now();
  const windowStart = now - config.windowSeconds * 1000;
  const resetAt = new Date(now + config.windowSeconds * 1000);

  try {
    /**
     * Phase FIRST-ADMIN-C12 — the document reference is built INSIDE the
     * protected boundary.
     *
     * `.doc()` used to be called above this `try`. Firestore rejects a document
     * path with an even number of components, so an identifier containing `/`
     * made `.doc()` THROW — past this module's documented never-throws
     * contract, and past its fail-closed guarantee. Two call sites derive the
     * identifier from a request header; six others have no try/catch of their
     * own, so the throw would surface as an unhandled rejection on a protected
     * route.
     *
     * A malformed identifier is now an ordinary fail-closed denial: the caller
     * is refused, and the protected side effect does not run.
     */
    if (!isValidRateLimitIdentifier(config.identifier)) {
      logger.error("[rateLimit] Rejecting malformed rate-limit identifier; denying request");
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: config.windowSeconds,
      };
    }
    const rateLimitDocRef = adminDb.collection("rate_limits").doc(config.identifier);

    // Atomic increment transaction
    const result = await adminDb.runTransaction(async (transaction) => {
      const doc = await transaction.get(rateLimitDocRef);
      const data = doc.data();
      
      /**
       * Phase FIRST-ADMIN-C11 — the stored value is the window's ACTUAL START.
       *
       * This previously wrote `windowStart: lastReset - windowSeconds * 1000`.
       * On a fresh window `lastReset === now`, so the stored start was already a
       * full window in the past, and the read below (`stored > now - windowMs`)
       * failed for every request landing in a later millisecond. Each one took
       * the "expired" branch, reset the count to 0, and was allowed: the counter
       * never exceeded 1 against any limit, at all 15 call sites.
       * `/api/admin/set-admin` — unauthenticated, mints SYSTEM_ADMIN on any uid,
       * no audit record, no success log — was documented as throttled to 3
       * attempts per 5 minutes per IP and was not throttled at all.
       *
       * Both stored fields are type-checked, so a corrupted document starts a
       * fresh window rather than throwing.
       */
      let count = 0;
      let windowStartedAt = now;

      if (data) {
        const storedStart = typeof data.windowStart === "number" ? data.windowStart : 0;
        if (storedStart > windowStart) {
          // Inside the live window: carry the count and keep the SAME start, so
          // a stream of requests cannot slide the window forward indefinitely.
          count = typeof data.count === "number" ? data.count : 0;
          windowStartedAt = storedStart;
        }
      }

      // Increment count
      count += 1;

      transaction.set(rateLimitDocRef, {
        count,
        windowStart: windowStartedAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        count,
        windowStartedAt,
        allowed: count <= config.maxRequests,
        remaining: Math.max(0, config.maxRequests - count),
      };
    });
    
    // The window ends relative to when it STARTED, not to this request, so a
    // denied caller is told how long the real window actually has left.
    const windowEndsAt = new Date(result.windowStartedAt + config.windowSeconds * 1000);
    const retryAfter = result.allowed ? undefined : Math.max(1, Math.ceil((windowEndsAt.getTime() - now) / 1000));

    // Opportunistic cleanup: run on ~1% of requests, fire-and-forget.
    if (Math.random() < 0.01) {
      void cleanupRateLimits();
    }

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: windowEndsAt,
      retryAfter,
    };
  } catch (error: any) {
    logger.error("[rateLimit] Error checking rate limit, denying request", {
      identifier: config.identifier,
      error: error?.message,
    });
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: config.windowSeconds,
    };
  }
}

/**
 * Cleanup old rate limit documents (can be called periodically or on-demand)
 * This prevents Firestore collection from growing indefinitely.
 */
export async function cleanupRateLimits(olderThanSeconds: number = 3600): Promise<number> {
  if (!adminDb) {
    return 0;
  }

  const cutoff = Timestamp.fromMillis(Date.now() - olderThanSeconds * 1000);
  
  try {
    const snapshot = await adminDb
      .collection("rate_limits")
      .where("updatedAt", "<", cutoff)
      .limit(500) // Batch delete to avoid timeout
      .get();
    
    const batch = adminDb.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    
    return snapshot.size;
  } catch (error: any) {
    logger.error("[rateLimit] Error cleaning up rate limits", { error: error?.message });
    return 0;
  }
}

