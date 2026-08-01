# Auth Lifecycle Hardening — Client/Server Session Synchronization Runbook

Step 6: Auth Lifecycle Hardening. Fixes the cross-cutting identity desynchronization disclosed during Step 5's security review (`docs/operations/multi-reviewer-governance-runbook.md` §7) and reproduced concretely during that step's own live browser testing.

## 1. Root cause

Every protected team/governance API route resolves the caller's identity via `getRequestUid()` (`lib/teams/teamApiAuth.ts`). Before this step, that function:

1. Checked the `__session` cookie first.
2. If a cookie was present and decoded to a valid identity, returned that uid **immediately** — the request's `Authorization: Bearer` token, if any, was never even inspected.

Combined with two independent client-side gaps:

- **`app/login/page.tsx`** fired a session-cookie `POST` after sign-in but never awaited or verified its result before treating login as complete and redirecting — the UI (and the rest of the app, via `AuthProvider`'s `user` state, which updates from Firebase's client SDK independently of the server cookie) could show the new user as signed in before the server cookie existed, matched, or even attempted to sync.
- **`components/TopNav.tsx`**'s logout called only the Firebase client SDK's `signOut()` — never `DELETE /api/auth/session`. The server cookie for the just-logged-out user remained valid for up to its full 5-day lifetime.

**Net effect**: a `__session` cookie left over from a PREVIOUS user on the same browser could silently keep authorizing every subsequent request as that previous user — even after a different user had visibly signed in and the UI displayed their name — for as long as that stale cookie remained valid. `authedFetch` (used throughout the governance UI) always sends a correct, fresh `Authorization: Bearer` token for the CURRENT client user, but that token was simply never consulted whenever a cookie — any cookie, stale or not — was present.

## 2. Reproduction (as originally observed)

