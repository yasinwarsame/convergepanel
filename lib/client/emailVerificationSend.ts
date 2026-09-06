"use client";

/**
 * Phase P0.2-VEMAIL-C1 — THE ONE PLACE THE VERIFICATION EMAIL IS REQUESTED.
 *
 * WHY THIS EXISTS. A real Production signup created the account, wrote the
 * profile, provisioned the workspace and completed onboarding — and no
 * verification email arrived. The application could not say why, because the
 * only send site swallowed its error and reported the outcome solely to
 * PostHog, which is not configured in Production and never initializes. The
 * failure was invisible to the user, to operators, and to logs simultaneously.
 *
 * Since P0.2 makes a verified email a prerequisite for email-allowlisted
 * administrator authority, a silent failure of the only path to becoming
 * verified is not a cosmetic problem: it breaks the legitimate route to
 * becoming an admin.
 *
 * WHAT THE OUTCOMES MEAN — THE DISTINCTION IS LOAD-BEARING.
 *
 *   `send_accepted`  The Firebase client SDK's send call RESOLVED. That is
 *                    all it means. It is NOT proof that a message was
 *                    delivered, received, or read. Firebase can accept the
 *                    request and the mail never arrive.
 *   `send_failed`    The SDK call REJECTED. No message was requested.
 *   `already_verified` The identity is already verified; nothing was sent.
 *
 * Mailbox DELIVERY is proven only by a human receiving the message. Mailbox
 * OWNERSHIP is proven only when that human clicks the genuine link and
 * Firebase subsequently reports `emailVerified === true`. No value returned
 * here may be described as either.
 */

import { sendEmailVerification, type User } from "firebase/auth";

export type EmailVerificationSendOutcome =
  | { outcome: "already_verified" }
  | { outcome: "send_accepted" }
  | { outcome: "send_failed"; errorCode: string | null };

/**
 * Firebase error codes look like `auth/too-many-requests`. Only that shape is
 * carried forward, bounded in length — never the error object, its message, or
 * any `customData`, which can carry the email address, tokens or the action
 * link. A code we do not recognise as safe becomes `null` rather than being
 * passed through and hoped for.
 */
export function safeFirebaseErrorCode(error: unknown): string | null {
  const raw =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof raw !== "string") return null;
  return /^auth\/[a-z0-9-]{1,48}$/.test(raw) ? raw : null;
}

/**
 * Requests a verification email for an unverified user. NEVER THROWS: the
 * caller is always mid-signup or mid-resend, and an account that already
 * exists must not be torn down because a mail request failed.
 */
export async function requestEmailVerification(
  user: Pick<User, "emailVerified"> & { emailVerified: boolean }
): Promise<EmailVerificationSendOutcome> {
  if (user.emailVerified) return { outcome: "already_verified" };
  try {
    await sendEmailVerification(user as User);
    return { outcome: "send_accepted" };
  } catch (error) {
    return { outcome: "send_failed", errorCode: safeFirebaseErrorCode(error) };
  }
}

/**
 * How long we are willing to wait for the operator diagnostic. The review found
 * the resend control could hang at "Sending…" forever because this call was
 * awaited with no timeout: the helper swallows *errors*, but a stalled request
 * is not an error. Telemetry is a diagnostic and must never become a UI
 * availability dependency, so it is bounded and the request is genuinely
 * ABORTED on timeout rather than left running behind a race.
 */
export const TELEMETRY_TIMEOUT_MS = 3000;

export type TelemetryReportOutcome = "reported" | "skipped" | "failed" | "timed_out";

/**
 * Reports the outcome to the server so an operator can see it without PostHog.
 *
 * BEST-EFFORT AND BOUNDED. It never throws and never waits longer than
 * {@link TELEMETRY_TIMEOUT_MS}: the signup or resend it describes has already
 * happened, and must not be reported as broken — nor left pending — because a
 * diagnostic was slow. The returned value exists so tests can assert the
 * bounding actually happened; callers may ignore it.
 */
export async function reportEmailVerificationSendOutcome(
  user: User | null,
  outcome: EmailVerificationSendOutcome,
  source: "signup" | "resend"
): Promise<TelemetryReportOutcome> {
  if (!user) return "skipped";
  if (outcome.outcome === "already_verified") return "skipped";

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TELEMETRY_TIMEOUT_MS);

  try {
    const { authedFetch } = await import("@/lib/client/authedFetch");
    await authedFetch("/api/user/email-verification-telemetry", {
      user,
      authReady: true,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        event:
          outcome.outcome === "send_accepted"
            ? "verification_email_send_accepted"
            : "verification_email_send_failed",
        source,
        errorCode: outcome.outcome === "send_failed" ? outcome.errorCode : null,
      }),
    });
    return "reported";
  } catch {
    // Abort, network failure, auth failure — all identical from here: the
    // diagnostic did not land, and nothing user-facing depends on it.
    return timedOut ? "timed_out" : "failed";
  } finally {
    clearTimeout(timer);
  }
}
