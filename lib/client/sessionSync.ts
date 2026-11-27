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
  | { ok: false; reason: "network_error" | "server_error" | "invalid_response" | "uid_mismatch" }
  /**
   * Stage 0 F3: returned ONLY when the caller passed `keepSessionOnAuthUnavailable`
   * and the mint answered exactly 503 `{ code: "auth_unavailable" }` — the server
   * could not run verification, so it made no verdict and set no cookie. The
   * existing cookie is left untouched (not cleared) in this one case.
   */
  | { ok: false; reason: "auth_unavailable" };

interface SessionSyncOptions {
  /** Non-sensitive operation-generation number (see `authGeneration.ts`), logged only for correlating client/server telemetry — never an identity value. */
  generation?: number;
  /**
   * Stage 0 F3. Set by `AuthProvider` ONLY for a same-uid token refresh of a session
   * this tab already confirmed. When true, an exact 503 `auth_unavailable` answer
   * returns `{ reason: "auth_unavailable" }` WITHOUT clearing the cookie. Every other
   * failure — and every failure when this is false/absent — still clears it.
   */
  keepSessionOnAuthUnavailable?: boolean;
  /**
   * Stage 0 B1. Whether the FIRST attempt force-refreshes the ID token (default true — Step 6.5, every new
   * identity). `AuthProvider` passes false ONLY for a same-uid refresh of a confirmed session: that callback was
   * itself delivered because the token just changed, so the cached token is already the fresh one, and forcing
   * another refresh would mint yet another token, re-notify `onIdTokenChanged`, and start the next callback (a
   * self-sustaining chain whenever the securetoken round trip crosses the token's 1 s `iat` granularity). An
   * expired cached token is still refreshed by the SDK. A non-forced read is NOT guaranteed silent: after
   * `user.reload()` or a cross-tab persistence update (`_assign`), the SDK can notify once more when its cached
   * token differs from the one it last reported — at most one extra mint per such event, never a chain. The
   * bounded 401 retry always forces.
   */
  forceRefresh?: boolean;
  /**
   * R-S0-6. Aborts the POST(s) when `AuthProvider` supersedes or expires the sync episode. An aborted
   * request's response is never processed by the browser, so a superseded mint can no longer set a cookie after the
   * abort. Result: `network_error` (the caller has already discarded it as stale).
   */
  signal?: AbortSignal;
}

/** Exactly 503 with body `code === "auth_unavailable"`; any read/parse problem → false (fail closed). */
async function isAuthUnavailableAnswer(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "auth_unavailable";
  } catch {
    return false;
  }
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
 * The first attempt fetches a FORCE-REFRESHED ID token by default (Step 6.5) so a
 * just-completed sign-in or account switch can never send a stale token;
 * `options.forceRefresh: false` (Stage 0 B1, a same-uid refresh of a confirmed
 * session only) reads the SDK's current token instead. A single, bounded
 * retry (Step 6.5's documented exception to "no infinite retry") covers the
 * one legitimate race this can hit: the token was valid when read but
 * expired in the few hundred milliseconds before the server verified it.
 *
 * On ANY failure — network error, non-2xx, malformed body, or (critically)
 * a server-returned uid that does not match `user.uid` — this function
 * calls `clearServerSession()` itself before returning failure (R-S0-7: unless the sync was superseded), so a
 * caller can never accidentally leave a mismatched or half-established
 * cookie in place just by forgetting to handle the failure branch.
 */
export async function establishServerSession(user: MinimalAuthUser, options: SessionSyncOptions = {}): Promise<SessionSyncOutcome> {
  logAuthSessionClientEvent("session_sync_started", { route: SESSION_ENDPOINT, operationGeneration: options.generation });

  const attempt = async (force: boolean): Promise<Response> => {
    const idToken = await user.getIdToken(force);
    // R-S0-7: never mint while an earlier DELETE from this tab is still in flight (see `pendingClears`).
    await settlePendingClears();
    if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return fetch(SESSION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ idToken }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  let res: Response;
  // Stage 0 B2: a credential rejection (401) on the first attempt is a verdict. A 503 on the retry only says the
  // second check could not run — it does not show the first rejection was harmless (the client cannot tell an
  // expired-token race from a revoked, disabled or invalid credential: the 401 body is uniform). So once a 401
  // was seen, the outcome can never be the kept-session `auth_unavailable`; it fails closed.
  let rejectedFirst = false;
  try {
    res = await attempt(options.forceRefresh !== false);
    if (res.status === 401) {
      rejectedFirst = true;
      // Bounded, single retry — documented token-expiration race only. Always force-refreshed.
      res = await attempt(true);
    }
  } catch {
    const failureCategory = options.signal?.aborted === true ? "aborted" : "network_error";
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory, operationGeneration: options.generation });
    return { ok: false, reason: "network_error" };
  }

  if (!res.ok) {
    if (options.keepSessionOnAuthUnavailable === true && !rejectedFirst && (await isAuthUnavailableAnswer(res))) {
      // No verdict, no new cookie: keep the existing one (the caller keeps its confirmed state). No retry here.
      logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "auth_unavailable_kept", operationGeneration: options.generation });
      return { ok: false, reason: "auth_unavailable" };
    }
    logAuthSessionClientEvent("session_sync_failed", {
      route: SESSION_ENDPOINT,
      failureCategory: rejectedFirst ? `http_401_then_${res.status}` : `http_${res.status}`,
      operationGeneration: options.generation,
    });
    await clearUnlessSuperseded(options.signal);
    return { ok: false, reason: "server_error" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "invalid_response", operationGeneration: options.generation });
    await clearUnlessSuperseded(options.signal);
    return { ok: false, reason: "invalid_response" };
  }

  if (!isValidSessionBody(body)) {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "invalid_response", operationGeneration: options.generation });
    await clearUnlessSuperseded(options.signal);
    return { ok: false, reason: "invalid_response" };
  }

  if (body.uid !== user.uid) {
    // The exact desync this whole step exists to prevent — the server
    // verified SOME valid token, but not the one belonging to the uid the
    // client believes is now signed in. Never trust it; never leave it.
    logAuthSessionClientEvent("session_identity_mismatch", { route: SESSION_ENDPOINT, operationGeneration: options.generation });
    await clearUnlessSuperseded(options.signal);
    return { ok: false, reason: "uid_mismatch" };
  }

  logAuthSessionClientEvent("session_sync_succeeded", { route: SESSION_ENDPOINT, operationGeneration: options.generation });
  return { ok: true, uid: body.uid };
}