1. User A logs in. Session cookie set correctly for A.
2. User A "logs out" via the UI (pre-fix `TopNav.tsx`) — Firebase client signs out, but the server cookie for A is never cleared.
3. User B logs in on the same browser. The client-side UI immediately shows B (Firebase's `onAuthStateChanged`/`onIdTokenChanged` fires as soon as the client SDK resolves the credential, independent of any server round trip). The session-cookie POST for B may not have completed yet, or may complete moments later — but the STALE cookie for A is still sitting in the browser until that POST's `Set-Cookie` response actually lands and is processed.
4. Any protected request that races ahead of that `Set-Cookie` landing — or, in the reproduced case, a request made while the login flow's own async work (Firestore doc merges, etc.) was still in flight — is authorized by `getRequestUid()` using the cookie, which still contains A's identity, not B's. The response is attributed to, and scoped to, A — while the UI displays B.

Confirmed directly during Step 5 testing via `GET /api/teams/adaptive-runs/{runId}/review-panel`: the response's `canOverride: true` (owner-only) and every reviewer's `isCurrentUser: false` proved the server had resolved the caller as the PREVIOUS owner identity, while the browser's own top-nav displayed a different, newly-logged-in reviewer's name.

## 3. Fix inventory

### Server: `lib/teams/teamApiAuth.ts` — `getRequestUid()`

If a valid cookie AND a valid bearer token are both present and independently decode to **different** uids, the request is now rejected (`401`) rather than the cookie silently winning. A bearer token that is merely absent, malformed, or expired is not a conflict — the cookie alone remains sufficient, unchanged from prior behavior. This closes the exact mechanism the reproduction above depended on, at the server layer, independent of whether the client-side fixes below ever run.

### Server: `app/api/auth/session/route.ts`

- `POST`: returns `{ authenticated: true, uid }` (server-derived uid only — the client's own claimed uid, if any, is never read). `Cache-Control: no-store`.
- `DELETE`: sets an already-expired cookie with **identical** `httpOnly`/`secure`/`sameSite`/`path` attributes to creation (a mismatch here can leave the browser treating it as a different cookie and not actually clearing the original). Idempotent — always `200`. `Cache-Control: no-store`.
- `GET` (new): returns `{ authenticated: boolean, uid?: string }` only — never email, claims, the cookie/token itself, or team data. `Cache-Control: no-store`. This is the read side of the client/server identity consistency check.

### Client: `lib/client/sessionSync.ts` (new)

The only module that calls the three session endpoints. `establishServerSession(user)` always force-refreshes the ID token, `POST`s it, and compares the server-returned uid to the client's — on ANY failure or mismatch it calls `clearServerSession()` itself before returning, so a caller can never accidentally leave a half-established or mismatched cookie in place. A single bounded retry covers the documented token-expiration race (a `401` on the first attempt); a second `401` is a final failure, never a loop. `clearServerSession()` and `getServerSessionIdentity()` are the DELETE/GET counterparts; `verifyClientServerIdentityMatch(uid)` combines a GET with a comparison for defense-in-depth checks on sensitive route entry.

### Client: `lib/client/authSessionStateMachine.ts` (new) + `lib/client/authGeneration.ts` (new)

A pure, fully unit-tested state-transition reducer (`signed_out | authenticating | syncing_session | authenticated | signing_out | session_error`) and a tiny operation-generation counter. `"authenticated"` is reachable ONLY via a successful `session_sync_succeeded` event from `syncing_session` — every other path fails closed to `session_error`. The generation guard ensures a stale async result (an old login response, a refresh resolving after logout, a rapid switch) is discarded rather than applied.

### Client: `components/AuthProvider.tsx` (rewritten)

Now the single owner of both the state machine and the actual synchronization side effects. Listens to `onIdTokenChanged` (not `onAuthStateChanged` — token refreshes need the same treatment). On each callback: a DIFFERENT uid than previously tracked (including the very first callback, covering a persisted-session page reload) is treated as a new identity requiring full re-sync (`syncing_session` → `establishServerSession` → `authenticated`/`session_error`); the SAME uid is treated as a routine token refresh (stays `authenticated` throughout, no UI flicker, but still guarded by the same generation check). On any sync failure, defensively signs the Firebase client out too — the server side was already cleared by `establishServerSession`'s own fail-closed behavior — so the previous identity is never retained on either side. Exposes `syncState`, `canMutate` (`syncState === "authenticated"`), and `beginLogout()` (lets a caller eagerly transition to `signing_out` before its own async work starts) via `useAuth()`, alongside the pre-existing `user`/`loading`/`authReady`/`isAdmin`/`adminResolved`.

### Client: `app/login/page.tsx`, `app/signup/page.tsx`

Both now: (1) invalidate any existing DIFFERENT session (`clearServerSession()` + `signOut(auth)`) before starting a new sign-in/sign-up — the primary account-switch sequence; (2) never redirect directly after the Firebase call — instead arm a pending-uid watcher and wait for `syncState === "authenticated"` for THAT specific uid (not merely "some" authenticated state, which protects against a stale previous-session's state still settling); (3) a single 10-second bounded timeout, no retry loop, surfaces an error and re-enables the form if sync stalls.

**A genuine bug was found and fixed during this step's own manual browser verification, not by the unit tests**: the pending-uid tracker was initially a `useRef`, not `useState`. Since `AuthProvider`'s own reactive sync can complete BEFORE the login page finishes its own sequential Firestore work and arms the tracker, a `syncState === "authenticated"` transition could already have happened by the time the ref was set — and because mutating a ref does not re-trigger the effect that checks it, the redirect would simply never fire until the 10-second timeout force-failed an otherwise-successful login. Fixed by switching to `useState`, so arming the expected uid always re-evaluates against whatever `syncState` already is at that moment, regardless of which side finished first. This is exactly the kind of race the "must verify live in a browser, not just via mocked unit tests" invariant exists to catch — the existing unit tests mocked `sessionSync` directly and had no way to reproduce this specific ordering.

### Client: `components/TopNav.tsx`

Logout now: calls `beginLogout()` immediately (disables protected mutation UI app-wide before any async work starts) → awaits `clearServerSession()` → awaits `signOut(auth)` → only THEN navigates to a "signed out" page. If the server clear fails, the Firebase client is still signed out (so the UI hides protected content), but the redirect carries a `sessionClearFailed=1` marker instead of the normal clean-logout state, rather than silently claiming a fully clean sign-out while the server cookie might still be valid.

### Client: governance mutation UI

`AdaptiveMultiReviewerPanelSection.tsx`, `AdaptivePanelVoteForm.tsx`, `AdaptivePanelOverrideForm.tsx`, `AdaptiveReviewDecisionForm.tsx` — every mutating action (create/reconfigure/cancel panel, finalize, vote submit, override submit, single-reviewer decision submit) now additionally requires `canMutate` from `useAuth()`, both in the handler's own guard and in the rendered button's `disabled` state. Read-only data loading is unaffected (still gates on `user`/`authReady` alone, matching prior behavior).

## 4. Observability

`lib/authTelemetry.ts` (server, wraps `@/lib/logger`) and `lib/client/authSessionTelemetry.ts` (client, wraps `console.info`/`console.warn` — `lib/logger` is `"server-only"` and cannot run in the browser) both expose the same exhaustive, structurally-safe event set: `session_sync_started`, `session_sync_succeeded`, `session_sync_failed`, `session_identity_mismatch`, `session_cleared`, `logout_clear_failed`, `stale_auth_operation_discarded`, `revoked_or_expired_session`. Allowed metadata: `route`, `failureCategory`, `operationGeneration` (a non-sensitive integer used only to correlate telemetry with the generation guard). **No field for a token, cookie value, uid, email, or claim exists on either metadata type** — not redacted, structurally absent, matching the precedent `lib/governance/adaptiveGovernanceTelemetry.ts` established.

## 5. Security review summary

- **Session fixation**: not applicable — no pre-auth session identifier is ever issued; the cookie is created fresh, server-side, only after a valid ID token is verified.
- **Replay**: session cookies are Firebase-signed JWTs with expiry (5 days) and revocation checking (`verifySessionCookie(cookie, true)` — `checkRevoked: true`, unchanged, pre-existing).
- **Stale-cookie reuse**: the core issue this step fixes — see §1–3 above.
- **Account-switch races**: covered by the operation-generation guard (unit-tested exhaustively) and the login/signup pages' explicit pre-switch invalidation.
- **Logout incompleteness**: fixed — `TopNav.tsx` now awaits the server cookie's actual deletion.
- **CSRF**: `sameSite: "lax"` on the session cookie (unchanged) combined with the session endpoints requiring `Content-Type: application/json` (not a CORS-simple request) remains the app's existing, adequate defense — not weakened or strengthened in this step.
- **Cookie flags**: `httpOnly`, `secure`, `sameSite: "lax"`, `path: "/"` — now provably IDENTICAL between creation and deletion (previously, deletion used a shorthand that could omit some attributes).
- **XSS exposure**: cookie remains `httpOnly` (inaccessible to JS); `GET /api/auth/session`'s uid exposure is no greater than what the Firebase client SDK already exposes via `auth.currentUser.uid`.
- **Cross-tab persistence**: Firebase's client SDK uses shared (not per-tab) persistence by default — confirmed during manual verification that this is a NET POSITIVE for this fix: a logout or account switch in one tab reactively fires `onIdTokenChanged` in every other open tab of the same browser, so `AuthProvider`'s existing reactive logic handles multi-tab safety without any additional cross-tab messaging (BroadcastChannel, storage events) being necessary.
- **Error leakage**: session route responses never include a raw Firebase Admin error message; verified by dedicated tests.

**Disclosed, not fixed in this step (deliberately out of scope)**: 14 other route files (`app/api/verify-claim`, `verify-video`, `run-panel`, `synthesize-panel`, `billing/*`, `user/*`, `governance/reviewer`, etc.) independently reimplement the same cookie-first pattern `getRequestUid()` had. Several of these are the protected Claim/Video Verification paths explicitly forbidden from modification in this step's own scope. The underlying pattern is identical to what was fixed in `teamApiAuth.ts`; centralizing it into one shared, reusable helper function is recommended follow-up work, not attempted here, to keep this step's change surface scoped to the team/governance route family that actually needed to be gated for release.

## 6. Manual verification performed

Two real, non-production seeded identities (`gov-e2e-owner@example.com`, `gov-e2e-reviewer-1@example.com`), real browser, real (only) Firebase project:

- **Login**: fresh sign-in and a persisted-session restore (new tab, already-signed-in Firebase client state) both correctly resolved to `syncState === "authenticated"` with server/client uid agreement confirmed via `GET /api/auth/session`.
- **Direct account switch**: submitting the login form while a DIFFERENT user was already signed in correctly invalidated the old session first, established the new one, and the server uid matched the newly-displayed identity — confirmed via direct API check, not just visual inspection.
- **Logout**: server session confirmed cleared (`GET /api/auth/session` → `{authenticated: false}`) and a protected endpoint confirmed to return `401` immediately afterward.
- **Multi-tab, direction 1**: a tab left open with an active session, when logout happens via a DIFFERENT means (another tab), reactively transitioned to a signed-out state with no manual reload — Firebase's shared cross-tab persistence propagating `onIdTokenChanged(null)`.
- **Multi-tab, direction 2**: an account switch performed in one tab reactively updated a SECOND, already-open tab's displayed name, governance capability flags (Owner Override section correctly disappearing for the new, non-owner identity), and vote attribution (correctly re-labeled to the new identity) — with no reload.
- **Governance regression**: the owner-only Override section was confirmed visible only to the owner identity and correctly absent once the tab's identity reactively switched to a non-owner reviewer; the reviewer's own vote row correctly updated its "You" attribution to match.
- **Rapid switch (A→B→A)**: not exercised as a literal near-simultaneous double-submission via the UI, since the login form's own `loading`-disabled submit button prevents that path structurally (a second submit cannot fire while the first is in flight) — the underlying race this scenario stresses (an old async result landing after a newer one starts) is instead covered exhaustively by `lib/client/__tests__/authGeneration.spec.ts`'s direct simulation of exactly this ordering.

## 7. Release decision

**Identity desynchronization is resolved** for the team/governance route family (`getRequestUid()` and everything built on it — the entire multi-reviewer governance surface, team review queues, and related routes). Multi-reviewer governance's own release gates (`MULTI_REVIEWER_GOVERNANCE_ENABLED` and each team's `adaptiveMultiReviewerSettings.enabled`) are unaffected by and independent of this step — both remain off by default, per `docs/operations/multi-reviewer-governance-runbook.md`'s own recommendation, which this step does not change.

**Recommended deployment sequence**: deploy this step's changes as a standard code release — no environment variable, no Firestore migration, no schema change. `GET /api/auth/session` is a new, additive route; existing `POST`/`DELETE` callers (there are none left after this step's own login/signup/TopNav updates) would still receive compatible responses.

**Recommended rollback sequence**: revert this step's commits. No data migration to reverse — every change is code-only (route handlers, React components/hooks, new pure modules). Existing `__session` cookies created by the OLD `POST` handler remain valid under the NEW `POST`/`GET`/`DELETE` handlers and vice versa (the cookie's own contents — a Firebase-signed session JWT — are unchanged in format).

