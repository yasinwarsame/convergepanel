/**
 * Auth Lifecycle Hardening, Step 6.12 — client-side session-synchronization
 * observability.
 *
 * `lib/logger` is `"server-only"` and cannot be imported from
 * `AuthProvider.tsx`/`sessionSync.ts` (both run in the browser). This module
 * is the client-side equivalent, using `console.info`/`console.warn` — the
 * same mechanism `AuthProvider.tsx` already used for auth diagnostics before
 * this step (`console.warn("[AuthProvider] Auth check timeout...")`, etc.) —
 * rather than introducing a new third-party analytics dependency for
 * security-relevant signals.
 *
 * Exhaustive allowlist, structurally impossible to pass a forbidden field:
 * no token, cookie value, uid, email, or claim exists anywhere on this type.
 */

export type AuthSessionClientOperation =
  | "session_sync_started"
  | "session_sync_succeeded"
  | "session_sync_failed"
  | "session_identity_mismatch"
  | "session_cleared"
  | "logout_clear_failed"
  | "stale_auth_operation_discarded"
  | "token_refresh_deferred"
  /** R-S0-4: a same-uid token callback arrived while this tab's own sync refresh was pending and was coalesced into it. */
  | "own_refresh_echo_coalesced"
  /** R-S0-6: a same-uid, same-User-object callback during this tab's in-flight sync was coalesced into it (one follow-up queued). */
  | "sync_episode_callback_coalesced"
  /** R-S0-6: the one queued follow-up of a successful sync started (an ordinary non-forced same-uid refresh). */
  | "sync_episode_follow_up"
  /** R-S0-6: a sync exceeded its client deadline and failed closed. */
  | "sync_episode_deadline_exceeded"
  /** R-S0-6: a callback for a User object whose sync already failed closed was dropped (no automatic restart). */
  | "failed_episode_callback_dropped";

export type AuthSessionClientTelemetryMetadata = {
  route?: string;
  failureCategory?: string;
  operationGeneration?: number;
};

export function logAuthSessionClientEvent(
  operation: AuthSessionClientOperation,
  metadata: AuthSessionClientTelemetryMetadata = {}
): void {
  const payload = { operation, ...metadata };
  const isFailure =
    operation === "session_sync_failed" ||
    operation === "session_identity_mismatch" ||
    operation === "logout_clear_failed" ||
    operation === "token_refresh_deferred" ||
    operation === "sync_episode_deadline_exceeded";
  try {
    if (isFailure) {
      console.warn(`[auth-session] ${operation}`, payload);
    } else if (process.env.NODE_ENV !== "production") {
      console.info(`[auth-session] ${operation}`, payload);
    }
  } catch {
    // A logging failure must never change auth outcomes.
  }
}
