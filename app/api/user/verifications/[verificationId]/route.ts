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

  const snap = await adminDb.collection("verifications").doc(verificationId).get();
  if (!snap.exists) {
    return NextResponse.json(
      { ok: false, errorCode: "not_found", message: "Claim not found." },
      { status: 404 }
    );
  }

  const data = snap.data() as ClaimVerificationFirestoreDoc;
  if (data.userId !== uid) {
    return NextResponse.json(
      { ok: false, errorCode: "forbidden", message: "Access denied." },
      { status: 403 }
    );
  }

  try {
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
