/**
 * Admin Users Management Endpoint
 * 
 * Allows admins to list all users in the system.
 * 
 * Security:
 * - Only admins can access, via requireAdminApiAccess(): the Firebase `admin`
 *   custom claim OR a VERIFIED allowlisted email (Phase FIRESTORE-AUTHZ-P0.2).
 *   NOT requireAdmin(), which this comment previously and incorrectly named.
 * - Returns user data from Firestore (email, role, etc.)
 * 
 * Route: GET /api/admin/users
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET - List all users (admin only)
 * 
 * Retrieves all user documents from Firestore.
 * Used by the admin dashboard to display user list.
 * 
 * @param request - Next.js request object
 * @returns Array of user objects with id, email, role, etc.
 */
export async function GET(request: NextRequest) {
  // Verify admin authentication
  const auth = await requireAdminApiAccess(request);
  if (!auth) {
    logger.error("[admin/users] Unauthorized access attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  logger.debug("[admin/users] Admin request", { uid: auth.uid });

  try {
    if (!adminDb) {
      throw new Error("Firestore is not available");
    }

    /**
     * Get all users from Firestore
     * 
     * Uses Admin SDK which bypasses security rules.
     * Regular users cannot list all users (enforced by Firestore rules).
     */
    // Read from canonical path: users/{uid} (same path used by incrementUserTokenUsage)
    const usersSnapshot = await adminDb.collection("users").get();
    const users = usersSnapshot.docs.map((doc) => {
      const data = doc.data();
      
      // Helper to convert Firestore Timestamp to ISO string or null
      const convertTimestamp = (timestamp: any): string | null => {
        if (!timestamp) return null;
        // If it's a Firestore Timestamp object, convert to ISO string
        if (timestamp.toDate && typeof timestamp.toDate === "function") {
          return timestamp.toDate().toISOString();
        }
        // If it's already a Date object, convert to ISO string
        if (timestamp instanceof Date) {
          return timestamp.toISOString();
        }
        // If it's an object with _seconds (serialized Timestamp), convert it
        if (timestamp._seconds !== undefined) {
          return new Date(timestamp._seconds * 1000 + (timestamp._nanoseconds || 0) / 1000000).toISOString();
        }
        // If it's a number (Unix timestamp in seconds or milliseconds)
        if (typeof timestamp === "number") {
          // If it's in seconds (less than year 2000 in milliseconds), multiply by 1000
          const date = timestamp < 946684800000 ? new Date(timestamp * 1000) : new Date(timestamp);
          return date.toISOString();
        }
        // If it's already a string, try to parse it
        if (typeof timestamp === "string") {
          const parsed = new Date(timestamp);
          return isNaN(parsed.getTime()) ? null : parsed.toISOString();
        }
        return null;
      };

      // Convert timestamps first
      const createdAt = convertTimestamp(data.createdAt);
      const lastLoginAt = convertTimestamp(data.lastLoginAt);

      // Extract timestamp fields and usage fields to avoid overwriting with spread
      const { 
        createdAt: _, 
        lastLoginAt: __, 
        totalRuns: ___,
        runsThisMonth: ____,
        usageMonth: _____,
        billingCycleStart: ______,
        tokensUsedCurrentPeriod: _______,
        tokensPeriodStart: ________,
        ...restData 
      } = data;

      // Get runsCount from totalRuns (lifetime total) or default to 0
      // Read from data before destructuring
      // If totalRuns doesn't exist, try to estimate from runsThisMonth (not perfect, but better than 0)
      let runsCount = typeof data.totalRuns === "number" ? data.totalRuns : 0;
      
      // If totalRuns is missing but runsThisMonth exists, use it as a rough estimate
      // This handles existing users who haven't had totalRuns initialized yet
      if (runsCount === 0 && typeof data.runsThisMonth === "number" && data.runsThisMonth > 0) {
        runsCount = data.runsThisMonth; // Rough estimate - will be corrected on next run
        logger.debug(`[admin/users] User ${doc.id} missing totalRuns, using runsThisMonth (${data.runsThisMonth}) as estimate`);
      }

      // Get tokens used in current period from denormalized counter
      // This is maintained by incrementUserTokenUsage() when runs complete
      // Ensure it's a valid number (defensive against NaN/undefined)
      const safeNumber = (val: any): number | null => {
        if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
          return val;
        }
        return null; // Return null for missing/invalid values (will display as "—" in admin UI)
      };
      
      const tokensUsedCurrentPeriod: number | null = safeNumber(data.tokensUsedCurrentPeriod);

      // Get maxModelsPerRun for plan display (normalize 4→5 for legacy)
      const rawMaxModels = data.maxModelsPerRun;
      const maxModelsPerRun = rawMaxModels === 4 ? 5 : (rawMaxModels || null);

      // Build user object with explicit field ordering to prevent overwrites
      const userObj: any = {
        id: doc.id,
        uid: doc.id, // Also include as uid for consistency
        email: data.email || null,
        name: data.name || null,
        role: data.role || "user",
        plan: data.plan || "free",
        subscriptionStatus: data.subscriptionStatus || null,
        isDisabled: data.isDisabled || false,
        maxModelsPerRun, // Include for plan display
        // Include other fields that might be useful (but exclude usage fields we handle separately)
        ...restData,
        // Set converted timestamps (these override any timestamp fields from spread)
        createdAt,
        lastLoginAt,
        // Set usage fields AFTER spread to ensure they're not overwritten
        runsCount, // Lifetime total of panel runs
        tokensUsedCurrentPeriod, // Tokens used in current billing period (null if not tracked)
      };

      // Dev-only instrumentation: log sample user token data
      const isDebugMode = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEBUG_TOKENS === "true";
      if (isDebugMode && doc.id === usersSnapshot.docs[0]?.id) {
        const adminDocPath = `users/${doc.id}`;
        logger.debug(`[TOKENS:admin]`, {
          uid: doc.id,
          docPath: adminDocPath,
          tokensUsedCurrentPeriod: userObj.tokensUsedCurrentPeriod ?? 0,
          rawValue: data.tokensUsedCurrentPeriod,
          hasField: 'tokensUsedCurrentPeriod' in data,
        });
      }

      // Debug log for first user to verify fields are set
      if (doc.id === usersSnapshot.docs[0]?.id) {
        logger.debug("[admin/users] Sample user object", {
          id: userObj.id,
          email: userObj.email,
          runsCount: userObj.runsCount,
          tokensUsedCurrentPeriod: userObj.tokensUsedCurrentPeriod,
          totalRuns: data.totalRuns,
          runsThisMonth: data.runsThisMonth,
          hasTotalRuns: "totalRuns" in data,
          dataKeys: Object.keys(data),
        });
      }

      return userObj;
    });

    logger.info(`[admin/users] Returning ${users.length} users to admin`, { userCount: users.length });
    return NextResponse.json({ users });
  } catch (error: any) {
    logger.error("[admin/users] Error fetching users", { error: error?.message });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

