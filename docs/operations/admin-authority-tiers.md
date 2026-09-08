# Administrator authority tiers

Authoritative contract for who can do what, and how each tier is granted.
Written before the first real administrator is enrolled; both allowlists are
currently empty.

Never write "application admin" without saying which tier is meant.

## Tiers

### ADMIN_PORTAL
**Source:** a verified, **enabled** live Firebase Auth email on `ADMIN_EMAILS`,
**or** the Firebase custom claim `admin === true`.
**Guard:** `requireAdminPortalAccess`.
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
**Guards:** `requireSystemAdminAccess` and `requireSystemAdminBearer`.

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
**Guards:** `checkAdminOnly`, `resolveGovernanceVisibleUserIds`.
**Grants:** governance-global visibility (every user's runs), governance policy
write, audit backfill, and the governance dashboard/policy presentation.

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

This does **not** change SYSTEM_ADMIN token/session semantics, which remain as
reviewed: the ADMIN_PORTAL cookie path verifies with revocation checking, while
every SYSTEM_ADMIN guard is bearer-only and relies on the ID token's short
lifetime.

**Consequence to know before enrolling anyone (Phase C5):** disabling an account
revokes EMAIL-derived authority immediately, because every such decision re-reads
the live record. It does **not** immediately revoke CLAIM-derived authority:
`verifyIdToken` is called without `checkRevoked`, so a disabled or de-claimed
SYSTEM_ADMIN keeps SYSTEM_ADMIN — including run deletion, governance-status
override and both billing-mutation routes — until their ID token expires
(≤1 hour). **For a SYSTEM_ADMIN the lever is claim revocation plus
`revokeRefreshTokens(uid)`, not disablement alone.** Put both in the incident
runbook.

### BOOTSTRAP_SECRET — not a human role
`ADMIN_SECRET` gates `/api/admin/set-admin`, which mints the first `admin: true`
claim. It authenticates **no identity at all** — possession of the secret is the
entire check. It is an exceptional bootstrap mechanism, not an administrator
tier. It fails closed when the variable is empty or unset: `adminSecret.length > 0`
is the first conjunct of the comparison, evaluated before any `timingSafeEqual`.

Whether it is *currently* empty in Production is an environment fact, not a
source fact — verify it against the live environment rather than trusting this
sentence (`vercel env ls production` (which lists variable NAMES and environments, not
values — it can show a variable is absent, but cannot show a present one is
empty; for runtime proof use the uid-less 401 probe in §B.6.c); a value of length 0 fails closed).

### Using BOOTSTRAP_SECRET to mint the first SYSTEM_ADMIN

`ADMIN_SECRET` is a bootstrap mechanism, not a standing human credential. It
authenticates no identity: possession alone mints `admin: true` on any uid, with
no audit record and no success log. Treating it as a durable operator credential
means holding, indefinitely, a value that silently grants the highest tier in the
system to anyone who obtains it.

Two ways to enroll the first SYSTEM_ADMIN. Choose ONE deliberately:

**Option 1 — out-of-band service-account script (preferred).** Call
`setCustomUserClaims(uid, { admin: true })` directly from a script authenticated
by the Firebase service account. `ADMIN_SECRET` never needs to hold a live value
for enrollment, so the bootstrap route is not part of the enrollment story at
all, and there is no post-enrollment rotation to remember.

**Option 2 — the bootstrap route.** If `/api/admin/set-admin` is used instead:

1. Set `ADMIN_SECRET` to a freshly generated value and deploy it.
2. Use it once, for the single intended uid, inside a defined bootstrap window.
3. Verify the claim landed on that uid and on no other.
4. Immediately rotate or remove `ADMIN_SECRET`, and **deploy that change** — an
   env edit alone leaves the old value live in the running deployment.
5. Verify the old value is dead **with the canonical uid-less probe in §B.6.c**.
   Send the credential ONLY:

       POST /api/admin/set-admin
       {"secret": "<OLD_SECRET>"}          <- no uid, ever

   `401` = `CREDENTIAL_REJECTED`, and it is the only result that closes the
   window. `400` = `CREDENTIAL_ACCEPTED`, meaning the rotation has not taken
   effect. `429` and `5xx` are `INCONCLUSIVE`.

   **Never send a uid in this probe.** With a uid, a still-live old secret does
   not report a failure — it mints `admin: true` on that uid, with no audit
   record and no log. The verification step would be the breach.

Neither procedure is performed by any phase that documents it; enrollment is a
separate, explicitly authorized action.

### Password admin session — ORPHANED / NON-AUTHORITATIVE
`ADMIN_PASSWORD` and the `admin_session` cookie (`/api/admin/login`,
`/api/admin/logout`) gate **no** `/api/admin/**` route at this head. Retained
untouched; do not treat it as authority.

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

Revocation is **not symmetric across the tiers**, and the difference decides what
you must do. Email-derived authority is re-derived from the live Firebase Auth
record on every request, so it stops the moment the record changes.
Claim-derived authority rides in the caller's ID token, which is verified
WITHOUT `checkRevoked`, so it persists until that token expires.

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
   found C7's own replacement table incomplete — it omitted
   `/api/admin/set-admin`, the second claim-minting path, while carrying a
   heading that asserted completeness. The table below is now enumerated from
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
   | `/api/governance/policy` GET | GOVERNANCE_ADMIN | ❌ | ✅ | — |
   | **`/api/admin/set-admin` POST** | **BOOTSTRAP_SECRET only** | ❌ **NONE** | ❌ **NONE** | **none — see §B.6** |
   | **`/api/admin/set-role` POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | — |
   | **`/api/admin/keys` GET, POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | — |
   | **`/api/admin/purge-runs` POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | — |
   | **`/api/admin/sync-subscription` POST** | SYSTEM_ADMIN | ❌ **NONE** | ❌ **NONE** | **none** (reads Stripe only) |
   | **`/api/admin/test-webhook` POST** | SYSTEM_ADMIN | ❌ **NONE** | ✅ | **none** (reads Stripe only) |
   | **`/api/admin/users/[uid]` PATCH, DELETE** | SYSTEM_ADMIN | ❌ **NONE** | ❌ **NONE** | **none** |
   | `/api/admin/users` GET | ADMIN_PORTAL | ❌ | ✅ | — |
   | `/api/admin/users/search` GET | ADMIN_PORTAL | ❌ | ❌ | none |
   | `/api/admin/users/[uid]/details` GET | ADMIN_PORTAL | ❌ | ✅ | — |
   | `/api/admin/access` GET | ADMIN_PORTAL probe | ❌ | ❌ | none |
   | `/api/admin/login` POST, `/api/admin/logout` POST | orphaned password session (§ above) | ❌ | ❌ | none |
   | `/api/governance/audit/backfill` POST | GOVERNANCE_ADMIN | ❌ **NONE** | ✅ | — |
   | `/api/governance/audit` GET | GOVERNANCE_ADMIN | ❌ | ✅ | — |
   | `/api/governance/queue` GET | GOVERNANCE_ADMIN / reviewer | ❌ | ✅ shape only | — |
   | `/api/governance/reviewer` GET, POST | plan-gated self-service | ❌ | ❌ | — |

   **`/api/governance/audit/backfill` deserves separate notice:** it is a
   privileged WRITE into `admin_audit_logs` itself (up to 400 documents), with
   no record of who ran it. When assessing whether the audit collection can be
   trusted, that route is part of the question.

   **What an absent record does and does not mean.** For every ❌ Audit row
   there is no durable application record of who acted or what was touched. For
   the rows that are ❌ in **both** columns — `set-admin`, `sync-subscription`,
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

1. `[CONTAINMENT_REMOVE_CLAIM][REQUIRED]` **Remove the claim**: `setCustomUserClaims(uid, { admin: false })` (or drop the
   key). `/api/admin/set-role` does this, but it itself requires SYSTEM_ADMIN, so
   during an incident use a service-account script rather than the route.
2. `[CONTAINMENT_REVOKE_REFRESH][REQUIRED]` **Revoke refresh tokens** — `adminAuth.revokeRefreshTokens(uid)`. Without this
   the already-issued ID token keeps working.
3. **Understand the residual window.** Every SYSTEM_ADMIN guard verifies with
   `verifyIdToken`, which does not consult revocation. Until the outstanding ID
   token expires (Firebase default one hour), a de-claimed or disabled
   SYSTEM_ADMIN retains SYSTEM_ADMIN — including run deletion, governance-status
   override and both billing-mutation routes. Disabling the account does **not**
   shorten this window on the bearer path.
4. Session cookies are a separate artifact and are verified with
   `verifySessionCookie(cookie, true)`, so revocation and disablement DO take
   effect there immediately. But no SYSTEM_ADMIN route accepts a cookie, so this
   helps only the ADMIN_PORTAL surface.
5. **A revoked-but-unexpired ID token can still be exchanged for a fresh session
   cookie.** `POST /api/auth/session` mints with `verifyIdToken` and no
   revocation check, so the cookie's own five-day life can begin AFTER the
   revocation. Treat the effective ADMIN_PORTAL window as up to one hour plus the
   cookie lifetime unless you also invalidate the session.
6. `[CONTAINMENT_ROTATE_BOOTSTRAP][REQUIRED]` **Contain the BOOTSTRAP path, or containment is not complete.** Steps 1-2
   remove the claim from one account. They do nothing about `ADMIN_SECRET`,
   which mints `admin: true` on **any uid** through `/api/admin/set-admin`
   (§ "BOOTSTRAP_SECRET — not a human role"), authenticates no identity, and
   leaves no audit record and no success log. Anyone still holding that value
   re-creates the claim immediately and invisibly, including on a fresh account
   you are not watching.

   If there is ANY possibility the secret was exposed — a compromised admin
   machine, a leaked deployment env, a shared password store, an unknown
   exfiltration scope, or simply an inability to rule it out — then:

   a. Rotate `ADMIN_SECRET` to a new value, or remove it entirely if no
      bootstrap is pending. The route fails closed on an empty or unset value,
      so removal is a valid containment state.
   b. **Deploy deliberately.** An environment variable change does not affect
      running Production until a deployment picks it up. Until then the old
      secret is still live.
   c. `[CONTAINMENT_PROBE_OLD_SECRET][REQUIRED]` **Prove the old value no longer works —
      with the canonical probe, which cannot mint a claim.**

      <!-- SAFE-PROBE:CANONICAL — the probe is an executable, not a snippet.
           Do not restate the request anywhere; reference this step. -->

          OLD_ADMIN_SECRET=<old value> node scripts/probe-admin-secret.mjs https://<host>

      `scripts/probe-admin-secret.mjs` builds its body from a single literal
      containing only the secret. It has no uid parameter and no path from
      caller input to the body, so **it cannot mint authority even if the old
      secret is still live** — the worst case is a report that containment
      failed. Earlier revisions told you to POST `{uid, secret}`; if the
      rotation had not yet deployed, that "verification" re-minted `admin: true`
      on the uid you used, with no audit record and no log. The verification
      step was the breach.

      The tool's EXIT CODE is the verdict. Do not interpret the status yourself:

      | Exit | Status | Verdict token | Meaning |
      |---|---|---|---|
      | 0 | 401 | `CREDENTIAL_REJECTED` | The old secret is refused. **Containment proven.** |
      | 2 | 400 | `CREDENTIAL_ACCEPTED` | The secret still works. **Containment FAILED.** |
      | 3 | 429 | `INCONCLUSIVE` | Rate limited before the secret was checked (see below). Not a verdict. |
      | 3 | 5xx | `INCONCLUSIVE` | Never reached a verdict. |
      | 3 | other / network | `INCONCLUSIVE` | Not a verdict. |

      **On rate limiting.** The route applies a per-IP limit of **3 attempts
      per 300 seconds (5 minutes)** before the secret is examined, so a 429
      tells you nothing about the credential. Those numbers are
      `RATE_LIMIT_MAX_REQUESTS` and `RATE_LIMIT_WINDOW_SECONDS` in
      `app/api/admin/set-admin/route.ts`, and a test fails if this paragraph and
      those constants disagree — C11 cited the names without the values, which
      made the parity check vacuous and left an on-call responder no way to know
      how long to wait without reading source. Treat that limit as **defence-in-depth only** — it is per-IP,
      so a distributed source weakens it, and until C11 it did not work at all
      (`windowStart` was stored already expired, so the counter reset on almost
      every request and nothing was ever throttled). The primary boundary is a
      high-entropy `ADMIN_SECRET`, used only for a bootstrap window, then
      rotated or removed.

      **What the per-IP limit depends on.** The key is derived from the
      `x-forwarded-for` header (`app/api/admin/set-admin/route.ts`). The
      application does **not** independently prevent header spoofing — the
      control holds because Vercel overwrites that header at the edge and does
      not forward client-supplied values, except where an Enterprise trusted
      proxy is configured. That is an operational dependency on the hosting
      layer, not a property of this code. If the deployment target changes, if a
      trusted proxy is enabled, or if the app is ever run behind a proxy that
      appends rather than replaces, the assumption must be re-validated and the
      key moved to a platform-attested client IP.

      **Only exit 0 closes the window.** Anything else means containment is
      unproven, not achieved. Wait for the rate-limit window and re-run rather
      than trying to bypass it. Behaviour pinned by
      `scripts/__tests__/probeAdminSecret.spec.ts`.

   d. (See step 8 — claim re-enumeration is unconditional, not part of this
      branch.)

7. `[CONTAINMENT_DISABLE_ACCOUNT][REQUIRED]` **Disable the affected Firebase Auth account** when the identity itself is
   compromised (as opposed to a credential leak on an otherwise trusted
   account). Be precise about what this buys, per §B.3-B.5:

   - **Existing session cookies stop working immediately.** Routes accepting a
     cookie call `verifySessionCookie(cookie, true)`, and that second argument
     performs the revocation/disabled check. That is the whole of what
     "invalidate the session" means here — there is no separate
     session-invalidation endpoint.
   - **Minting a NEW cookie is not blocked by this application.**
     `POST /api/auth/session` calls `adminAuth.verifyIdToken(idToken)` **without
     `checkRevoked`** (`app/api/auth/session/route.ts:67`) and then
     `createSessionCookie` (`:76`). A C10 revision of this runbook claimed the
     route "will refuse to mint a new cookie for a disabled account or a revoked
     token" — false, and contradicting §B.5 two paragraphs above. Assume a
     holder of a still-unexpired ID token can obtain a fresh cookie whose
     lifetime begins AFTER your revocation. Do not record the ADMIN_PORTAL
     surface as closed until that ID token has expired.
   - `verifyIdToken` is called **without** `checkRevoked` on the SYSTEM_ADMIN
     bearer path, so an already-issued ID token keeps working until it expires
     (Firebase default one hour). Disabling does **not** shorten that window.
     Do not record bearer-path cutoff as immediate.

8. `[CONTAINMENT_REENUMERATE_CLAIMS][REQUIRED]` **Re-enumerate privileged claims across all accounts — unconditionally.**
   Not only when secret exposure is suspected: step 1 removed the claim from ONE
   account, and an attacker (or the compromised identity itself) may have minted
   others before discovery, through `/api/admin/set-role` or the bootstrap
   route. Neither leaves an audit record. List every account carrying
   `admin: true` and confirm each is intended.

9. `[CONTAINMENT_VERIFY_DENIAL][REQUIRED]` **Verify denial against Production.** For the evidence review, consult the
   coverage table in §A.6 first — and note what it says about the operations a
   compromised SYSTEM_ADMIN is most likely to have used: claim minting via
   `set-role` and `set-admin`, provider credential access, and bulk purge
   produce no audit record, and `set-admin` produces no evidence at all.

**Containment is not complete while a reusable bootstrap credential can
re-create the claim you just removed.**

### What this procedure does NOT give you

Immediate, guaranteed cutoff for a claim-derived SYSTEM_ADMIN. If that matters
for a given incident, the options are to wait out the token lifetime, or to add
`checkRevoked` to the SYSTEM_ADMIN verification path — a deliberate change with
a latency and quota cost, not made here.
