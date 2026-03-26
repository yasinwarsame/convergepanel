/**
 * Returns 200 if the caller may use admin portal APIs (Firebase admin claim or support email allowlist).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiAccess } from "@/lib/firebase/auth-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdminApiAccess(request);
  if (!auth) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
