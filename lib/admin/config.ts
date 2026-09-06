/**
 * Admin / governance allowlists (optional env fallbacks when Firestore role is not set).
 */

/** Trim, lowercase, NFKC, strip zero-width / BOM so token emails match the allowlist. */
function normalizeEmailForMatch(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

function parseEmailList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => normalizeEmailForMatch(s))
    .filter(Boolean);
}

/**
 * Admin emails sourced from the ADMIN_EMAILS environment variable (comma-separated).
 * Set ADMIN_EMAILS=email1@example.com,email2@example.com in your environment.
 * Env `GOVERNANCE_ADMIN_EMAILS` is also merged in {@link isAdminEmail}.
 */
export const ADMIN_EMAILS: readonly string[] = parseEmailList(process.env.ADMIN_EMAILS);

if (
  typeof window === "undefined" &&
  ADMIN_EMAILS.length === 0 &&
  !process.env.GOVERNANCE_ADMIN_EMAILS?.trim()
) {
  console.warn(
    "[config] No admin emails configured. Set ADMIN_EMAILS=email1,email2 in your environment."
  );
}

/** Effective allowlist for logs (built-in + env), lowercased, deduped. */
export function governanceAdminEmailsForLog(): string {
  const fromEnv = parseEmailList(process.env.GOVERNANCE_ADMIN_EMAILS);
  const builtIn = ADMIN_EMAILS.map((e) => normalizeEmailForMatch(e));
  return [...new Set([...builtIn, ...fromEnv])].join(",");
}

/**
 * MEMBERSHIP TEST ONLY — "is this string on an admin allowlist".
 *
 * Phase FIRESTORE-AUTHZ-P0.2: this is NOT an authorization decision and must
 * never be used as one. An allowlist entry says which address is trusted; it
 * says nothing about whether the calling identity actually owns that mailbox.
 * Authoritative server guards use {@link isVerifiedAdminEmail} against a LIVE
 * Firebase Auth user record instead — see
 * `lib/admin/verifiedAdminIdentity.ts`.
 *
 * Remaining legitimate uses are non-authoritative only (diagnostics/logging).
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalizeEmailForMatch(String(email));
  if (!normalized) return false;
  if (ADMIN_EMAILS.some((admin) => normalizeEmailForMatch(admin) === normalized)) return true;
  return parseEmailList(process.env.GOVERNANCE_ADMIN_EMAILS).includes(normalized);
}

/**
 * Phase FIRESTORE-AUTHZ-P0.2 — THE CANONICAL EMAIL-ALLOWLIST AUTHORITY PREDICATE.
 *
 * An email allowlist confers authority only when the authenticated identity has
 * PROVEN it owns the address. Treating {@link isAdminEmail} as an authorization
 * decision was a P0: Firebase proves nothing at sign-up —
 * `createUserWithEmailAndPassword` succeeds for any address, the project has no
 * blocking functions, and until this phase the product never even sent a
 * verification email — so anyone able to register an unclaimed allowlisted
 * address received administrator authority AND the global governance queue.
 *
 * FAIL CLOSED, DELIBERATELY. `emailVerified` must be exactly boolean `true`.
 * Absent, `undefined`, `null`, `false`, `"true"`, `"false"`, `0` and `1` all
 * deny: callers historically read this out of three different shapes (an ID
 * token's `email_verified`, a session cookie claim, a `UserRecord.emailVerified`)
 * and a claim that is missing or of the wrong type must never read as a passing
 * one. `=== true` is the whole guard, and it is load-bearing.
 *
 * CALLERS MUST SUPPLY BOTH FIELDS FROM THE SAME LIVE FIREBASE AUTH USER RECORD.
 * A token email paired with a record's verification flag (or the reverse) would
 * reintroduce precisely the identity-binding failure this closes. The pairing is
 * enforced structurally by `resolveLiveAuthIdentity()`, which returns the two
 * fields together out of one `getUser()` result — not by convention here.
 *
 * The Firebase `admin` custom claim is a SEPARATE, independently trusted,
 * server-issued authority and is intentionally NOT folded into this predicate.
 */
export function isVerifiedAdminEmail(identity: {
  email: string | null | undefined;
  emailVerified: boolean | null | undefined;
}): boolean {
  if (identity.emailVerified !== true) return false;
  return isAdminEmail(identity.email);
}