**Recommended next phase**: centralize the still-duplicated cookie/bearer resolution pattern (§5's disclosed finding) into one shared helper, then migrate the 14 other route files onto it — including the protected verification paths, which would need to go through whatever review process governs changes to those paths specifically, not bundled into an auth-lifecycle step.

---

## Step 7 — Repository-Wide Remediation (all 19 affected routes) + Recovery (strict dual-credential validation)

This section documents the direct follow-up to §7's "recommended next phase" above: centralizing the duplicated cookie/bearer pattern and migrating every route that still had it, including the protected Claim Verification and Video Verification paths (explicitly authorized for auth-only changes).

### Route inventory — exact count

The disclosure at the end of Step 6 named "14 routes." A repository-wide search (not just `app/api`, which is what the original 14-route disclosure was based on) found the real count is **19 routes across 15 code locations**:

- **14 routes**, each independently duplicating the vulnerable pattern inline: `app/api/verify-claim`, `verify-video`, `run-panel`, `synthesize-panel` (two call sites, GET+POST), `user/usage`, `user/panel-history`, `user/run-governance`, `user/runs/[runId]`, `user/verifications/[verificationId]`, `billing/create-checkout-session`, `billing/create-portal-session`, `billing/sync-plan`, `billing/validate-subscription`, `governance/reviewer`.
- **5 additional routes**, found only during the post-migration cross-route search (Step 7.15), sharing the SAME vulnerable pattern via one indirect helper (`resolveGovernanceRequestUser()` in `lib/governance/authCheck.ts`) that the original `app/api`-only search missed because the routes never call `verifySessionCookie` directly: `app/api/governance/audit`, `audit/backfill`, `review`, `queue`, `policy`.

Combined with the 15 team/governance routes already fixed in Step 6 (via `getRequestUid()`), **34 routes total** now resolve identity through the one shared contract, directly or via one of its two thin wrappers.

### Shared resolver architecture

`lib/auth/resolveRequestIdentity.ts` is the single source of truth. Two thin, byte-for-byte-behavior-preserving wrappers sit on top of it for their respective callers' existing return-type contracts:

- `getRequestUid()` (`lib/teams/teamApiAuth.ts`) — used by the 15 Step-6 team/governance routes. Returns `string | NextResponse`, exactly as before.
- `resolveGovernanceRequestUser()` (`lib/governance/authCheck.ts`) — used by the 5 governance routes found in the cross-route search. Returns `{ok:true,uid,email} | {ok:false,status:401}`, exactly as before.

The 14 originally-disclosed routes call `resolveRequestIdentity()` directly.

### Recovery: strict dual-credential validation (closes a live-verified gap)

The FIRST version of `resolveRequestIdentity()` shipped in this step deliberately preserved a narrower carve-out inherited from Step 6: *"valid cookie + merely invalid/expired bearer → still authenticated via the cookie"* — reasoned as "an expiring access token is routine, not evidence of conflict."

**Live manual verification against the real running server found this carve-out was itself unsafe.** A stale `__session` cookie for user A, presented alongside a bearer token that had EXPIRED and was actually issued for a DIFFERENT user B, authenticated the request as A. The expired token made B's identity unverifiable, but its mere presence was still silently discarded rather than treated as a second, conflicting identity claim — reproducing a narrower version of the exact desync class this whole engagement exists to close.

**Fixed by removing the carve-out entirely.** The corrected, final policy: whenever a credential slot (cookie or bearer) is PRESENT on a request — regardless of validity — it is independently verified. If only one slot is present, that slot alone decides the outcome (this is unchanged: cookie-only and bearer-only support are both fully preserved). If BOTH slots are present, BOTH must independently validate AND resolve to the SAME uid, or the request fails closed. There is no longer any "one wins over the other" case:

| Cookie | Bearer | Result |
|---|---|---|
| absent | absent | 401 `missing_credentials` |
| absent | valid | authenticated (`bearer_token`) |
| absent | invalid/expired/revoked/malformed | 401 (bearer's own reason) |
| valid | absent | authenticated (`session_cookie`) |
| invalid/expired/revoked | absent | 401 (cookie's own reason) |
| valid | valid, SAME uid | authenticated (`matching_cookie_and_bearer`) |
| valid | valid, DIFFERENT uid | 401 `credential_mismatch` |
| **valid** | **invalid/expired/revoked/malformed** | **401 (bearer's own reason) — NO fallback to the cookie** |
| invalid/expired/revoked | valid | 401 (cookie's own reason) — no fallback to the bearer |
| invalid/expired/revoked | invalid/expired/revoked | 401 (cookie's own reason) |

A malformed `Authorization` header (wrong scheme, e.g. `Basic ...`, or empty after `Bearer `) counts as **present-but-invalid**, never as absent — so it can never be silently treated as "no bearer credential was offered" and skip straight to cookie-only evaluation.

**A second, unrelated implementation bug was found and fixed during the recovery itself**: the first attempt at the strict rewrite added a redundant raw `request.cookies.get("__session")` presence pre-check before calling `verifySessionCookie()`, duplicating logic `verifySessionCookie()` already provides via its own null-for-absent/throw-for-invalid contract. This broke several pre-existing test suites (`run-panel`, `synthesize-panel`) that mock `verifySessionCookie` directly without necessarily constructing a request with a real `Cookie` header — the redundant raw check bypassed their mocks entirely, causing spurious 401s. Fixed by removing the duplicate check and relying solely on `verifySessionCookie()`'s own contract, restoring compatibility with every existing test's mocking convention.

### Claim Verification / Video Verification — what changed and what didn't

Both routes' auth blocks were replaced with a call to `resolveRequestIdentity()`; nothing else in either file changed. Confirmed via `git diff`: the diffs are contained entirely to the import lines and the auth-check block — parsing, model dispatch, verdict/consensus computation, quota checks, token accounting, and audit-bundle logic are byte-identical to before. One minor, disclosed simplification in each: `verify-claim` had no email-sourcing logic to preserve; `verify-video`'s `authEmail` (a rare fallback used only when Firestore's `users/{uid}.email` is ALSO absent) is now always `""`, matching what the cookie-authenticated path already did in every common case — the shared resolver does not expose a bearer token's own claims back to callers, and this fallback was never quota/verification-relevant.

No pre-existing test suite covered either route before this step (a pre-existing gap, not created by it). New dedicated auth-boundary test files were added for both (`app/api/verify-claim/__tests__/verifyClaimAuthRegression.spec.ts`, `app/api/verify-video/__tests__/verifyVideoAuthRegression.spec.ts`), using `checkRateLimit` (the first call after auth) as the observable seam proving the auth gate passed/failed correctly with the right uid, without mocking the multi-model verification pipeline itself.

### Manual verification (recovery-updated)

Repeated against the real running server with real Firebase identities (two seeded, non-production accounts) after the recovery fix, for all four required route families — Claim Verification, Video Verification, one other route (`user/usage`), and one team/governance route (`teams/runs`, confirming Step 6 remains intact):

- Matching cookie + bearer (same identity) → passes auth, reaches business logic.
- Cookie-only, bearer-only → both independently pass auth.
- Mismatched valid cookie + valid bearer (different identities) → 401, confirmed live both before and after the recovery fix.
- **Valid cookie + malformed/garbage bearer, alongside a genuinely different identity's bearer** → 401, confirmed live after the recovery fix (this is the practical live stand-in for "expired bearer for a different user," which was directly unit-tested with a mocked `auth/id-token-expired` Firebase error — waiting for a REAL Firebase ID token to naturally expire, ~1 hour, was not practical for live verification, but the code path and outcome are identical for any bearer-verification failure reason, expired or otherwise).

### Security review (recovery-updated)

- **Credential confusion / stale-cookie reuse**: closed for all 34 routes at the resolver level, no per-route exceptions.
- **Invalid-credential fallback**: eliminated entirely — the recovery removed the last remaining case where a failed credential could be silently ignored in favor of a different, successfully-validated one.
- **Auth failure blocks downstream business logic**: confirmed for every migrated route via dedicated tests (`checkRateLimit`/business-logic mocks never invoked on any 401 path).
- **No sensitive logging**: `lib/auth/identityResolutionTelemetry.ts` carries the same exhaustive, structurally-safe allowlist as every other telemetry wrapper in this codebase (`route`, `method`, `failureCategory` only — never uid/email/token/cookie/claims).
- **Intentional, disclosed exceptions**: `verifyAdminToken`/`requireAdminApiAccess` (`lib/firebase/auth-helpers.ts`, used by `app/api/admin/*`) were audited and found NOT vulnerable to this pattern — both extract the bearer token FIRST (opposite precedence), only ever considering the cookie when no `Authorization` header is present at all, so a stale cookie can never override a fresh bearer for these routes. `lib/firebase/adminAuth.ts`'s `getRequestUser()` is bearer-only (never reads a cookie at all). None of these were modified.

### Release impact

No cookie-first or invalid-credential-fallback path remains anywhere in the repository (confirmed via exhaustive final grep sweep). Multi-reviewer governance's own release gates remain independently off by default and are unaffected by this step or its recovery — enabling it now inherits the fully strict, repository-wide identity-consistency guarantee, with no known remaining gap.

## Step 8 — Canary rollout rehearsal: auth layer re-verification (no code change)

Step 8 (see `docs/operations/multi-reviewer-governance-runbook.md` §11) was a REHEARSAL of the multi-reviewer governance canary rollout against the non-production `gov-e2e-seed-*` harness — it made no change to any file this runbook documents. It is recorded here because it exercised this hardened auth layer live, under real multi-identity browser sessions, for the first time since Step 7's recovery closed:

- Five distinct real Firebase identities (owner, admin, and three reviewer accounts) were logged into sequentially across two browser tabs sharing one cookie jar, exactly the kind of account-switch sequence Step 6 was built to make safe. Every switch correctly replaced the prior identity with no residual access from the previous session — confirmed by each subsequent page load showing only the newly-logged-in identity's own name and permissions (e.g. a non-owner admin correctly never saw the Owner Override control after switching from the owner).
- The team/governance route family's identity resolution (`getRequestUid()` → `resolveRequestIdentity()`) was exercised through real create/vote/finalize/override/cancel calls throughout Step 8.6/8.7, all succeeding with the correct uid attributed to each action (visible in the resulting immutable decision records' `reviewerId`/`actorUserId` fields) and none logged with any credential material — consistent with §"No sensitive logging" above.
- No new gap was found. This section exists to record that the hardened resolver was load-bearing under real (rehearsal) multi-user traffic, not merely under mocked unit tests, reinforcing this runbook's own "live verification is not optional" principle one step further down the release pipeline.
