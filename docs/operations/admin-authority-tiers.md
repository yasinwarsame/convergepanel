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
sentence (`vercel env ls production`; a value of length 0 fails closed).

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
   coverage is partial, and an earlier version of this runbook overstated it.
   Verified against every production call site:

   | Privileged operation | Route | Application audit record? |
   |---|---|---|
   | Run governance-status override | `/api/admin/runs/[runId]` PATCH | ✅ `writeAuditEvent` |
   | Run deletion (cross-user) | `/api/admin/runs/[runId]` DELETE | ✅ `writeAuditEvent` |
   | Plan override set/clear | `/api/admin/users/[uid]/override` | ✅ `writeAuditLog` |
   | Stripe cancel / reactivate / sync | `/api/admin/users/[uid]/stripe/*` | ✅ `writeAuditLog` |
   | Governance review decision | `/api/governance/review` | ✅ `writeAuditEvent` |
   | Governance policy change | `/api/governance/policy` | ✅ `writeAuditEvent` |
   | **Admin-claim minting** | `/api/admin/set-role` | ❌ **NONE** |
   | **Provider credential read/write** | `/api/admin/keys` | ❌ **NONE** |
   | **Bulk run purge (≤2000 docs)** | `/api/admin/purge-runs` | ❌ **NONE** |
   | **Billing subscription sync** | `/api/admin/sync-subscription` | ❌ **NONE** |
   | **Webhook replay** | `/api/admin/test-webhook` | ❌ **NONE** |
   | **Account disable / delete** | `/api/admin/users/[uid]` PATCH/DELETE | ❌ **NONE** |
   | **Bulk user read** | `/api/admin/users` GET | ❌ **NONE** |
   | **Cross-user run read** | `/api/admin/runs` GET, `/api/admin/runs/[runId]` GET | ❌ **NONE** |
   | **Governance queue / audit reads** | `/api/governance/queue`, `/api/governance/audit` | ❌ **NONE** |

   **Consequence for an incident.** For any operation in the ❌ rows there is no
   application record of who did it or what was touched. Do not tell a
   stakeholder that activity "was reviewed and nothing was found" on the basis
   of the audit collection — for those operations the collection is silent by
   construction, not because nothing happened. Runtime logs (subject to their
   retention window) and Stripe's own event history are the only evidence, and
   the governance hot-path logs deliberately carry counts rather than record
   contents, so they will not tell you WHICH records were read.

   Closing this gap is a separate piece of work; C7 corrected the description
   only, and deliberately added no audit infrastructure.

### B. SYSTEM_ADMIN (claim-derived) — disabling is NOT sufficient

1. **Remove the claim**: `setCustomUserClaims(uid, { admin: false })` (or drop the
   key). `/api/admin/set-role` does this, but it itself requires SYSTEM_ADMIN, so
   during an incident use a service-account script rather than the route.
2. **Revoke refresh tokens** — `adminAuth.revokeRefreshTokens(uid)`. Without this
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
6. Verify denial against Production. For the evidence review, consult the
   coverage table in §A.6 first — claim minting, credential access and bulk
   purge, the three operations a compromised SYSTEM_ADMIN is most likely to have
   used, produce **no** application audit record.

### What this procedure does NOT give you

Immediate, guaranteed cutoff for a claim-derived SYSTEM_ADMIN. If that matters
for a given incident, the options are to wait out the token lifetime, or to add
`checkRevoked` to the SYSTEM_ADMIN verification path — a deliberate change with
a latency and quota cost, not made here.
