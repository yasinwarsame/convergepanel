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
  | "stale_auth_operation_discarded";

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
    operation === "logout_clear_failed";
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
