# Administrator authority tiers

Authoritative contract for who can do what, and how each tier is granted.
Written before the first real administrator is enrolled; both allowlists are
currently empty.

Never write "application admin" without saying which tier is meant.

## Current enforcement: the privileged-access guard (SEC-3 / S2-b)

> **This section supersedes every statement below about which guard function
> enforces a tier, and about revocation windows on the guarded routes.** The
> older text is kept as history; where it names `requireAdminPortalAccess`,
> `requireSystemAdminAccess`, `requireSystemAdminBearer` or `checkAdminOnly`,
> read "`requirePrivilegedAccess` with that tier".

Every handler under `app/api/admin/**`, plus `POST /api/governance/policy` and
`POST /api/governance/audit/backfill`, calls
`requirePrivilegedAccess(request, TIER, { route })` (`lib/admin/privilegedAccess.ts`)
as its first statement and returns `privilegedDenialResponse` on refusal, before
any body read, Firestore read or write, Stripe call or Auth mutation. The full
handler-by-handler inventory is `docs/operations/s2b-route-inventory.md`; the tier
of each handler is pinned by `app/api/admin/__tests__/privilegedGuardPin.spec.ts`
and proven through the real handlers by
`app/api/admin/__tests__/privilegedRouteWiring.spec.ts`.

What the guard changes, stated precisely:

- **Live authorization (SP-1).** Each request makes ONE live `getUser()` read.
  SYSTEM_ADMIN is the LIVE `customClaims.admin === true`; the claim on the
  presented ID token is recorded for mismatch telemetry only. Removing the claim
  therefore denies SYSTEM_ADMIN on the next request, without waiting for the ID
  token to expire.
- **Disablement and revocation are immediate on guarded routes.** Every tier
  requires `disabled === false` on the live record, and a credential whose
  `auth_time` predates the live `tokensValidAfterTime` is refused (401). This
  applies to bearer tokens and session cookies alike, so on the guarded routes
  the "residual window" described in § B below no longer exists. It still exists
  on non-guarded surfaces (e.g. minting a session cookie at `POST /api/auth/session`).
- **Transport.** SYSTEM_ADMIN is bearer-only (a session cookie alone is 401).
  ADMIN_PORTAL and GOVERNANCE_ADMIN accept a bearer or the `__session` cookie.
  If BOTH are presented, both must verify and name the same uid, or the request
  is 401 (SP-5) — a stale cookie for a different account no longer loses
  silently to a fresh bearer.
- **Status codes.** Missing / invalid / revoked credential, disabled or deleted
  account: 401. Authenticated but not holding the tier: 403 (most of these routes
  previously answered 401). Auth verifier or lookup outage: 503 (`Retry-After: 5`).
  Body: `{ "error": "...", "reason": "<code>" }`, `Cache-Control: no-store`.
- **Governance mixed-audience routes use the guard's AUTHENTICATION, not a tier.**
  `GET /api/governance/policy` (Governance Admin OR current `full` plan),
  `GET /api/governance/audit`, `GET /api/governance/queue`,
  `POST /api/governance/review` (Governance Admin OR assigned reviewer) and
  `/api/governance/reviewer` GET/POST (full-plan self-service, no privileged
  capability) are not a single privileged tier. Since owner ruling D they
  authenticate through `authenticatePrivilegedPrincipal` (via
  `resolveGovernanceRequestUser`): the same SP-5 credential rules, one live read,
  `disabled === false`, revocation of every presented credential, and 503 on a
  verifier or lookup outage. Scope is still decided from the uid by their own
  live-record resolvers. Details: `docs/operations/s2b-route-inventory.md`.

## Tiers

### ADMIN_PORTAL
**Source:** a verified, **enabled** live Firebase Auth email on `ADMIN_EMAILS`,
**or** the Firebase custom claim `admin === true`.
**Guard:** `requirePrivilegedAccess(..., "ADMIN_PORTAL")` (was `requireAdminPortalAccess`).
**Grants:** `/api/admin/access`, `/api/admin/users` (GET), `/api/admin/runs`
(GET), `/api/admin/runs/[runId]` (**GET only**).

**What that actually reaches (stated plainly, because an earlier version of this
document understated it):** `/api/admin/users` GET returns **every** user
document, and `/api/admin/runs` returns **every** user's runs, verifications and
video verifications including owner email and question text. ADMIN_PORTAL is a
broad READ tier over customer data. It is a read/monitoring tier — not full
application administration, and since Phase C4 not a route to any destructive,
governance-changing or billing-changing action.

### SYSTEM_ADMIN
**Source:** the custom claim `admin === true` **only**. Never email-derived.
**Guard:** `requirePrivilegedAccess(..., "SYSTEM_ADMIN")` (was `requireSystemAdminAccess` and `requireSystemAdminBearer`).

Both are **bearer-only in practice**. `requireSystemAdminBearer` reads the
`Authorization` header and nothing else. `requireSystemAdminAccess` *appears* to
accept the `__session` cookie — `verifyAdminToken` falls back to it — but it then
passes that value to `verifyIdToken`, and `__session` holds a Firebase *session
cookie* minted by `createSessionCookie`, which `verifyIdToken` always rejects. So
no SYSTEM_ADMIN route is reachable by cookie. This fails closed, and the earlier
"(cookie or bearer)" wording here overstated the accepted credential.
**Grants:** `/api/admin/keys` (provider credentials), `/api/admin/set-role`
(mints `admin: true`), `/api/admin/purge-runs` (bulk delete),
`/api/admin/runs/[runId]` (**PATCH** governance-status override and **DELETE**
cross-user deletion — moved here by the C4 decision below),
`/api/admin/sync-subscription` and `/api/admin/test-webhook` (billing mutation —
also moved by that decision), `/api/admin/users/search`,
`/api/admin/users/[uid]` (PATCH/DELETE),
`.../details`, `.../override`, `.../stripe/{cancel,reactivate,sync}`.
SYSTEM_ADMIN also satisfies ADMIN_PORTAL, because the same claim satisfies that
guard.

