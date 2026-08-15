/**
 * Phase 5C — the ONLY way a Server Component (as opposed to a Route
 * Handler) can resolve the authenticated caller's uid. `/workspace`'s
 * server-side gate is this module's sole reason to exist.
 *
 * Deliberately NOT a second authentication system. It is a thin adapter
 * around the exact same Firebase Admin SDK verification call every other
 * protected route already uses (`verifySessionCookieValue()`,
 * `lib/firebase/auth-helpers.ts` — the literal function
 * `resolveRequestIdentity()`'s own `verifySessionCookie(request)` now
 * delegates to). The only thing this module does differently is WHERE the
 * raw cookie value comes from: `next/headers`'s `cookies()` (the only API
 * surface a Server Component has for reading the incoming request's
 * cookies) instead of a `NextRequest`'s `.cookies.get()`. The decoding,
 * verification, and error handling are byte-identical — same function,
 * same call, same failure modes.
 *
 * Deliberately NOT a bearer-token check. `resolveRequestIdentity()`
 * (Route Handlers) considers both the `__session` cookie and an
 * `Authorization: Bearer` header, because some API callers (the client's
 * own `authedFetch` helper) attach a Firebase ID token explicitly. A
 * top-level browser navigation to `/workspace` — the only way this module
 * is ever invoked — never carries a custom `Authorization` header; there
 * is no bearer credential to consider here, so this module doesn't
 * pretend to have dual-credential semantics it can't actually exercise.
 *
 * Deliberately a narrower return type than `RequestIdentityResult`. The
 * only decision this module's caller (`/workspace/page.tsx`) needs to
 * make is "does an authenticated identity exist, yes or no" — for a
 * route-existence (`notFound()`) decision, WHY a credential failed
 * (missing vs. expired vs. revoked vs. malformed) carries no different
 * consequence, so this module collapses every failure mode to `null`
 * rather than inventing a parallel reason taxonomy to keep in sync with
 * `resolveRequestIdentity()`'s.
 */

import "server-only";
import { cookies } from "next/headers";
import { verifySessionCookieValue } from "@/lib/firebase/auth-helpers";

export interface ServerComponentIdentity {
  uid: string;
}

/**
 * Read-only: never sets, refreshes, or clears any cookie, never
 * provisions or mutates any user/session state. A visit to `/workspace`
 * has zero authentication side effects beyond this verification read.
 */
export async function resolveServerComponentIdentity(): Promise<ServerComponentIdentity | null> {
  const sessionCookie = cookies().get("__session")?.value;
  try {
    const result = await verifySessionCookieValue(sessionCookie);
    return result ? { uid: result.uid } : null;
  } catch {
    // Invalid/expired/revoked/malformed cookie, or Admin Auth
    // unavailable — all fail closed to "no identity" here, matching
    // resolveRequestIdentity()'s own fail-closed posture for every
    // verification failure. See the module doc comment for why this
    // deliberately doesn't distinguish *why* verification failed.
    return null;
  }
}
