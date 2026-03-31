/**
 * HTTP API route (user/verifications/[verificationId]): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import { mapStoredVerificationToClientPayload } from "@/lib/user/mapStoredVerificationToClientPayload";
import { mapStoredVideoVerificationToClientPayload } from "@/lib/user/mapStoredVideoVerificationToClientPayload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  try {
    const auth = await verifySessionCookie(req);
    if (auth) return auth.uid;
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { ok: false, errorCode: "unauthorized", message: "Please sign in." },
        { status: 401 }
      );
    }
    const token = authHeader.split("Bearer ")[1];
    const decoded = await verifyIdToken(token);
    return decoded.uid;
  } catch (e: unknown) {
    logger.error("[user/verifications/id] auth failed", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, errorCode: "auth_error", message: "Authentication failed." },
      { status: 401 }
    );
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ verificationId: string }> }
) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { verificationId } = await context.params;
  if (!verificationId || !adminDb) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Not found." },
      { status: 404 }
    );
  }

  const collectionParam = (req.nextUrl.searchParams.get("collection") ?? "verifications").trim();
  const collection =
    collectionParam === "videoVerifications" ? "videoVerifications" : "verifications";

  if (collectionParam !== "verifications" && collectionParam !== "videoVerifications") {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "validation_error",
        message: 'collection must be "verifications" or "videoVerifications".',
      },
      { status: 400 }
    );
  }

  const snap = await adminDb.collection(collection).doc(verificationId).get();
  if (!snap.exists) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "not_found",
        message: collection === "videoVerifications" ? "Video verification not found." : "Claim not found.",
      },
      { status: 404 }
    );
  }

  const raw = snap.data() as Record<string, unknown>;
  const owner =
    (typeof raw.userId === "string" && raw.userId.trim()) ||
    (typeof raw.uid === "string" && raw.uid.trim()) ||
    "";
  if (owner !== uid) {
    return NextResponse.json(
      { ok: false, errorCode: "forbidden", message: "Access denied." },
      { status: 403 }
    );
  }

  try {
    if (collection === "videoVerifications") {
      if (raw.type != null && raw.type !== "video_verification") {
        return NextResponse.json(
          { ok: false, errorCode: "not_found", message: "Video verification not found." },
          { status: 404 }
        );
      }
      const payload = mapStoredVideoVerificationToClientPayload(verificationId, raw);
      return NextResponse.json({ ok: true, payload });
    }

    const data = raw as ClaimVerificationFirestoreDoc;
    const payload = mapStoredVerificationToClientPayload(data, verificationId);
    return NextResponse.json({ ok: true, payload });
  } catch (e: unknown) {
    logger.error("[user/verifications/id] map failed", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Could not load verification." },
      { status: 500 }
    );
  }
}
