/**
 * Admin API Keys Management Endpoint
 * 
 * This endpoint allows admins to view and update API keys for LLM models.
 * Keys are stored in Firestore and used by the panel runner.
 * 
 * Security:
 * - SYSTEM_ADMIN only, via requireSystemAdminBearer(): the Firebase `admin`
 *   custom claim. NEVER email-derived — an ADMIN_EMAILS member must not be
 *   able to reach provider credentials or mint admin claims.
 * - Keys are always masked in responses (never exposed in full)
 * - Keys are stored server-side only (never sent to client)
 * 
 * Routes:
 * - GET /api/admin/keys - Get current key status (masked)
 * - POST /api/admin/keys - Update keys
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSystemAdminBearer } from "@/lib/firebase/adminAuth";
import { adminDb } from "@/lib/firebase/admin";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Firestore collection and document where API keys are stored
// Only admins can read/write (enforced by Firestore security rules)
const MODEL_KEYS_COLLECTION = "appConfig";
const MODEL_KEYS_DOC_ID = "modelKeys";

/**
 * GET - Retrieve current API key status (admin only)
 * 
 * Returns masked keys and configuration status for each model.
 * Keys are never returned in full - only masked versions for display.
 * 
 * @param request - Next.js request object
 * @returns Key status with masked values and configuration flags
 */