/**
 * R-S0-7 (owner decision 2026-11-27, review MINOR-1): the DELETEs this tab currently has in flight. A cookie clear and a
 * later mint race at the server and in the cookie jar: if an older clear (an expired episode's cleanup, the defensive
 * clear after a sign-out) is answered AFTER a newer identity's mint, it deletes the newer identity's cookie. So every
 * mint first waits until every DELETE already in flight has settled. The browser applies a response's Set-Cookie before
 * `fetch` resolves, so after the wait the older clear has taken effect and the newer cookie is set after it. A DELETE
 * that hangs delays the mint only until the caller's own deadline (AuthProvider SESSION_SYNC_DEADLINE_MS), which then
 * fails closed — never a mint racing a pending clear.
 */
const pendingClears = new Set<Promise<boolean>>();

async function settlePendingClears(): Promise<void> {
  while (pendingClears.size > 0) {
    await Promise.allSettled([...pendingClears]);
  }
}

/**
 * R-S0-7: a failure-path clear of a sync that was SUPERSEDED (its signal aborted by AuthProvider) is skipped. A newer
 * identity event owns the cookie now: a newer sign-in mints its own cookie (or clears it on its own failure), and a
 * sign-out runs AuthProvider's own clear. Issuing the stale clear here could land after the newer mint and delete it.
 */
async function clearUnlessSuperseded(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    logAuthSessionClientEvent("stale_cleanup_skipped", { route: SESSION_ENDPOINT });
    return;
  }
  await clearServerSession();
}

/**
 * Clears the server `__session` cookie. Idempotent — a cookie that is
 * already absent still resolves as success (the DELETE route always
 * returns 2xx). Awaited by every caller (Step 6.7's core requirement):
 * logout, account switching, and every fail-closed path in
 * `establishServerSession` above.
 */
export async function clearServerSession(): Promise<boolean> {
  const clear = deleteServerSession();
  pendingClears.add(clear);
  try {
    return await clear;
  } finally {
    pendingClears.delete(clear);
  }
}

async function deleteServerSession(): Promise<boolean> {
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

/*
 * ZCA L-2: the cookie-identity status read (`getServerSessionIdentity`) and the Step 6.9
 * `verifyClientServerIdentityMatch` built on it were removed with `GET /api/auth/session`.
 * Neither had a caller. The client's identity is its Firebase user; the server's is the bearer.
 */
