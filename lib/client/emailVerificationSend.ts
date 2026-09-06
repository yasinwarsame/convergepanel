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

import { reload, sendEmailVerification, type User } from "firebase/auth";

export type EmailVerificationSendOutcome =
  | { outcome: "already_verified" }
  | { outcome: "send_accepted" }
  | { outcome: "send_failed"; errorCode: string | null }
  /**
   * The application stopped waiting before Firebase gave a definitive answer.
   *
   * This is deliberately NOT `send_failed`. A timeout is not proof of
   * rejection: Firebase may already have accepted the request, or may accept it
   * after we stopped waiting. Reporting it as a failure — to the user or to
   * operators — would assert something we do not know, which is the exact class
   * of false claim this workstream exists to remove.
   */
  | { outcome: "send_timed_out" };

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
  user: Pick<User, "emailVerified"> & { emailVerified: boolean },
  timeoutMs: number = SEND_TIMEOUT_MS
): Promise<EmailVerificationSendOutcome> {
  if (user.emailVerified) return { outcome: "already_verified" };

  // The Firebase SDK exposes no cancellation for this call, so the deadline
  // makes the APPLICATION stop waiting; the underlying request may still
  // complete in the background. The `settled` latch makes that background
  // completion inert: it cannot produce a second outcome, and the caller's
  // answer is final once returned.
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<EmailVerificationSendOutcome>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ outcome: "send_timed_out" });
    }, timeoutMs);
  });

  const work = sendEmailVerification(user as User).then(
    (): EmailVerificationSendOutcome => ({ outcome: "send_accepted" }),
    (error): EmailVerificationSendOutcome => ({
      outcome: "send_failed",
      errorCode: safeFirebaseErrorCode(error),
    })
  );
  // The orphaned promise must never surface as an unhandled rejection if it
  // settles after we have stopped waiting.
  work.catch(() => {});

  try {
    const result = await Promise.race([work, deadline]);
    settled = true;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * BOUNDS — stated precisely, because the previous version's comments were not.
 *
 * The earlier implementation attached an AbortSignal to the fetch and claimed
 * the call "never waits longer than" the timeout. That was false: the dynamic
 * `import()` and `user.getIdToken(true)` both run BEFORE the fetch, and an
 * AbortSignal cannot cancel either. If one stalled, `abort()` fired into
 * nothing and the promise never settled — leaving the resend button at
 * "Sending…" for as long as Firebase's own ~30-60s API timeout and webpack's
 * 120s chunk timeout allowed, against a documented 3s.
 *
 * Each of these bounds ONE operation. They do not compose into a single
 * total: a resend performs a bounded refresh and then a bounded report, so the
 * worst case for the control is their SUM. See `MAX_RESEND_PENDING_MS`.
 *
 * Neither bounds Firebase's actual mail delivery, which is not ours to bound.
 */
export const TELEMETRY_TIMEOUT_MS = 3000;
export const VERIFICATION_REFRESH_TIMEOUT_MS = 3000;
/**
 * The Firebase client send is a network call with no SDK-level cancellation and
 * no application bound until now. An audit caught that `MAX_RESEND_PENDING_MS`
 * summed only the refresh and the report, so the advertised maximum excluded
 * the very operation most likely to be slow — the same shape of unverified
 * claim this workstream keeps having to remove.
 */
export const SEND_TIMEOUT_MS = 5000;

/**
 * TRUE worst case for the resend control: refresh, THEN send, THEN report —
 * three sequential bounded awaits. Every await in the pending path is counted
 * here; if one were unbounded this constant would be a lie and must not be
 * called a maximum.
 *
 * It bounds how long the UI waits. It does NOT bound Firebase's mail delivery,
 * which is not ours to bound.
 */
export const MAX_RESEND_PENDING_MS =
  VERIFICATION_REFRESH_TIMEOUT_MS + SEND_TIMEOUT_MS + TELEMETRY_TIMEOUT_MS;

export type TelemetryReportOutcome = "reported" | "skipped" | "failed" | "timed_out";

/**
 * The diagnostic payload, derived from the ACTUAL Firebase outcome.
 *
 * Extracted so the mapping exists in exactly one place. The review found a
 * mutation that hard-coded `verification_email_send_accepted` here and passed
 * the entire suite, because no test inspected the outgoing body — which would
 * have reported a FAILED send to operators as resolved, the precise
 * silent-failure class this work exists to remove. Tests now parse the body
 * actually handed to the request layer.
 */
export function buildEmailVerificationTelemetryBody(
  outcome: EmailVerificationSendOutcome,
  source: "signup" | "resend"
): { event: string; source: string; errorCode: string | null } {
  return {
    event:
      outcome.outcome === "send_accepted"
        ? "verification_email_send_accepted"
        : outcome.outcome === "send_timed_out"
          ? "verification_email_send_timed_out"
          : "verification_email_send_failed",
    source,
    errorCode: outcome.outcome === "send_failed" ? outcome.errorCode : null,
  };
}

/**
 * Reports the outcome to the server so an operator can see it without PostHog.
 *
 * BEST-EFFORT AND BOUNDED END TO END. The deadline covers module preparation,
 * token acquisition, request construction and the network call — not merely the
 * fetch. The AbortController is retained so a request that has already started
 * is genuinely cancelled rather than abandoned, and a `settled` latch ensures
 * work completing after the deadline can neither emit a late diagnostic nor
 * change the value already returned.
 */
export async function reportEmailVerificationSendOutcome(
  user: User | null,
  outcome: EmailVerificationSendOutcome,
  source: "signup" | "resend"
): Promise<TelemetryReportOutcome> {
  if (!user) return "skipped";
  if (outcome.outcome === "already_verified") return "skipped";

  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<TelemetryReportOutcome>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Cancels an in-flight fetch, AND poisons the signal so work that was
      // still stalled in import/token acquisition cannot start a late request.
      controller.abort();
      resolve("timed_out");
    }, TELEMETRY_TIMEOUT_MS);
  });

  const work = (async (): Promise<TelemetryReportOutcome> => {
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      // The import itself may have outlived the deadline.
      if (controller.signal.aborted) return "timed_out";
      await authedFetch("/api/user/email-verification-telemetry", {
        user,
        authReady: true,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(buildEmailVerificationTelemetryBody(outcome, source)),
      });
      return "reported";
    } catch {
      return controller.signal.aborted ? "timed_out" : "failed";
    }
  })();

  try {
    const result = await Promise.race([work, deadline]);
    settled = true;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A BOUNDED refresh of the cached verification flag.
 *
 * `user.reload()` is a network call. The review found it had been added inside
 * the resend's in-flight window with no bound, so a stalled reload could hold
 * the control pending indefinitely — a `finally` cannot release a lock whose
 * `await` never settles.
 *
 * The outcomes are deliberately distinct from send outcomes: a refresh that
 * fails or times out is NOT a verification-email send failure, and must never
 * be reported to operators as one, because no send was attempted.
 */
export type VerificationRefreshOutcome =
  | "verified"
  | "still_unverified"
  | "check_failed"
  | "check_timed_out";

export async function refreshVerificationStatus(
  user: (User & { emailVerified: boolean }) | null,
  timeoutMs: number = VERIFICATION_REFRESH_TIMEOUT_MS
): Promise<VerificationRefreshOutcome> {
  if (!user) return "check_failed";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<VerificationRefreshOutcome>((resolve) => {
    timer = setTimeout(() => resolve("check_timed_out"), timeoutMs);
  });
  const work = (async (): Promise<VerificationRefreshOutcome> => {
    try {
      await reload(user);
      return user.emailVerified ? "verified" : "still_unverified";
    } catch {
      return "check_failed";
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
