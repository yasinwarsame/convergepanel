import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_NAME = "admin_session";
const COOKIE_VALUE = "authenticated";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function isAdminAuthenticated(request: NextRequest): boolean {
  const cookie = request.cookies.get(COOKIE_NAME);
  return cookie?.value === COOKIE_VALUE;
}

export async function setAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, COOKIE_VALUE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

export async function clearAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export function validatePassword(password: string): boolean {
  if (!ADMIN_PASSWORD) {
    console.warn("ADMIN_PASSWORD not set in environment variables");
    return false;
  }
  return password === ADMIN_PASSWORD;
}

export function requireAdmin(
  request: NextRequest
): { authenticated: boolean; response?: NextResponse } {
  if (!isAdminAuthenticated(request)) {
    return {
      authenticated: false,
      response: NextResponse.redirect(new URL("/admin/login", request.url)),
    };
  }
  return { authenticated: true };
}

