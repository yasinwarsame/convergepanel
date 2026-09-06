/**
 * Phase P0.2-VEMAIL-C1 — operator-visible outcome of the CLIENT SDK send call.
 *
 * A thin wrapper over the EXISTING `logger`, matching the precedent set by
 * `lib/auth/identityResolutionTelemetry.ts` — never a second logging system,
 * and deliberately independent of PostHog, which is unconfigured in Production
 * and therefore cannot be the diagnostic channel for a security-relevant flow.
 *
 * WORDING IS DELIBERATE. These messages say the client's send call RESOLVED or
 * FAILED. They must never be read, or reworded, to mean an email was delivered
 * or received — Firebase can accept a request that never reaches a mailbox,
 * which is precisely the ambiguity this telemetry exists to expose.
 *
 * Exhaustive allowlist: the metadata type has no field for an email address,
 * uid, token, cookie, action link or action code, so there is nothing here to
 * leak by accident. The uid is logged separately by the route only because it
 * is derived server-side from the verified identity.
 */

import "server-only";
import { logger } from "@/lib/logger";

export const EMAIL_VERIFICATION_SEND_EVENTS = [
  "verification_email_send_accepted",
  "verification_email_send_failed",
] as const;
export type EmailVerificationSendEvent = (typeof EMAIL_VERIFICATION_SEND_EVENTS)[number];

export const EMAIL_VERIFICATION_SEND_SOURCES = ["signup", "resend"] as const;
export type EmailVerificationSendSource = (typeof EMAIL_VERIFICATION_SEND_SOURCES)[number];

export type EmailVerificationSendTelemetry = {
  event: EmailVerificationSendEvent;
  source: EmailVerificationSendSource;
  /** Bounded Firebase code such as `auth/too-many-requests`. Never a message. */
  errorCode?: string | null;
  /** Derived server-side from the verified identity — never client-supplied. */
  uid: string;
};

export function logEmailVerificationSendOutcome(t: EmailVerificationSendTelemetry): void {
  const base = { operation: t.event, source: t.source, uid: t.uid };
  if (t.event === "verification_email_send_failed") {
    logger.warn(
      "[email-verification] client SDK send call FAILED (no message was requested; this is not a delivery result)",
      { ...base, errorCode: t.errorCode ?? "unknown" }
    );
    return;
  }
  logger.info(
    "[email-verification] client SDK send call RESOLVED (request accepted by Firebase; NOT proof of delivery)",
    base
  );
}
