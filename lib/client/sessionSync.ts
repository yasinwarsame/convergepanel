/**
 * Auth Lifecycle Hardening, Step 6.4/6.5/6.9 — client-side session-cookie
 * synchronization primitives.
 *
 * These are the ONLY functions in the app that call `POST`/`DELETE`/`GET
 * /api/auth/session`. `AuthProvider.tsx`, `app/login/page.tsx`, and
 * `app/signup/page.tsx` all go through this module rather than calling
 * `fetch` directly, so the synchronization contract (always verify the
 * server-returned uid; always fail closed by clearing the session on any
 * mismatch or error; never leave a half-established cookie) is enforced in
 * exactly one place.
 *
 * Deliberately framework-agnostic: `MinimalAuthUser` is a structural subset
 * of Firebase's `User` (just `uid` + `getIdToken`), so these functions are
 * fully unit-testable with a plain mock object — no Firebase SDK, no DOM.
 */

import { logAuthSessionClientEvent } from "./authSessionTelemetry";

const SESSION_ENDPOINT = "/api/auth/session";

export interface MinimalAuthUser {
  readonly uid: string;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export type SessionSyncOutcome =
  | { ok: true; uid: string }
  | { ok: false; reason: "network_error" | "server_error" | "invalid_response" | "uid_mismatch" };

interface SessionSyncOptions {
  /** Non-sensitive operation-generation number (see `authGeneration.ts`), logged only for correlating client/server telemetry — never an identity value. */
  generation?: number;
}

function isValidSessionBody(body: unknown): body is { authenticated: true; uid: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { authenticated?: unknown }).authenticated === true &&
    typeof (body as { uid?: unknown }).uid === "string" &&
    (body as { uid: string }).uid.length > 0
  );
}

/**
 * Establishes (or re-establishes) the server `__session` cookie for `user`.
 * Always fetches a FORCE-REFRESHED ID token (Step 6.5) so a just-completed
 * sign-in or account switch can never send a stale token. A single, bounded
 * retry (Step 6.5's documented exception to "no infinite retry") covers the
 * one legitimate race this can hit: the token was valid when read but
 * expired in the few hundred milliseconds before the server verified it.
 *
 * On ANY failure — network error, non-2xx, malformed body, or (critically)
 * a server-returned uid that does not match `user.uid` — this function
 * calls `clearServerSession()` itself before returning failure, so a
 * caller can never accidentally leave a mismatched or half-established
 * cookie in place just by forgetting to handle the failure branch.
 */
export async function establishServerSession(user: MinimalAuthUser, options: SessionSyncOptions = {}): Promise<SessionSyncOutcome> {
  logAuthSessionClientEvent("session_sync_started", { route: SESSION_ENDPOINT, operationGeneration: options.generation });

  const attempt = async (): Promise<Response> => {
    const idToken = await user.getIdToken(true);
    return fetch(SESSION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ idToken }),
    });
  };

  let res: Response;
  try {
    res = await attempt();
    if (res.status === 401) {
      // Bounded, single retry — documented token-expiration race only.
      res = await attempt();
    }
  } catch {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "network_error", operationGeneration: options.generation });
    return { ok: false, reason: "network_error" };
  }

  if (!res.ok) {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: `http_${res.status}`, operationGeneration: options.generation });
    await clearServerSession();
    return { ok: false, reason: "server_error" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "invalid_response", operationGeneration: options.generation });
    await clearServerSession();
    return { ok: false, reason: "invalid_response" };
  }

  if (!isValidSessionBody(body)) {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "invalid_response", operationGeneration: options.generation });
    await clearServerSession();
    return { ok: false, reason: "invalid_response" };
  }

  if (body.uid !== user.uid) {
    // The exact desync this whole step exists to prevent — the server
    // verified SOME valid token, but not the one belonging to the uid the
    // client believes is now signed in. Never trust it; never leave it.
    logAuthSessionClientEvent("session_identity_mismatch", { route: SESSION_ENDPOINT, operationGeneration: options.generation });
    await clearServerSession();
    return { ok: false, reason: "uid_mismatch" };
  }

  logAuthSessionClientEvent("session_sync_succeeded", { route: SESSION_ENDPOINT, operationGeneration: options.generation });
  return { ok: true, uid: body.uid };
}

/**
 * Clears the server `__session` cookie. Idempotent — a cookie that is
 * already absent still resolves as success (the DELETE route always
 * returns 2xx). Awaited by every caller (Step 6.7's core requirement):
 * logout, account switching, and every fail-closed path in
 * `establishServerSession` above.
 */
export async function clearServerSession(): Promise<boolean> {
  try {
    const res = await fetch(SESSION_ENDPOINT, { method: "DELETE", credentials: "same-origin", cache: "no-store" });
    if (res.ok) {
      logAuthSessionClientEvent("session_cleared", { route: SESSION_ENDPOINT });
      return true;
    }
    logAuthSessionClientEvent("logout_clear_failed", { route: SESSION_ENDPOINT, failureCategory: `http_${res.status}` });
    return false;
  } catch {
    logAuthSessionClientEvent("logout_clear_failed", { route: SESSION_ENDPOINT, failureCategory: "network_error" });
    return false;
  }
}

/**
 * Reads the server's current session identity without mutating anything.
 * Returns `{ authenticated: false }` on any error — never throws — since
 * every caller uses this for a safety check, not a hard dependency.
 */
export async function getServerSessionIdentity(): Promise<{ authenticated: boolean; uid?: string }> {
  try {
    const res = await fetch(SESSION_ENDPOINT, { method: "GET", credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return { authenticated: false };
    const body = await res.json();
    if (isValidSessionBody(body)) return { authenticated: true, uid: body.uid };
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Step 6.9 — the client/server identity consistency assertion. Compares
 * the CURRENT Firebase client uid against what the server's `__session`
 * cookie actually resolves to. Intended for use right after login/switch
 * synchronization (defense in depth on top of `establishServerSession`'s
 * own check) and, optionally, on entry to an especially sensitive
 * protected route. Never logs either uid — only the fact of a mismatch.
 */
export async function verifyClientServerIdentityMatch(clientUid: string): Promise<boolean> {
  const server = await getServerSessionIdentity();
  const match = server.authenticated && server.uid === clientUid;
  if (!match) {
    logAuthSessionClientEvent("session_identity_mismatch", { route: SESSION_ENDPOINT });
  }
  return match;
}
