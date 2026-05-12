/**
 * HTTP API route (admin/login): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { validatePassword, setAdminSession } from "@/lib/adminAuth";
import { checkRateLimit } from "@/lib/security/rateLimit";

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const rl = await checkRateLimit({
      maxRequests: 5,
      windowSeconds: 300,
      identifier: `admin-login:${ip}`,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== "string") {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 }
      );
    }

    if (validatePassword(password)) {
      await setAdminSession();
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json(
        { error: "Invalid password" },
        { status: 401 }
      );
    }
  } catch (error: any) {
    console.error("Error in admin login:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

