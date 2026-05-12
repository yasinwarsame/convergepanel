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
export async function checkRateLimit(
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (!adminDb) {
    console.error("[rateLimit] Firestore not available, denying request");
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

  const rateLimitDocRef = adminDb.collection("rate_limits").doc(config.identifier);
  
  try {
    // Atomic increment transaction
    const result = await adminDb.runTransaction(async (transaction) => {
      const doc = await transaction.get(rateLimitDocRef);
      const data = doc.data();
      
      let count = 0;
      let lastReset = now;
      
      if (data) {
        // Check if we're still in the current window
        const windowStartTime = data.windowStart || 0;
        
        if (windowStartTime >= windowStart) {
          // Still in current window, use existing count
          count = data.count || 0;
          lastReset = windowStartTime + config.windowSeconds * 1000;
        } else {
          // Window expired, reset count
          count = 0;
          lastReset = now;
        }
      }
      
      // Increment count
      count += 1;
      
      // Update document with new count and window start
      transaction.set(rateLimitDocRef, {
        count,
        windowStart: lastReset - config.windowSeconds * 1000,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      
      return {
        count,
        allowed: count <= config.maxRequests,
        remaining: Math.max(0, config.maxRequests - count),
      };
    });
    
    const retryAfter = result.allowed ? undefined : Math.ceil((resetAt.getTime() - now) / 1000);

    // Opportunistic cleanup: run on ~1% of requests, fire-and-forget.
    if (Math.random() < 0.01) {
      void cleanupRateLimits();
    }

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt,
      retryAfter,
    };
  } catch (error: any) {
    console.error("[rateLimit] Error checking rate limit, denying request:", {
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
    console.error("[rateLimit] Error cleaning up rate limits:", error?.message);
    return 0;
  }
}

