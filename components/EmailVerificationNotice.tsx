"use client";

/**
 * Phase P0.2-VEMAIL-C1 — the user-visible half of the verification recovery.
 *
 * Before this, a failed verification send was invisible: the user was told
 * nothing, saw nothing, and had no way to try again. Since a verified email is
 * now a prerequisite for email-allowlisted administrator authority, that left
 * no working path to becoming verified at all.
 *
 * WORDING RULE. This component never claims an email was delivered or
 * received. `send_accepted` means Firebase accepted the request; the copy says
 * "check your email", not "we sent it and it arrived".
 *
 * It renders nothing for a verified user, and never sends automatically — no
 * effect triggers a send, so a re-render cannot mail anyone.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  reportEmailVerificationSendOutcome,
  requestEmailVerification,
} from "@/lib/client/emailVerificationSend";

const COOLDOWN_MS = 60_000;

type Status = "idle" | "sending" | "accepted" | "failed";

export default function EmailVerificationNotice() {
  const { user } = useAuth();
  const [status, setStatus] = useState<Status>("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const [initialSendFailed, setInitialSendFailed] = useState(false);

  useEffect(() => {
    try {
      setInitialSendFailed(sessionStorage.getItem("cp_verification_send_failed") === "1");
    } catch {
      /* storage unavailable — fall back to the neutral "not verified yet" copy */
    }
  }, []);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const onResend = useCallback(async () => {
    // Guarded against double-submit: a second click while a request is in
    // flight must not produce a second email.
    if (inFlight.current || !user || user.emailVerified) return;
    if (Date.now() < cooldownUntil) return;
    inFlight.current = true;
    setStatus("sending");
    setErrorCode(null);
    const outcome = await requestEmailVerification(user);
    await reportEmailVerificationSendOutcome(user, outcome, "resend");
    if (outcome.outcome === "send_accepted") {
      setStatus("accepted");
      setInitialSendFailed(false);
      try {
        sessionStorage.removeItem("cp_verification_send_failed");
      } catch {
        /* ignore */
      }
      setCooldownUntil(Date.now() + COOLDOWN_MS);
    } else if (outcome.outcome === "send_failed") {
      setStatus("failed");
      setErrorCode(outcome.errorCode);
    } else {
      setStatus("idle");
    }
    inFlight.current = false;
  }, [user, cooldownUntil]);

  // Nothing to say to a verified identity, and no control to offer it.
  if (!user || user.emailVerified) return null;

  const cooling = now < cooldownUntil;
  const secondsLeft = cooling ? Math.ceil((cooldownUntil - now) / 1000) : 0;

  let message: string;
  if (status === "accepted") {
    message = "Verification email requested. Check your inbox, and your spam folder.";
  } else if (status === "failed" || initialSendFailed) {
    message = "We couldn't send the verification email. You can try again.";
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
