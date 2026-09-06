"use client";

/**
 * Phase P0.2-VEMAIL-C2 — THE ONE CONTRACT BETWEEN THE SIGNUP WRITER AND THE
 * NOTICE READER.
 *
 * The previous shape had two problems the review caught.
 *
 * 1. A GLOBAL KEY. `cp_verification_send_failed` was not scoped to an identity,
 *    so account A's "we couldn't send your verification email" could be shown
 *    to account B after a sign-out/sign-in in the same tab. Nothing leaked
 *    about A, but B was told something false about B.
 *
 * 2. A DUPLICATED LITERAL. The key was written out four times across two files
 *    with no shared constant, and nothing tested that the writer and the reader
 *    agreed. A typo in either would have silently broken the whole carry, which
 *    is the feature's only integration point.
 *
 * WHAT THIS IS NOT. Stored state is a HINT that selects which message to show.
 * It is never authority: the reason to show the notice at all is that the live
 * Firebase identity is unverified, so recovery still works when storage is
 * cleared, disabled, or the tab has closed. Nothing here is ever read as proof
 * of verification.
 *
 * Contents are deliberately non-sensitive: one discriminant. No address, no
 * token, no action code, no link.
 */

export type EmailVerificationSendState = "send_failed" | "send_accepted";

/** UID-scoped, mirroring the existing `cp_plan_${uid}` convention in the repo. */
export function emailVerificationStateKey(uid: string): string {
  return `cp_verification_send_state_${uid}`;
}

/** Never throws: private browsing and disabled site data must not break signup. */
export function writeEmailVerificationSendState(uid: string, state: EmailVerificationSendState): void {
  if (!uid) return;
  try {
    sessionStorage.setItem(emailVerificationStateKey(uid), state);
  } catch {
    /* storage unavailable — the notice still renders from the live identity */
  }
}

/** `null` means "nothing recorded", which renders the neutral message. */
export function readEmailVerificationSendState(uid: string): EmailVerificationSendState | null {
  if (!uid) return null;
  try {
    const raw = sessionStorage.getItem(emailVerificationStateKey(uid));
    return raw === "send_failed" || raw === "send_accepted" ? raw : null;
  } catch {
    return null;
  }
}

export function clearEmailVerificationSendState(uid: string): void {
  if (!uid) return;
  try {
    sessionStorage.removeItem(emailVerificationStateKey(uid));
  } catch {
    /* ignore */
  }
}