### GOVERNANCE_ADMIN
**Source:** a verified, **enabled** live Firebase Auth email on
`GOVERNANCE_ADMIN_EMAILS` **only**.
**Guards:** `requirePrivilegedAccess(..., "GOVERNANCE_ADMIN")` for policy write and audit backfill (was `checkAdminOnly`); `resolveGovernanceVisibleUserIds` for governance-global visibility.
**Grants:** governance-global visibility (every user's runs), governance policy
write, audit backfill, and the governance dashboard/policy presentation.
**Revocation:** every GOVERNANCE_ADMIN surface checks each presented credential
against the live `tokensValidAfterTime`: policy write and audit backfill through
the tier guard, and the global reads and cross-tenant review write
(`GET /api/governance/{policy,audit,queue}`, `POST /api/governance/review`) through
the guard's authentication (owner ruling D). So `revokeRefreshTokens(uid)` or
disabling the account ends them on the next request, for cookie and bearer alike;
removing the address from `GOVERNANCE_ADMIN_EMAILS` ends global scope on the next
request (the visibility cache key carries the live decision), and a full plan held
by the same account restores only full-plan scope, never global.

**Governance policy read vs write (Step 6.0b).** `GET /api/governance/policy`
returns the full policy to a verified Governance Admin **or** a caller whose
current effective plan is `full` (the governance dashboard audience), via
`checkGovernancePolicyReadAccess`. Both conditions are derived server-side from
the caller's uid; client eligibility flags, Firestore role strings and
request-supplied identity are never consulted. Free and Lite callers receive 403
before the policy is loaded; an entitlement lookup failure returns 503. Policy
**write** (`POST`) remains Governance Admin only (`checkAdminOnly`).

### Disabled accounts hold no email-derived authority (Phase C4)

Both email-derived scopes require ALL of: the live `getUser(uid)` lookup
succeeds; `disabled === false`; `emailVerified === true`; the address passes the
ASCII privileged boundary; and the canonical address is on that scope's list.
All of it comes from ONE live Auth record.

`getUser()` returns a record for a disabled account without throwing, so before
C4 disabling a compromised administrator did not remove their allowlist-derived
authority. The requirement is written `disabled === false`, not `!disabled`, so
a missing or non-boolean value denies. A failed lookup reports `disabled: true`
and grants nothing.

This does **not** change how credentials are accepted: the ADMIN_PORTAL cookie
path verifies with revocation checking, and every SYSTEM_ADMIN capability is
bearer-only. Since S2-b (PR #319, Production 2026-11-16) the privileged-access
guard decides each request from the live Auth record, not from the claim
embedded in the ID token.

**Consequence to know before enrolling anyone (Phase C5, updated for S2-b):**
every decision on the S2-b-guarded routes (`requirePrivilegedAccess`) re-reads
the live Auth record, for email-derived and claim-derived authority alike. Once
Firebase Auth reflects the change, a subsequent guarded request is refused for
a disabled account (401 `account_disabled`), for an account without the live
`admin` claim on a SYSTEM_ADMIN route (403), and for a credential whose
`auth_time` is earlier than the live `tokensValidAfterTime` (401
`credential_revoked`). An already-issued ID token is not invalidated by any of
this and may still carry `admin: true` until it expires; surfaces outside the
S2-b guard coverage are not claimed to apply the same checks. Claim removal and
`revokeRefreshTokens(uid)` are separate operations: for a SYSTEM_ADMIN use the
claim tool, which removes the claim and requests revocation, and treat
disablement as a further step. `revokeRefreshTokens` affects only
revocation-checked paths, only for sessions whose `auth_time` is earlier than
the stamped `validSince`, and a later call from a slower clock can lower that
value again. Put all of this in the incident runbook.

### Secret bootstrap route — RETIRED (S1)

The former bootstrap mechanism, `BOOTSTRAP_SECRET` (the `ADMIN_SECRET` variable on
the `POST /api/admin/set-admin` route), is retired. It was never a human role:
possession of the secret was the entire check, it authenticated no identity, and
it left no audit record and no success log.

- **The route is deleted.** `app/api/admin/set-admin/route.ts` no longer exists,
  so a deployment built from this code answers `404` for that path. The tests in
  `app/api/admin/__tests__/setAdminRouteRetired.spec.ts` keep it absent.
- **No source reads the variable.** No non-test file reads `ADMIN_SECRET` or
  `BOOTSTRAP_SECRET`, and `.env.local.example` no longer lists it. Setting the
  variable has no effect on a current deployment.
- **Its probe is deleted too.** The two-phase containment tool and its
  rotation procedure existed only for that route, and are removed with it.
- **Do not restore either.** Do not re-add `ADMIN_SECRET` to any environment and
  do not restore the route. This is a settled owner decision (SP-8).
- **Historical deployments are not covered by this.** A deployment built before
  S1 still ships the retired route. Retiring those deployments, including the
  stable alias that still points at one, is separate work (security step SEC-7).
  Never send a uid or a secret to the retired route on any deployment. The only
  post-deploy check is a signed-out `GET` of that path on current Production, by
  the owner or under an authorized probe, which must return `404`.

### Changing the `admin` claim — the SYSTEM_ADMIN claim operator tool

The only documented path for a change to the `admin` custom claim (granting it to
a new SYSTEM_ADMIN, or removing it from a compromised one) is the SYSTEM_ADMIN
claim operator tool `scripts/admin/set-system-admin-claim.ts`
(`npm run admin:set-system-admin-claim`), which is part of this repository. Its
logic is `lib/admin/systemAdminClaimSafety.ts` and
`lib/admin/systemAdminClaimExecution.ts`; its runbook — CLI, exit codes, retry
and review rules — is `docs/operations/system-admin-claim-script.md`. This is a
written procedure; nothing in this document runs it. The Firebase Console has no
control for custom claims or refresh-token revocation, so "do it in the Console"
is not a path (owner ruling, OPTION B, 2026-11-09).

**What the tool does and does not observe.** Run
`scripts/admin/set-system-admin-claim.ts` (`npm run admin:set-system-admin-claim`)
with an explicitly named service-account key file. It is a dry run unless given
`--execute` plus an exact typed confirmation, preserves every other custom
claim, refuses to GRANT to a disabled account (a revoke is allowed on one and
never re-enables it), and writes create-only `admin_audit_logs`
attempt/outcome rows. Every executed revoke requests revocation of the
target's refresh tokens (owner policy), unless a fresh read immediately before
the call shows the stored `tokensValidAfterTime` is later than the value the
call would write (then no call, exit 4 `stored_cutoff_ahead`, review
required). That request can fail or throw (`sessions_revoke_failed`, exit 3;
a thrown call is an unknown outcome — re-run the same command). Before any
claim write the tool also checks the operator clock against Firestore's
commit time of the attempt row (2 s margin; otherwise exit 3
`operator_clock_out_of_tolerance`, nothing changed). The tool reports exit 0
only when Firebase acknowledged the revocation call AND the read-back
`tokensValidAfterTime` is at or after a cutoff anchored on a Firestore server
commit time taken after the claim removal AND is not lower than the values
read earlier in the run. That is an observation, not proof of revocation: it
ASSUMES the Firestore and Firebase Auth clocks differ by less than a 2 s
margin, a bound Google does not publish, and effective revocation is never
observable by the tool (`effectiveRevocation: "not_observable"`). Current
privileges are a separate question from the tool's evidence: an
already-issued ID token may still carry `admin: true` until it expires or is
refreshed, but since S2-b the guarded server routes do not use that embedded
claim as the authority decision; once Firebase Auth reflects the change, a
subsequent guarded request is evaluated against the live claim, the live
disabled state and the live `tokensValidAfterTime` cutoff. The tool does not
observe that request-time enforcement. The cutoff is overwrite-only: `revokeRefreshTokens` overwrites
`validSince` with the operator's clock and Firebase Auth offers no
compare-and-set, so any caller can lower it. This tool refuses to write a
value lower than the one it reads immediately before the call, and reports any
lowering it observes within its own run (`tokensValidAfterTimeLowerThanBefore`,
exit 4 `revocation_cutoff_lowered`, never a clean success); a lowering by
another writer outside the run is not detected. Runbook, CLI, exit codes and retry:
`docs/operations/system-admin-claim-script.md`.

**Procedure.**

1. **Who and where.** A change to the `admin` custom claim is an **owner action,
   run locally with the reviewed SYSTEM_ADMIN claim operator tool**. It is never
   an agent action.
2. **Local checkout of `main`, clean, recorded.** Run the tool from a local
   checkout of `main` and nothing else, and record
   `git -C <checkout> rev-parse HEAD` before any command is typed; the tool
   records the same commit SHA in its audit rows. It runs on the owner's
   machine, never from Vercel or any deployment — the tool refuses when
   `VERCEL`, `VERCEL_ENV` or `NEXT_RUNTIME` is set, when `NODE_ENV=production`,
   or when an Auth/Firestore emulator host variable is set — and `--execute`
   refuses while `scripts/admin` or `lib/admin` has uncommitted changes.
3. **Explicit project and UID; no defaults.** `--confirm-project=<projectId>`,
   `--credentials=<service-account key file, mode 0600>` (its `project_id` must
   equal the confirmed project; the tool never reads `.env.local` or credential
   environment variables), `--target-uid=<uid>` and `--operation=grant|revoke`
   (`--allow-claim-reduction` is required with revoke). Nothing is defaulted.
4. **Dry run first, then typed confirmation.** Without `--execute` the tool
   resolves the target, prints the current claims, the intended claims, the
   per-key diff and the exact confirmation string, and writes nothing to Firebase. Only then
   run it again with `--execute --confirm-claim=<exact string printed by the dry
   run>` and `--operator-id-token-file=<file>` (mode 0600; the ID token of a
   SYSTEM_ADMIN's own session in the same project), or `--bootstrap-first-admin`
   only while zero accounts hold `admin === true`. Change only the `admin` key:
   grant writes `{ ...existing, admin: true }`, revoke removes only the `admin`
   key, and the tool refuses a run that would alter any other claim. An
   executed revoke requests refresh-token revocation unless the fresh read
   immediately before the call shows a stored cutoff ahead of this clock (exit
   4, no call) or that read fails or is unusable (exit 3, no call); the request
   itself can fail, so confirm `revocationRequested` in the result file.
5. **Keep the evidence.** The tool's audit rows plus
   `--result-file=<NEW *.json path outside every git checkout>`; keep that file
   outside the repository. Every revoke audit row records
   `effectiveRevocation: "not_observable"`.
6. **Read the exit code; an incomplete run is not a no-op.** `0` completed; on a
   revoke that is an observation under the clock assumption above, not proof of
   revocation. `2` refused or dry run: no Firebase write call was issued. `3` a
   write call was issued (possibly only the attempt audit row) and the operation
   is incomplete: re-run the same command from a synced clock (NTP), knowing
   that a revoke re-run calls `revokeRefreshTokens` again, which overwrites
   `validSince`. `4` review required: do not re-run blindly; follow the
   runbook's review guidance. `1` the result file could not be written after an
   otherwise exit-0 run. Precedence is 3 > 4 > 0. Record every non-zero exit
   with its result file and audit rows before deciding the next step.
7. **No Production execution without separate authorization.** Each Production
   grant or revoke needs its own explicit owner authorization naming the
   operation, the project and the UID. This document authorizes no run by itself.
8. **Verify read-only.** Confirm the result with
   `scripts/check-admin-claims.js` or `scripts/verify-admin-claims.js`. Both call
   `getUser` and print the claims; neither writes anything.
9. **The account signs out and back in** before a new claim appears in its ID
   token.

**Current privileges after a removal (S2-b, live since 2026-11-16).** Removing
the claim and requesting refresh-token revocation do not invalidate an
already-issued ID token; it may still carry `admin: true` until it expires or
is refreshed. The S2-b-guarded server routes do not rely on that embedded
claim: once Firebase Auth reflects the change, a subsequent guarded request is
evaluated against the live `admin` claim, the live `disabled` state and the
live `tokensValidAfterTime`, so a request without the live claim is refused
(403) and a credential whose `auth_time` is earlier than the cutoff is refused
(401). Surfaces outside the S2-b guard coverage are not claimed to apply the
same checks. The incident sequence in §B below states the consequences.

**The legacy minting scripts were removed and must never be restored:**
`scripts/setAdmin.ts`, `scripts/set-admin-simple.js`, `scripts/set-admin-by-uid.js`
and `scripts/set-admin-claim.js`. Each wrote the account's whole custom-claim
object without the tool's safeguards: two of them dropped every other claim, and
two let an existing `admin` value silently override the grant. PR #295 deleted
them (S1 had scheduled that deletion for security slice S5), and
`docs/__tests__/bootstrapProbeInvariant.spec.ts` keeps them absent. Do not re-add
them, and do not add any other script that calls `setCustomUserClaims`.

**History: the S1 interim path (PR #299).** Before PR #295 merged, the tool
existed only on branch `fix/admin-claim-script-hardening`, so the S1 slice
(PR #299) documented an interim path: the owner ran the tool locally from a
checkout of its exact reviewed commit `f6039ea`
(`git -C <checkout> rev-parse HEAD` had to print
`f6039eaecb659159f52019b7f4cff4cce6a4ed89`), under the same owner-only, dry-run,
typed-confirmation, project/UID, evidence and Production-authorization rules as
the procedure above. The legacy minting scripts were kept during that period
only with DO NOT USE headers. The interim text also described #295's merge as
gated on S2. The merge of PR #295 replaced that interim path with this section;
`lib/admin/systemAdminClaimSafety.ts` and `lib/admin/systemAdminClaimExecution.ts`
merged byte-identical to `f6039ea`. This paragraph is history, not an
instruction.

> **CURRENT STATE (2026-09-09): no first-admin enrollment is pending.** Production
> already has **two intended SYSTEM_ADMIN accounts**, both claim-derived
> (`admin === true`) and both dispositioned INTENDED_KEEP by the operator. They do
> not need `ADMIN_EMAILS`, because SYSTEM_ADMIN already implies ADMIN_PORTAL access.
> `GOVERNANCE_ADMIN_EMAILS` remains absent unless governance authority is separately
> requested.
>
> Earlier phases of this workstream described the state as "nobody enrolled". That
> was true of the ALLOWLISTS and was never true of the claim; it was corrected when
> Production custom claims were first enumerated.

### Password admin session — REMOVED (R-25)
The legacy `ADMIN_PASSWORD` flow (`/api/admin/login`, `/api/admin/logout`,
`/admin/login`, `lib/adminAuth.ts`) never gated any `/api/admin/**` route and
was removed: it generated a 7-day session secret and used it directly as the
Firestore document ID `admin_sessions/{secret}`, which Firestore Data Access
audit logging could retain. `docs/__tests__/r25LegacyAdminSessionRemoved.spec.ts`
keeps it removed. Production cleanup (leftover `admin_sessions` documents, the
`expiresAt` TTL override — also tracked in `firestore.indexes.json`, so any
indexes deploy re-asserts it until that entry is removed — the `ADMIN_PASSWORD` env var) and removal of the
unused Prisma `AdminSession` model (needs a migration) are separate and gated.

## The rules that matter

- `ADMIN_EMAILS` does **NOT** create SYSTEM_ADMIN.
- `ADMIN_EMAILS` does **NOT** create GOVERNANCE_ADMIN.
- `GOVERNANCE_ADMIN_EMAILS` does **NOT** create ADMIN_PORTAL or SYSTEM_ADMIN.
- `admin: true` creates SYSTEM_ADMIN and therefore ADMIN_PORTAL, but does **NOT**
  create GOVERNANCE_ADMIN.
- Email-derived authority requires the **live** Firebase Auth record with
  `emailVerified === true`. A Firestore profile email, a token email, or a stale
  session claim can never grant it.
- Email-derived authority is **ASCII-only**. A non-ASCII identity is rejected
  before normalization, so a compatibility-folded address cannot collapse onto an
  allowlisted one.
- `role: "admin"` in `/api/user/usage` is **legacy presentation compatibility**.
  It is emitted for either privileged scope, carries no tier, and must never be
  used to authorize anything.

## Enrollment requests

The runbook may request exactly one of:

| Request | Action |
|---|---|
| `ADMIN_PORTAL_ONLY` | add to `ADMIN_EMAILS` |
| `GOVERNANCE_ADMIN_ONLY` | add to `GOVERNANCE_ADMIN_EMAILS` |
| `ADMIN_PORTAL_PLUS_GOVERNANCE` | add to both |
| `SYSTEM_ADMIN` | set the `admin: true` custom claim — an explicit claim mutation, never inferred from an allowlist |
| `SYSTEM_ADMIN_PLUS_GOVERNANCE` | claim **and** `GOVERNANCE_ADMIN_EMAILS` |

Every path requires proven mailbox ownership first (`emailVerified: true` on the
live record, via the deployed signup/resend flow).

## Operational rule for any allowlist change

Both allowlists are read per call at this head. Even so: **after any change to
either list, redeploy Production deliberately and prove the new deployment
consumed the intended configuration.** That is procedural determinism, so
enrollment and rollback are never ambiguous — not a claim that one list is
import-cached.

---

## FIRST_ADMIN_ENROLLMENT_BLOCKER_DECISION — **RESOLVED 2026-09-07**

**Decision: all four surfaces below require SYSTEM_ADMIN.** Implemented in Phase
FIRST-ADMIN-C4.

| Route | Method | Was | Now | Why |
|---|---|---|---|---|
| `/api/admin/runs/[runId]` | `DELETE` | ADMIN_PORTAL | **SYSTEM_ADMIN** | Permanently deletes another user's run / verification / video-verification document. Destructive cross-user mutation. |
| `/api/admin/runs/[runId]` | `PATCH` | ADMIN_PORTAL | **SYSTEM_ADMIN** | Writes `set_governance_status` on another user's run. A governance mutation, not a read/monitoring capability. |
| `/api/admin/sync-subscription` | `POST` | ADMIN_PORTAL | **SYSTEM_ADMIN** | Mutates billing/subscription state. |
| `/api/admin/test-webhook` | `POST` | ADMIN_PORTAL | **SYSTEM_ADMIN** | Re-runs `handleSubscriptionChange`, exercising billing mutation for an arbitrary subscription. |

**Rationale.** ADMIN_PORTAL is the lower operational/read tier. It must not be a
route to destructive, governance-changing or billing-changing actions. Leaving
these at ADMIN_PORTAL would also have contradicted this document's own rule that
`ADMIN_EMAILS` confers no governance authority, since the `PATCH` handler writes
governance status.

**Deliberately NOT retiered:** `GET /api/admin/runs`, `GET /api/admin/users`,
`GET /api/admin/access`, and `GET /api/admin/runs/[runId]`. These are the
portal's read/monitoring purpose. Their reach is documented honestly under
ADMIN_PORTAL above rather than moved for symmetry.

**Correction of record.** The earlier version of this note argued the inversion
by claiming an `ADMIN_EMAILS` administrator "may not preview a user list". That
was **false**: `/api/admin/users` GET is portal-tier and returns every user
document. The real inversion was narrower and is now moot — the destructive and
billing surfaces have moved, while `/api/admin/users/search` remains
SYSTEM_ADMIN, which is merely conservative rather than inconsistent.

**This item no longer blocks first-admin enrollment** once C4 is independently
reviewed and deployed.

---

## Incident procedure: a compromised or departing privileged identity

Two things must be kept apart, and the difference decides what you must do:
the authority DECISION and the CREDENTIAL. Since S2-b, the guarded server
routes re-derive both email-derived and claim-derived authority from the live
Firebase Auth record on every request: the live `admin` claim, the live
`disabled` state and the live `tokensValidAfterTime`. The credential is a
different matter: an already-issued ID token is not invalidated and may still
carry `admin: true` until it expires, and surfaces outside the S2-b guard
coverage are not claimed to apply the same checks.

**This repository performs no runtime revocation call.** `revokeRefreshTokens`
is not invoked anywhere in application code, deliberately: it belongs in an
operator procedure, not on a hot request path. The steps below are what an
operator does; they are not automated.

### A. ADMIN_PORTAL or GOVERNANCE_ADMIN (email-derived)

1. **Disable the Firebase Auth user.** This is the fastest lever: every
   email-derived decision re-reads the live record and `disabled === true` denies
   immediately — application admin, governance admin, and the ordinary governance
   reviewer path alike. The governance visibility cache keys on enabled-state, so
   a cached grant is not reused either.
2. Remove the address from `ADMIN_EMAILS` / `GOVERNANCE_ADMIN_EMAILS`.
3. **Redeploy Production deliberately** and prove which deployment consumed the
   new configuration.
4. Revoke refresh tokens for the uid if the account is to remain usable but
   unprivileged (`adminAuth.revokeRefreshTokens(uid)` via a service-account
   context — an operator action, run out of band).
5. Verify denial against Production: the tier probe `GET /api/admin/access`
   should report `adminPortal: false, systemAdmin: false`, and a governance route
   should refuse.
6. **Review the evidence — and know what does not exist.** Application audit
   coverage is partial. C7 corrected an earlier claim that `writeAuditEvent`
   covered the SYSTEM_ADMIN mutation handlers generally; the C7-R4 review then
   found C7's own replacement table incomplete — it omitted the secret
   bootstrap route (the second claim-minting path, since retired in S1), while
   carrying a heading that asserted completeness. The table below is now enumerated from
   the filesystem and **held complete by a test**
   (`docs/__tests__/adminAuthorityEvidenceTable.spec.ts`). Stated precisely,
   because C8 claimed more than it enforced: the test walks
   `app/api/admin/**/route.ts` and `app/api/governance/**/route.ts` and requires
   every such file to appear here, **with every HTTP method it exports** —
   GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, declared either as
   `export [async] function METHOD` or as `export const|let|var METHOD =`.
   A method exported indirectly (`export { handler as DELETE }`) is NOT
   detected; no route uses that form, and it stays a review responsibility
   rather than a mechanical one. A
   privileged route added under either tree in a `route.ts` therefore cannot be
   omitted, and neither can one of its methods. It does NOT cover a `route.tsx`,
   nor any privileged handler placed outside those two trees — those remain a
   review responsibility, not a mechanical one.

   Three columns, because they fail differently. **Audit** is a durable record
   in an access-controlled collection. **Success log** is a runtime log line on
   the SUCCESS path — subject to the platform's retention window, and readable
   by anyone with log access. **Other** is durable evidence outside this
   application.

   The classification rules, stated because C8 got five cells wrong by not
   having them. The C8-R5 review found the errors; all five were in the
   dangerous direction — claiming evidence that does not exist:

   - **Error-only logging is not a success log.** A `console.error` in a catch
     block, or a `logger.warn` on a path that returns 404, tells you nothing
     about a successful privileged action. `/api/admin/runs` GET and
     `/api/admin/runs/[runId]` GET were marked ✅ on exactly that basis; their
     success returns are silent, and they are the two broadest cross-user read
     routes in the product.
   - **Calling a provider API is not external evidence.** A `retrieve` or a
     `list` is a read: it changes nothing at the provider and leaves no event in
     the provider's own history. Only a write (`create`, `update`, `cancel`)
     does. `sync-subscription`, `test-webhook` and `stripe/sync` were credited
     with "Stripe events" and perform reads only; `stripe/cancel` and
     `stripe/reactivate` genuinely call `cancel`/`update` and keep the credit.
   - **Evidence must be something actually emitted or persisted**, verified by
     reading the handler's success path — never inferred from the route's name
     or purpose, and never from a count of logging calls in the file.

   | Route (method) | Authority | Audit | Success log | Other evidence |
   |---|---|---|---|---|
   | `/api/admin/runs/[runId]` PATCH | SYSTEM_ADMIN | ✅ `writeAuditEvent` | ✅ | — |
   | `/api/admin/runs/[runId]` DELETE | SYSTEM_ADMIN | ✅ `writeAuditEvent` | ✅ | — |
   | `/api/admin/runs/[runId]` GET | ADMIN_PORTAL | ❌ | ❌ **NONE** | none |
   | `/api/admin/runs` GET | ADMIN_PORTAL | ❌ | ❌ **NONE** | none |
   | `/api/admin/users/[uid]/override` POST, DELETE | SYSTEM_ADMIN | ✅ `writeAuditLog` | ❌ | — |
   | `/api/admin/users/[uid]/stripe/cancel` POST | SYSTEM_ADMIN | ✅ `writeAuditLog` | ❌ | Stripe events |
   | `/api/admin/users/[uid]/stripe/reactivate` POST | SYSTEM_ADMIN | ✅ `writeAuditLog` | ❌ | Stripe events |
   | `/api/admin/users/[uid]/stripe/sync` POST | SYSTEM_ADMIN | ✅ `writeAuditLog` | ❌ | **none** (reads Stripe only) |
   | `/api/governance/review` POST | GOVERNANCE_ADMIN / reviewer | ✅ `writeAuditEvent` | ✅ shape only | run's `governanceEvents` |
   | `/api/governance/policy` POST | GOVERNANCE_ADMIN | ✅ `writeAuditEvent` | ✅ | — |
   | `/api/governance/policy` GET | GOVERNANCE_ADMIN or current `full` plan (Step 6.0b) | ❌ | ✅ | — |
   | **`/api/admin/set-role` POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | — |
   | **`/api/admin/keys` GET, POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | — |
   | **`/api/admin/purge-runs` POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | — |
   | **`/api/admin/sync-subscription` POST** | SYSTEM_ADMIN | ❌ **NONE** | ❌ **NONE** | **none** (reads Stripe only) |
   | **`/api/admin/test-webhook` POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | **none** (reads Stripe only) |
   | **`/api/admin/users/[uid]` PATCH, DELETE** | SYSTEM_ADMIN | ❌ **NONE** | ❌ **NONE** | **none** |
   | `/api/admin/users` GET | ADMIN_PORTAL | ❌ | ✅ | — |
   | `/api/admin/users/search` GET | SYSTEM_ADMIN | ❌ | ❌ | none |
   | `/api/admin/users/[uid]/details` GET | SYSTEM_ADMIN | ❌ | ✅ | — |
   | `/api/admin/access` GET | ADMIN_PORTAL probe | ❌ | ❌ | none |
   | `/api/governance/audit/backfill` POST | GOVERNANCE_ADMIN | ❌ **NONE** | ✅ | — |
   | `/api/governance/audit` GET | GOVERNANCE_ADMIN | ❌ | ✅ | — |
   | `/api/governance/queue` GET | GOVERNANCE_ADMIN / reviewer | ❌ | ✅ shape only | — |
   | `/api/governance/reviewer` GET, POST | plan-gated self-service | ❌ | ❌ | — |

   **The retired secret bootstrap route is not in this table** because it no
   longer exists in current code (S1). On a historical deployment that still
   ships it, it produced no audit record and no success log, so its use there
   cannot be ruled out from application evidence.

   **`/api/governance/audit/backfill` deserves separate notice:** it is a
   privileged WRITE into `admin_audit_logs` itself (up to 400 documents), with
   no record of who ran it. When assessing whether the audit collection can be
   trusted, that route is part of the question.

   **What an absent record does and does not mean.** For every ❌ Audit row
   there is no durable application record of who acted or what was touched. For
   the rows that are ❌ in **both** columns — `sync-subscription`,
   `users/[uid]` PATCH/DELETE (account disable and permanent deletion),
   `users/search`, `access`, `login`/`logout` — the application produces **no
   evidence of any kind on success**. An earlier version of this section told
   responders to fall back on runtime logs; for those rows there is nothing to
   fall back to, and following that advice would reproduce exactly the false
   inference this paragraph exists to prevent.

   **A ✅ in any column is a claim about this codebase that can be wrong, and
   five of them were.** If you consult a ✅ cell and find nothing, do not
   conclude the operation did not occur — re-read the handler's success path
   first, then treat the row as ❌ until proven otherwise. The warning below
   applies to every row, not only the ones currently marked ❌.

   So: **absence of a record is not evidence that the operation did not
   happen.** Do not tell a stakeholder that activity "was reviewed and nothing
   was found" on the basis of the audit collection, or of the logs, for any row
   above that is ❌ for the column you consulted. Where "Other evidence" names
   Stripe, that provider's own event history is authoritative and independent of
   this application. Where it says "none", state plainly in the incident record
   that the question cannot be answered from available evidence.

   Note also that a ✅ means the handler *attempts* the write:
   `writeAuditEvent` and `writeAuditLog` both return silently when Firestore is
   unavailable and swallow their own errors, and the mutation proceeds
   regardless. A ✅ row with no matching record is possible.

   Closing these gaps is separate work. C7 and C8 corrected the description
   only, and deliberately added no audit infrastructure.

### B. SYSTEM_ADMIN (claim-derived) — disabling is NOT sufficient

**Normative obligations.** The `Mode` column is the machine-checked signal; the
prose under each step may be reworded freely, and a step whose Mode is `MUST` is
required regardless of how its paragraph reads. An earlier revision tried to
enforce obligation by blacklisting hedging phrases ("optional", "if convenient",
…); that is not mechanically achievable, because any synonym walks past it. The
table is the contract.

| ID | Requirement | Mode |
|---|---|---|
| `CONTAINMENT_REMOVE_CLAIM` | Remove `admin: true` from the affected account | MUST |
| `CONTAINMENT_REVOKE_REFRESH` | Revoke refresh tokens | MUST |
| `CONTAINMENT_HISTORICAL_BOOTSTRAP` | Treat pre-S1 deployments that still ship the retired bootstrap route as in scope | MUST |
| `CONTAINMENT_DISABLE_ACCOUNT` | Disable the affected Firebase Auth account when the identity is compromised | MUST |
| `CONTAINMENT_REENUMERATE_CLAIMS` | Re-enumerate privileged claims across all accounts | MUST |
| `CONTAINMENT_VERIFY_DENIAL` | Verify denial against Production | MUST |


1. `[CONTAINMENT_REMOVE_CLAIM][REQUIRED]` **Remove the claim**: the effect is `setCustomUserClaims(uid, { admin: false })` (or
   dropping the key, with every other claim left in place). `/api/admin/set-role`
   does this, but it itself requires SYSTEM_ADMIN, so during an incident use the
   admin-claim procedure above (the SYSTEM_ADMIN claim operator tool
   `scripts/admin/set-system-admin-claim.ts`, run locally by the owner as a dry
   run and then a typed confirmation; a Production revoke needs its own separate
   authorization), not the route and never a removed legacy minting script.
2. `[CONTAINMENT_REVOKE_REFRESH][REQUIRED]` **Revoke refresh tokens** — `adminAuth.revokeRefreshTokens(uid)`. Without this
   the account's sessions can keep refreshing. With it — and only if Firebase
   applied the request — revocation-checked session cookies (and, assumed, the
   refresh-token exchange) reject sessions whose `auth_time` is earlier than
   the `validSince` it stamps from the operator's clock. It does NOT invalidate
   an already-issued ID token on the bearer path (step 3). It overwrites the
   stored `validSince` rather than keeping the later value, so a repeated call
   from a slower clock can LOWER it again: sync the operator clock (NTP) before
   every call.
   An executed revoke through the operator tool requests this itself (no
   opt-out flag) unless its pre-call fresh read shows a stored cutoff ahead or
   is unusable (exit 4 or 3, no call), and the request can fail; confirm
   `revocationRequested` in the tool's result file before relying on it.
3. **Understand what the next guarded request sees (S2-b).** Every SYSTEM_ADMIN
   capability — including run deletion, governance-status override and both
   billing-mutation routes — sits behind `requirePrivilegedAccess`. Once
   Firebase Auth reflects the change, a subsequent guarded request is refused
   without the live `admin` claim (403), for a disabled account (401
   `account_disabled`) and for a credential whose `auth_time` is earlier than
   the live `tokensValidAfterTime` (401 `credential_revoked`). A request already
   in progress is not interrupted. The outstanding ID token itself is not
   invalidated and may still carry `admin: true` until it expires (Firebase
   default one hour); do not record that as a cut-off of the token.
4. Session cookies are a separate artifact and are verified with
   `verifySessionCookie(cookie, true)`, so disablement takes effect there on
   the next request, and so does an applied revocation — but only for a cookie
   whose session `auth_time` is earlier than the stored `validSince`. But no
   SYSTEM_ADMIN route accepts a cookie, so this helps only the ADMIN_PORTAL
   surface.
5. **Minting a fresh session cookie is refused for a revoked or disabled
   identity (SESSREV).** `POST /api/auth/session` verifies the ID token with
   `verifyIdToken(idToken, true)` before `createSessionCookie`, so the SDK's
   live `getUser` read rejects a disabled account (`auth/user-disabled`) and a
   token whose `auth_time` is earlier than the stored `validSince`
   (`auth/id-token-revoked`) — both 401, no cookie. A failure of that live read
   itself is 503, also no cookie. On a deployment built BEFORE SESSREV the
   route verified without `checkRevoked`, and the SDK's `createSessionCookie`
   performs no live-record check of its own, so such a deployment mints a
   cookie for a still-unexpired ID token of a revoked or disabled identity.
   That cookie carries the ID token's `auth_time` (Firebase: the session cookie
   has the same claims as the ID token — documented behaviour, not locally
   observed against the live backend), so the revocation-checked verifiers in
   4. reject it on every request while the revocation stands or the account is
   disabled; if a disabled-but-not-revoked account is later re-enabled, such a
   cookie becomes usable for the rest of its five-day life. Pair a disablement
   with a revocation when containing an identity.
6. `[CONTAINMENT_HISTORICAL_BOOTSTRAP][REQUIRED]` **Treat historical deployments as in scope.** Current code has no
   secret bootstrap route (§ "Secret bootstrap route — RETIRED (S1)"), so on a
   current deployment nothing re-creates the claim you removed in step 1 without
   SYSTEM_ADMIN. A deployment built before S1 is different: it still ships the
   retired route, which minted `admin: true` on any uid from possession of a
   secret, with no audit record and no success log. Record in the incident which
   historical deployments remain reachable and whether their retirement
   (security step SEC-7) is complete. Do not re-add the secret, do not restore the
   route, and never send a uid or a secret to it on any deployment.
7. `[CONTAINMENT_DISABLE_ACCOUNT][REQUIRED]` **Disable the affected Firebase Auth account** when the identity itself is
   compromised (as opposed to a credential leak on an otherwise trusted
   account). Be precise about what this buys, per §B.3-B.5:

   - **Existing session cookies of the disabled account stop working on their
     next request.** Routes accepting a cookie call
     `verifySessionCookie(cookie, true)`, and that second argument performs the
     disabled check (as well as the revocation check). That is the whole of what
     "invalidate the session" means here — there is no separate
     session-invalidation endpoint.
   - **Minting a NEW cookie is refused for the disabled account (SESSREV).**
     `POST /api/auth/session` calls `adminAuth.verifyIdToken(idToken, true)`
     **with `checkRevoked`** before `createSessionCookie`, so a disabled
     account (or a revoked token) gets 401 and no cookie; an outage of the
     live read is 503 and no cookie. History: before SESSREV the route verified
     WITHOUT `checkRevoked`, and a C10 revision of this runbook wrongly claimed
     it already refused; on a deployment that predates SESSREV, assume a holder
     of a still-unexpired ID token can obtain a cookie (rejected by the
     revocation-checked verifiers while the account stays disabled or the
     revocation stands — §B.5). This closes the MINT only: the already-issued
     ID token is not invalidated and stays a valid bearer credential on any
     surface that verifies ID tokens without `checkRevoked` until it expires.
     Do not record the ADMIN_PORTAL surface as closed until that ID token has
     expired.
   - On the S2-b-guarded routes the disabled state is read live, so a
     subsequent request from the disabled account is refused (401
     `account_disabled`) whether it carries a bearer token or a cookie. The
     already-issued ID token is not invalidated and may still carry
     `admin: true` until it expires; surfaces outside the S2-b guard coverage
     are not claimed to check the disabled state the same way.

8. `[CONTAINMENT_REENUMERATE_CLAIMS][REQUIRED]` **Re-enumerate privileged claims across all accounts — unconditionally.**
   Not only when secret exposure is suspected: step 1 removed the claim from ONE
   account, and an attacker (or the compromised identity itself) may have minted
   others before discovery, through `/api/admin/set-role` or, on a historical
   deployment, the retired bootstrap route. Neither leaves an audit record. List
   every account carrying `admin: true` and confirm each is intended, using the
   read-only `scripts/check-admin-claims.js` / `scripts/verify-admin-claims.js`
   per account.

9. `[CONTAINMENT_VERIFY_DENIAL][REQUIRED]` **Verify denial against Production.** For the evidence review, consult the
   coverage table in §A.6 first — and note what it says about the operations a
   compromised SYSTEM_ADMIN is most likely to have used: claim minting via
   `set-role`, provider credential access, and bulk purge produce no audit
   record, and the retired bootstrap route produced no evidence at all.

### What this procedure does NOT give you

No invalidation of an already-issued ID token, and no observation of effective
revocation. Removing the claim and requesting `revokeRefreshTokens` leave an
already-issued ID token cryptographically valid until it expires (up to about an
hour). Since S2-b the guarded server routes do not use its embedded claim as the
authority decision, but surfaces outside the S2-b guard coverage are not claimed
to apply the same checks, and the operator tool does not observe request-time
enforcement. Even on revocation-checked paths the request covers only sessions
whose `auth_time` is earlier than the stamped `validSince`, under an unproven
Firestore/Auth clock assumption, and a later request from a slower clock can
lower that value and stop the check from rejecting sessions an earlier revoke
had excluded.
