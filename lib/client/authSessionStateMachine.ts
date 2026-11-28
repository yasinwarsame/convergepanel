/**
 * Auth Lifecycle Hardening, Step 6.3 — explicit session-verification state machine.
 *
 * MEANING OF `authenticated` (ZCA P3 R2 "verify, don't mint"): the server VERIFIED, revocation-checked,
 * a bearer (Firebase ID token) for EXACTLY this client uid, in THIS episode — the handshake
 * (`POST /api/auth/session`) answered 200 `{ authenticated: true, uid }` with `uid === client uid`, for
 * the current operation generation, and the episode was not aborted, superseded or expired. It is the
 * gate for protected mutations (`canMutate`, invariant 7). It does NOT mean that any server session
 * exists: there is none. Every API request authenticates with its own bearer.
 *
 * History: `AuthProvider` once derived "signed in" from Firebase's client state alone, while the server
 * authorized a `__session` cookie that could belong to a previous user. The cookie no longer authorizes
 * or vetoes anything (ZCA L-8, P3 R2), but the machine still guarantees that the UI enables mutations
 * only after the server agreed, for this uid, that the credential is valid right now.
 *
 * Pure reducer — zero I/O, zero Firebase/DOM dependency, so every transition is directly unit-testable.
 * `AuthProvider.tsx` is the only caller. The event names keep their historical "session" wording.
 */

export type SessionSyncState =
  | "signed_out"
  | "authenticating"
  | "syncing_session"
  | "authenticated"
  | "signing_out"
  | "session_error";

export type SessionSyncEvent =
  /** A login/signup submission has been dispatched to Firebase but not yet resolved — UI-level intent, not a Firebase callback. */
  | { type: "login_attempt_started" }
  /** Firebase resolved a signed-in user (fresh login, persisted session restore, or a DIFFERENT uid than previously tracked — an account switch). */
  | { type: "client_signed_in"; uid: string }
  /** Firebase reports no user (explicit sign-out, revoked session, or expired token the SDK could not refresh). */
  | { type: "client_signed_out" }
  /** The verification handshake for the CURRENT client uid has started. */
  | { type: "session_sync_started" }
  /** The server verified (revocation-checked) a bearer for the CURRENT client uid, in this episode — the only event that reaches `authenticated`, and only from `syncing_session`. */
  | { type: "session_sync_succeeded" }
  /** The handshake failed (network, 401, 403, 5xx, malformed answer, deadline) or returned a DIFFERENT uid than the client's — fail closed. */
  | { type: "session_sync_failed" }
  /** A same-uid token refresh is being re-verified by the server. Does not leave `authenticated` — a refresh is not a new identity — and never upgrades any other state. */
  | { type: "token_refresh_started" }
  | { type: "token_refresh_succeeded" }
  | { type: "token_refresh_failed" }
  /**
   * Stage 0 F3: a same-uid refresh's handshake answered 503 `auth_unavailable` (the server could not run verification
   * and made no verdict). Keeps `authenticated` ONLY if already `authenticated`; from any other state it is `session_error`.
   */
  | { type: "token_refresh_deferred" }
  /** Explicit, user-initiated logout has begun (before the local Firebase sign-out has resolved). */
  | { type: "logout_started" }
  /** The Firebase client was signed out (there is no server session to clear). Unused by AuthProvider, which relies on `client_signed_out`. */
  | { type: "logout_completed" }
  /** Returns the machine to `signed_out` after an operator/UI has acknowledged a `session_error` (e.g. before offering the user a fresh login). */
  | { type: "error_acknowledged" };

/**
 * `syncState` values in which protected mutation UI MUST be disabled.
 * Only `authenticated` guarantees the server verified a bearer for exactly the client uid.
 */
export const NON_MUTABLE_SYNC_STATES: ReadonlySet<SessionSyncState> = new Set<SessionSyncState>([
  "signed_out",
  "authenticating",
  "syncing_session",
  "signing_out",
  "session_error",
]);

export function canPerformProtectedMutation(state: SessionSyncState): boolean {
  return state === "authenticated";
}

/**
 * Pure state transition. Every branch not explicitly handled below is a
 * fail-closed no-op transition to `session_error` — an event that doesn't
 * make sense for the current state is treated as a synchronization failure
 * rather than silently ignored or silently accepted, per the "auth failures
 * fail closed" invariant.
 */
export function nextSessionSyncState(current: SessionSyncState, event: SessionSyncEvent): SessionSyncState {
  switch (event.type) {
    case "login_attempt_started":
      return "authenticating";

    case "client_signed_in":
      // From ANY state, a freshly observed signed-in uid always moves to
      // syncing_session — this is what makes account-switch-without-explicit-
      // logout safe: whatever the previous state was (including
      // `authenticated` for a DIFFERENT uid), the machine re-enters
      // synchronization and cannot stay `authenticated` for the old identity.
      return "syncing_session";

    case "client_signed_out":
      // Firebase itself reports no user — whether this is the expected
      // completion of an explicit logout or an unexpected revocation, the
      // client has no identity either way, so the machine can never stay
      // `authenticated`.
      return "signed_out";

    case "session_sync_started":
      return current === "syncing_session" ? "syncing_session" : "session_error";

    case "session_sync_succeeded":
      return current === "syncing_session" ? "authenticated" : "session_error";

    case "session_sync_failed":
      return "session_error";

    case "token_refresh_started":
      // Only a meaningful transition from `authenticated` — refreshing a
      // token for an identity that was never confirmed synced is itself an
      // inconsistency.
      return current === "authenticated" ? "authenticated" : "session_error";

    case "token_refresh_succeeded":
      return current === "authenticated" ? "authenticated" : "session_error";

    case "token_refresh_failed":
      // A failed refresh does NOT retain the previous authenticated state —
      // the server refused (or could not be shown) the current token.
      return "session_error";

    case "token_refresh_deferred":
      // Not a verdict on the credential: the existing confirmed state stands (the
      // server re-verifies the bearer, revocation-checked, on every request). Never
      // upgrades any other state.
      return current === "authenticated" ? "authenticated" : "session_error";

    case "logout_started":
      return "signing_out";

    case "logout_completed":
      return "signed_out";

    case "error_acknowledged":
      return current === "session_error" ? "signed_out" : current;

    default:
      return "session_error";
  }
}
