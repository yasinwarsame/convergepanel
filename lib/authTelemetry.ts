/**
 * Auth Lifecycle Hardening, Step 6.12 — server-side session-endpoint
 * observability. Thin wrapper around the EXISTING `logger`
 * (`@/lib/logger`), never a second logging system — mirrors the pattern
 * `lib/governance/adaptiveGovernanceTelemetry.ts` established for the
 * multi-reviewer governance feature. Used only by
 * `app/api/auth/session/route.ts`, which is the sole place a token/cookie
 * is ever decoded server-side for a session-lifecycle operation.
 *
 * Exhaustive allowlist — no field for a token, cookie value, uid, email, or
 * claim exists anywhere on this type, so there is nothing to accidentally
 * log. `operationGeneration` is a caller-supplied, non-sensitive integer
 * (see `lib/client/authGeneration.ts`) used only to correlate a client-side
 * operation with its server-side outcome in logs — never an identity value.
 */

import "server-only";
import { logger } from "@/lib/logger";

export type AuthSessionOperation =
  | "session_sync_succeeded"
  | "session_sync_failed"
  | "session_cleared"
  | "revoked_or_expired_session";

export type AuthSessionTelemetryMetadata = {
  route?: string;
  failureCategory?: string;
  operationGeneration?: number;
};

export function logAuthSessionEvent(operation: AuthSessionOperation, metadata: AuthSessionTelemetryMetadata = {}): void {
  logger.info(`[auth-session] ${operation}`, { operation, ...metadata });
}
