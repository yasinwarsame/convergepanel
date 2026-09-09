/**
 * Repository-Wide Auth Identity Consistency Remediation, Step 7.10 —
 * server-side observability for `resolveRequestIdentity()`. Thin wrapper
 * around the EXISTING `logger` (`@/lib/logger`), matching the precedent
 * `lib/authTelemetry.ts` (Step 6) and `lib/governance/adaptiveGovernanceTelemetry.ts`
 * established — never a second logging system.
 *
 * Exhaustive allowlist — no field for a uid, email, token, cookie value,
 * or claim exists anywhere on this type, so there is nothing to
 * accidentally log.
 */

import "server-only";
import { logger } from "@/lib/logger";
import type { RequestIdentityUnauthenticatedReason } from "./resolveRequestIdentity";

export type IdentityResolutionFailureCategory =
  | RequestIdentityUnauthenticatedReason
  | "unsupported_auth_mode"
  // Phase FIRST-ADMIN-C6: the credential verified, but the live Firebase Auth
  // record is disabled. Distinct from every "could not authenticate" reason —
  // this is a REVOKED identity, and operators need to tell the two apart when
  // responding to a compromised administrator.
  | "account_disabled";

export type IdentityResolutionTelemetryMetadata = {
  route?: string;
  method?: string;
  failureCategory?: IdentityResolutionFailureCategory;
};

export function logIdentityResolutionFailure(metadata: IdentityResolutionTelemetryMetadata): void {
  logger.warn(`[auth-identity] resolution_failed`, { operation: "identity_resolution_failed", ...metadata });
}