export async function GET(request: NextRequest) {
  // Verify admin authentication using ID token
  const systemAdmin = await requireSystemAdminBearer(request);
  if (!systemAdmin) {
    console.error("[admin/keys] Unauthorized access attempt", {
      hasToken: !!systemAdmin,
      isAdmin: false,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[admin/keys] Admin request from uid:", systemAdmin.uid);

  try {
    if (!adminDb) {
      console.error("[admin/keys] Firestore is not available");
      return NextResponse.json(
        { error: "Firestore is not available" },
        { status: 500 }
      );
    }

    // Read keys from Firestore
    console.log("[admin/keys] Reading from Firestore:", `${MODEL_KEYS_COLLECTION}/${MODEL_KEYS_DOC_ID}`);
    const doc = await adminDb.collection(MODEL_KEYS_COLLECTION).doc(MODEL_KEYS_DOC_ID).get();
    
    if (!doc.exists) {
      console.log("[admin/keys] Document does not exist, returning empty status");
      // Document doesn't exist yet - return empty status
      const status = {
        chatgpt: {
          configured: false,
          masked: "",
        },
        claude: {
          configured: false,
          masked: "",
        },
        grok: {
          configured: false,
          masked: "",
        },
        perplexity: {
          configured: false,
          masked: "",
        },
      };
      return NextResponse.json({ status });
    }

    const data = doc.data() || {};
    console.log("[admin/keys] Document data keys:", Object.keys(data));
    console.log("[admin/keys] Key status:", {
      chatgpt: !!data.chatgpt,
      claude: !!data.claude,
      grok: !!data.grok,
      perplexity: !!data.perplexity,
    });

    // Return masked keys (never expose full keys)
    // Masking shows first 4 and last 4 characters: "sk-12••••••••abcd"
    const status = {
      chatgpt: {
        configured: !!data.chatgpt,
        masked: maskKey(data.chatgpt),
      },
      claude: {
        configured: !!data.claude,
        masked: maskKey(data.claude),
      },
      grok: {
        configured: !!data.grok,
        masked: maskKey(data.grok),
      },
      perplexity: {
        configured: !!data.perplexity,
        masked: maskKey(data.perplexity),
      },
    };

    console.log("[admin/keys] Returning status:", {
      chatgpt: { configured: status.chatgpt.configured, hasMasked: !!status.chatgpt.masked },
      claude: { configured: status.claude.configured, hasMasked: !!status.claude.masked },
      grok: { configured: status.grok.configured, hasMasked: !!status.grok.masked },
      perplexity: { configured: status.perplexity.configured, hasMasked: !!status.perplexity.masked },
    });

    return NextResponse.json({ status });
  } catch (error: any) {
    console.error("[admin/keys] Error getting keys:", error);
    console.error("[admin/keys] Error details:", {
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
    });
    return NextResponse.json(
      { error: "Internal server error", message: error?.message },
      { status: 500 }
    );
  }
}

/**
 * POST - Update API keys (admin only)
 * 
 * Allows admins to update API keys for any model.
 * Only updates keys that are provided in the request (partial updates supported).
 * 
 * Security:
 * - Admin authentication required
 * - Keys are stored in Firestore (server-side only)
 * - Keys are never returned in full (only masked)
 * 
 * @param request - Next.js request object with key updates in body
 * @returns Updated key status with masked values
 */
export async function POST(request: NextRequest) {
  // Verify admin authentication using ID token
  const systemAdmin = await requireSystemAdminBearer(request);
  if (!systemAdmin) {
    console.error("[admin/keys] Unauthorized access attempt", {
      hasToken: !!systemAdmin,
      isAdmin: false,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[admin/keys] Admin update request from uid:", systemAdmin.uid);

  try {
    const body = await request.json();
    const { chatgpt, claude, grok, perplexity } = body;

    /**
     * Build updates object
     * 
     * Only include keys that are explicitly provided in the request.
     * This allows partial updates (e.g., only update ChatGPT key).
     * 
     * Empty strings are treated as "keep current" (not updated).
     * null values clear the key.
     */
    const updates: Record<string, string | null> = {};

    if (chatgpt !== undefined) {
      // Only update if a non-empty value is provided
      updates.chatgpt = typeof chatgpt === "string" && chatgpt.trim() ? chatgpt.trim() : null;
    }
    if (claude !== undefined) {
      updates.claude = typeof claude === "string" && claude.trim() ? claude.trim() : null;
    }
    if (grok !== undefined) {
      updates.grok = typeof grok === "string" && grok.trim() ? grok.trim() : null;
    }
    if (perplexity !== undefined) {
      updates.perplexity = typeof perplexity === "string" && perplexity.trim() ? perplexity.trim() : null;
    }

    // Update Firestore document
    // Uses merge: true to only update provided fields
    if (!adminDb) {
      console.error("[admin/keys] Firestore is not available");
      return NextResponse.json(
        { error: "Firestore is not available" },
        { status: 500 }
      );
    }
    
    console.log("[admin/keys] Updating Firestore:", `${MODEL_KEYS_COLLECTION}/${MODEL_KEYS_DOC_ID}`);
    await adminDb.collection(MODEL_KEYS_COLLECTION).doc(MODEL_KEYS_DOC_ID).set(updates, { merge: true });

    // Return updated status (with masked keys)
    const doc = await adminDb.collection(MODEL_KEYS_COLLECTION).doc(MODEL_KEYS_DOC_ID).get();
    const data = doc.data() || {};

    const status = {
      chatgpt: {
        configured: !!data.chatgpt,
        masked: maskKey(data.chatgpt),
      },
      claude: {
        configured: !!data.claude,
        masked: maskKey(data.claude),
      },
      grok: {
        configured: !!data.grok,
        masked: maskKey(data.grok),
      },
      perplexity: {
        configured: !!data.perplexity,
        masked: maskKey(data.perplexity),
      },
    };

    return NextResponse.json({ status, success: true });
  } catch (error: any) {
    console.error("Error updating keys:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * Mask API key for safe display
 * 
 * Shows first 4 and last 4 characters, masking the middle.
 * Example: "sk-1234567890abcdef" -> "sk-1••••••••cdef"
 * 
 * @param key - The API key to mask (or null/undefined)
 * @returns Masked key string, or empty string if no key
 */
function maskKey(key: string | null | undefined): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••"; // Too short to mask meaningfully
  return key.substring(0, 4) + "••••••••" + key.substring(key.length - 4);
}
