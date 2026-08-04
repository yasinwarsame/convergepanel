/**
 * Auth Lifecycle Hardening, Step 6.3 — explicit session-synchronization
 * state machine.
 *
 * Root cause this exists to prevent (see docs/operations/auth-session-sync-runbook.md
 * for the full writeup): `AuthProvider` previously derived the app's entire
 * "signed in" state from Firebase's client-side `onAuthStateChanged` alone,
 * with no representation of whether the server's `__session` cookie had
 * actually been established for that same identity yet. Because every
 * protected API route resolves identity via `getRequestUid()`
 * (`lib/teams/teamApiAuth.ts`), which checks the `__session` cookie FIRST
 * and only falls back to the request's `Authorization: Bearer` token if no
 * cookie is present, a stale cookie left over from a PREVIOUS user silently
 * wins over a fresh, correctly-addressed bearer token for as long as that
 * cookie remains valid (up to 5 days) — even though the UI already displays
 * the new user's name. This state machine exists so "authenticated" can
 * only ever mean "the client's Firebase uid and the server's session-cookie
 * uid are confirmed to match," never merely "Firebase has a user object."
 *
 * Pure reducer — zero I/O, zero Firebase/DOM dependency, so every
 * transition is directly unit-testable. `AuthProvider.tsx` is the only
 * caller; it dispatches events in response to `onIdTokenChanged` and the
 * outcomes of `lib/client/sessionSync.ts`'s async calls, and treats this
 * module as the single source of truth for `syncState`.
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
  /** The server session-cookie sync call for the CURRENT client uid has started. */
  | { type: "session_sync_started" }
  /** The server confirmed a session cookie exists for the CURRENT client uid — the only condition that reaches `authenticated`. */
  | { type: "session_sync_succeeded" }
  /** The server sync call failed outright (network/5xx) or returned a DIFFERENT uid than the client's — always treated identically: fail closed. */
  | { type: "session_sync_failed" }
  /** A same-uid token refresh is being pushed to the server to keep the cookie's expiry current. Does not leave `authenticated` — a refresh is not a new identity. */
  | { type: "token_refresh_started" }
  | { type: "token_refresh_succeeded" }
  | { type: "token_refresh_failed" }
  /** Explicit, user-initiated logout has begun (before Firebase sign-out or the DELETE call has resolved). */
  | { type: "logout_started" }
  /** Both the server session was cleared and the Firebase client was signed out. */
  | { type: "logout_completed" }
  /** Returns the machine to `signed_out` after an operator/UI has acknowledged a `session_error` (e.g. before offering the user a fresh login). */
  | { type: "error_acknowledged" };

/**
 * `syncState` values in which protected mutation UI MUST be disabled.
 * Only `authenticated` guarantees client uid === server session uid.
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
      // the server session may now be stale relative to the client's token.
      return "session_error";

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
