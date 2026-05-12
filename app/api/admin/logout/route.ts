/**
 * HTTP API route (admin/logout): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { clearAdminSession } from "@/lib/adminAuth";

export async function POST(request: NextRequest) {
  try {
    await clearAdminSession(request);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error in admin logout:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

