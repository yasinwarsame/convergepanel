/**
 * Phase P0.2-VEMAIL-C1 — authenticated, fixed-schema diagnostic sink for the
 * verification-email send outcome. NOT a general-purpose logging API.
 *
 * It exists because the outcome of the client's `sendEmailVerification()` call
 * was previously reported only to PostHog, which is unconfigured in Production,
 * leaving a security-relevant flow with no operator signal at all.
 *
 * SECURITY SHAPE.
 *  - Requires a verified Firebase identity via the shared resolver.
 *  - The uid is DERIVED server-side. A client-supplied uid is not read, so one
 *    user cannot attribute an event to another.
 *  - `event` and `source` are validated against closed enums; anything else is
 *    rejected. There is no free-text message field, so this cannot be used to
 *    write arbitrary content into the logs.
 *  - `errorCode` must match the bounded Firebase code shape or it is dropped.
 *  - Grants no authority, writes no user data, and cannot change verification
 *    state — it only logs.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import {
  EMAIL_VERIFICATION_SEND_EVENTS,
  EMAIL_VERIFICATION_SEND_SOURCES,
  logEmailVerificationSendOutcome,
  type EmailVerificationSendEvent,
  type EmailVerificationSendSource,
} from "@/lib/verification/emailVerificationTelemetry";

export const runtime = "nodejs";

/** Same bounded shape the client helper enforces; anything else becomes null. */
function safeErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^auth\/[a-z0-9-]{1,48}$/.test(value) ? value : null;
}

export async function POST(req: NextRequest) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({
      route: "user/email-verification-telemetry",
      method: "POST",
      failureCategory: identity.reason,
    });
    return NextResponse.json(
      { ok: false, errorCode: "unauthorized", message: "Please sign in." },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, errorCode: "invalid_body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ ok: false, errorCode: "invalid_body" }, { status: 400 });
  }

  const { event, source, errorCode } = body as Record<string, unknown>;
  if (!EMAIL_VERIFICATION_SEND_EVENTS.includes(event as EmailVerificationSendEvent)) {
    return NextResponse.json({ ok: false, errorCode: "invalid_event" }, { status: 400 });
  }
  if (!EMAIL_VERIFICATION_SEND_SOURCES.includes(source as EmailVerificationSendSource)) {
    return NextResponse.json({ ok: false, errorCode: "invalid_source" }, { status: 400 });
  }

  logEmailVerificationSendOutcome({
    event: event as EmailVerificationSendEvent,
    source: source as EmailVerificationSendSource,
    errorCode: safeErrorCode(errorCode),
    // Server-derived. Any `uid` in the payload is ignored entirely.
    uid: identity.uid,
  });

  return NextResponse.json({ ok: true });
}
