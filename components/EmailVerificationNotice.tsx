"use client";

/**
 * Phase P0.2-VEMAIL-C1/C2 — the user-visible half of verification recovery.
 *
 * A failed verification send used to be invisible: no message, no retry. Since
 * a verified email is a prerequisite for email-allowlisted administrator
 * authority, that left no working path to becoming verified at all.
 *
 * C2 corrections, all from the independent review:
 *
 *  - THE REASON TO RENDER IS THE LIVE IDENTITY, NOT STORAGE. Stored state only
 *    selects WHICH message to show. If storage is cleared, disabled, or the tab
 *    closed, an unverified user still gets the neutral notice and a working
 *    resend. Browser storage is never verification authority.
 *  - Stored state is UID-SCOPED, so one account's failure is never shown to
 *    another in the same browser.
 *  - EVERY network await inside the pending window is BOUNDED, and no
 *    diagnostic outcome gates the control. A stalled telemetry call used to
 *    leave this button at "Sending…" forever with `inFlight` stuck true, and a
 *    later unbounded reload() added a second way to do it. The verification
 *    refresh, the Firebase send and the telemetry report are bounded
 *    SEPARATELY, so the worst case for this control is their SUM
 *    (`MAX_RESEND_PENDING_MS`), not one timeout. An audit caught that the send
 *    itself had been left unbounded while the constant was still called a
 *    maximum. None of these bounds Firebase's actual mail delivery.
 *  - The cooldown applies after EVERY completed attempt. A failure is often
 *    `auth/too-many-requests`, and inviting an immediate retry was misleading.
 *  - `user.reload()` refreshes cached verification, so someone who verified in
 *    another tab is not told they are unverified and offered a redundant send.
 *
 * WORDING RULE, unchanged: nothing here claims an email was delivered or
 * received. `send_accepted` means Firebase accepted the request, no more.
 *
 * It renders nothing for a verified user and never sends automatically — no
 * effect triggers a send, so a re-render cannot mail anyone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  refreshVerificationStatus,
  reportEmailVerificationSendOutcome,
  requestEmailVerification,
} from "@/lib/client/emailVerificationSend";
import {
  clearEmailVerificationSendState,
  readEmailVerificationSendState,
  writeEmailVerificationSendState,
} from "@/lib/client/emailVerificationState";

export const COOLDOWN_MS = 60_000;

type Status = "idle" | "sending" | "accepted" | "failed" | "check_failed" | "send_unknown";

export default function EmailVerificationNotice() {
  const { user } = useAuth();
  const uid = user?.uid ?? "";
  const [status, setStatus] = useState<Status>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const [storedState, setStoredState] = useState<"send_failed" | "send_accepted" | null>(null);
  // Set once a reload has confirmed the cached flag, so a stale unverified
  // client does not keep offering a send to an already-verified identity.
  const [verifiedByReload, setVerifiedByReload] = useState(false);

  useEffect(() => {
    setStoredState(uid ? readEmailVerificationSendState(uid) : null);
  }, [uid]);

  // Refresh the cached verification flag, BOUNDED. A failed or timed-out check
  // deliberately asserts nothing: we leave the notice up, which is the
  // recoverable direction.
  useEffect(() => {
    let cancelled = false;
    if (!user || user.emailVerified) return;
    (async () => {
      const result = await refreshVerificationStatus(user);
      if (!cancelled && result === "verified") {
        setVerifiedByReload(true);
        clearEmailVerificationSendState(user.uid);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Ticks only while a cooldown is actually running, and stops at expiry rather
  // than re-rendering the page at 1 Hz forever.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => {
      if (Date.now() >= cooldownUntil) {
        setNow(Date.now());
        clearInterval(t);
        return;
      }
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const onResend = useCallback(async () => {
    if (inFlight.current || !user) return;
    if (Date.now() < cooldownUntil) return;
    inFlight.current = true;
    setStatus("sending");
    setErrorCode(null);
    try {
      // Fresh-enough verification check, BOUNDED. Previously an unbounded
      // reload() sat here inside the in-flight window, so a stalled network
      // call could hold this control pending indefinitely — a `finally` cannot
      // release a lock whose `await` never settles.
      const refresh = await refreshVerificationStatus(user);

      if (refresh === "verified") {
        setVerifiedByReload(true);
        clearEmailVerificationSendState(user.uid);
        setStatus("idle");
        return;
      }

      if (refresh === "check_timed_out") {
        // We could not confirm whether this identity is already verified, so we
        // do NOT mail them — they may have verified elsewhere. This is a CHECK
        // failure, not a send failure: no send was attempted, so no
        // verification_email_send_* diagnostic may be emitted for it.
        setStatus("check_failed");
        setCooldownUntil(Date.now() + COOLDOWN_MS);
        setNow(Date.now());
        return;
      }

      // "check_failed" (a fast error) preserves the previous safe behaviour:
      // proceed on the cached value rather than blocking recovery.
      const outcome = await requestEmailVerification(user);

      // Bounded and best-effort: its result never decides what the user sees.
      await reportEmailVerificationSendOutcome(user, outcome, "resend");

      if (outcome.outcome === "send_accepted") {
        setStatus("accepted");
        setStoredState("send_accepted");
        writeEmailVerificationSendState(user.uid, "send_accepted");
      } else if (outcome.outcome === "send_failed") {
        setStatus("failed");
        setErrorCode(outcome.errorCode);
        setStoredState("send_failed");
        writeEmailVerificationSendState(user.uid, "send_failed");
      } else if (outcome.outcome === "send_timed_out") {
        // We stopped waiting before Firebase answered. It may have accepted the
        // request. Saying "we couldn't send it" would be a false claim, so the
        // copy states the actual epistemic position. No stored state is written:
        // neither "failed" nor "accepted" is known to be true.
        setStatus("send_unknown");
      } else {
        setStatus("idle");
      }
      // Cooldown after ANY completed attempt — a failure is frequently
      // Firebase throttling, and an immediately clickable retry is misleading.
      if (outcome.outcome !== "already_verified") {
        setCooldownUntil(Date.now() + COOLDOWN_MS);
        setNow(Date.now());
      }
    } finally {
      // Released on every path. Combined with the bounds above, no
      // asynchronous branch can leave this control pending indefinitely.
      inFlight.current = false;
    }
  }, [user, cooldownUntil]);

  if (!user || user.emailVerified || verifiedByReload) return null;

  const cooling = now < cooldownUntil;
  const secondsLeft = cooling ? Math.ceil((cooldownUntil - now) / 1000) : 0;

  let message: string;
  if (status === "check_failed") {
    message = "We couldn't check your verification status. Please try again.";
  } else if (status === "send_unknown") {
    message =
      "We couldn't confirm that the verification email was sent. Please wait a moment, check your inbox, and try again if it doesn't arrive.";
  } else if (status === "accepted" || (status === "idle" && storedState === "send_accepted")) {
    message = "Verification email requested. Check your inbox, and your spam folder.";
  } else if (status === "failed" || storedState === "send_failed") {
    message = cooling
      ? "We couldn't send the verification email. You can try again shortly."
      : "We couldn't send the verification email. You can try again.";
  } else {
    message = "Your email address is not verified yet.";
  }

  return (
    <div
      role="status"
      className="rounded-lg border border-cp-border bg-cp-raised px-4 py-3 text-sm text-cp-text"
    >
      <p className="text-cp-muted">{message}</p>
      {status === "failed" && errorCode ? (
        <p className="mt-1 text-xs text-cp-faint">Reference: {errorCode}</p>
      ) : null}
      <button
        type="button"
        onClick={onResend}
        disabled={status === "sending" || cooling}
        className="mt-2 rounded-md border border-cp-border bg-cp-surface px-3 py-1.5 text-sm font-medium text-cp-text disabled:opacity-50"
      >
        {status === "sending"
          ? "Sending…"
          : cooling
            ? `Resend available in ${secondsLeft}s`
            : "Resend verification email"}
      </button>
    </div>
  );
}
