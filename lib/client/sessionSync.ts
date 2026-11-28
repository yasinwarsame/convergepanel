/**
 * Client side of the session verification handshake (ZCA P3 R2 "verify, don't mint").
 *
 * `establishServerSession` is the ONLY function in the app that calls `/api/auth/session`, and it only
 * ever POSTs. The server verifies the ID token (revocation-checked) and answers the uid it verified;
 * this module checks that uid against the client's. Nothing is minted and nothing needs clearing:
 * there is no server session state, so there is no client DELETE anywhere (R2 MA). `AuthProvider.tsx`
 * is the only caller; `syncState === "authenticated"` there means "the server verified, revocation-
 * checked, a bearer for exactly this uid, in this episode".
 *
 * Deliberately framework-agnostic: `MinimalAuthUser` is a structural subset of Firebase's `User`
 * (just `uid` + `getIdToken`), so it is unit-testable with a plain mock object.
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
   * R2 L-2: the server answered exactly 403 `{ code: "cross_origin" }` — it refused the request's
   * origin, which is not a verdict on the credential. The caller degrades to "cannot mutate" WITHOUT
   * signing Firebase out (no sign-out storm from a host mismatch).
   */
  | { ok: false; reason: "cross_origin" }
  /**
   * Stage 0 F3: returned ONLY when the caller passed `keepSessionOnAuthUnavailable`
   * and the handshake answered exactly 503 `{ code: "auth_unavailable" }` — the server
   * could not run verification, so it made no verdict.
   */
  | { ok: false; reason: "auth_unavailable" };

interface SessionSyncOptions {
  /** Non-sensitive operation-generation number (see `authGeneration.ts`), logged only for correlating client/server telemetry — never an identity value. */
  generation?: number;
  /**
   * Stage 0 F3. Set by `AuthProvider` ONLY for a same-uid token refresh of an identity
   * this tab already confirmed. When true, an exact 503 `auth_unavailable` answer
   * returns `{ reason: "auth_unavailable" }` (the caller keeps its confirmed state).
   * Otherwise that answer is `server_error`.
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
   * request's response is never processed. Result: `network_error` (the caller has already discarded it as stale).
   */
  signal?: AbortSignal;
}

/** The body's `code` of a failure answer; any read/parse problem → null (fail closed). */
async function failureCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
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
 * Asks the server to verify `user`'s ID token and confirm its uid (the handshake). The first attempt
 * fetches a FORCE-REFRESHED ID token by default (Step 6.5) so a just-completed sign-in or account
 * switch can never send a stale token; `options.forceRefresh: false` (Stage 0 B1, a same-uid refresh
 * of a confirmed identity only) reads the SDK's current token instead. A single, bounded retry
 * (Step 6.5's documented exception to "no infinite retry") covers the one legitimate race: the token
 * was valid when read but expired before the server verified it.
 *
 * The token is sent in BOTH `Authorization: Bearer` and the JSON body (R1 L3: during the compatibility
 * window a rollback to 9d5c6938 still accepts the body; the server requires the two to be equal).
 * Nothing is awaited between reading the token and sending it except the abort check (R2 MA).
 *
 * Any failure — network error, non-2xx, malformed body, or a server-returned uid that does not match
 * `user.uid` — is returned as a failure; the caller (AuthProvider) decides what it means. There is
 * nothing to clear on the server.
 */
export async function establishServerSession(user: MinimalAuthUser, options: SessionSyncOptions = {}): Promise<SessionSyncOutcome> {
  logAuthSessionClientEvent("session_sync_started", { route: SESSION_ENDPOINT, operationGeneration: options.generation });

  const attempt = async (force: boolean): Promise<Response> => {
    const idToken = await user.getIdToken(force);
    if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    return fetch(SESSION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
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
    const code = res.status === 503 || res.status === 403 ? await failureCode(res) : null;
    if (res.status === 503 && code === "auth_unavailable" && options.keepSessionOnAuthUnavailable === true && !rejectedFirst) {
      // No verdict: the caller keeps its confirmed state. No retry here.
      logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "auth_unavailable_kept", operationGeneration: options.generation });
      return { ok: false, reason: "auth_unavailable" };
    }
    logAuthSessionClientEvent("session_sync_failed", {
      route: SESSION_ENDPOINT,
      failureCategory: rejectedFirst ? `http_401_then_${res.status}` : `http_${res.status}`,
      operationGeneration: options.generation,
    });
    if (res.status === 403 && code === "cross_origin") return { ok: false, reason: "cross_origin" };
    return { ok: false, reason: "server_error" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "invalid_response", operationGeneration: options.generation });
    return { ok: false, reason: "invalid_response" };
  }

  if (!isValidSessionBody(body)) {
    logAuthSessionClientEvent("session_sync_failed", { route: SESSION_ENDPOINT, failureCategory: "invalid_response", operationGeneration: options.generation });
    return { ok: false, reason: "invalid_response" };
  }

  if (body.uid !== user.uid) {
    // The server verified SOME valid token, but not one for the uid the client believes is signed
    // in. Never trust it.
    logAuthSessionClientEvent("session_identity_mismatch", { route: SESSION_ENDPOINT, operationGeneration: options.generation });
    return { ok: false, reason: "uid_mismatch" };
  }

  logAuthSessionClientEvent("session_sync_succeeded", { route: SESSION_ENDPOINT, operationGeneration: options.generation });
  return { ok: true, uid: body.uid };
}

/*
 * ZCA P3 R2: `clearServerSession` (the client DELETE), the R-S0-7 `pendingClears` wait before every
 * handshake and the failure-path clears were removed. The server holds no session state for this
 * client, so there is nothing to clear and nothing for a handshake to wait for (invariant 5).
 */

/*
 * ZCA L-2: the cookie-identity status read (`getServerSessionIdentity`) and the Step 6.9
 * `verifyClientServerIdentityMatch` built on it were removed with `GET /api/auth/session`.
 * Neither had a caller. The client's identity is its Firebase user; the server's is the bearer.
 */
