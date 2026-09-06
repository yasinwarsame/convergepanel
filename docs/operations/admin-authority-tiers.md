# Administrator authority tiers

Authoritative contract for who can do what, and how each tier is granted.
Written before the first real administrator is enrolled; both allowlists are
currently empty.

Never write "application admin" without saying which tier is meant.

## Tiers

### ADMIN_PORTAL
**Source:** a verified live Firebase Auth email on `ADMIN_EMAILS`, **or** the
Firebase custom claim `admin === true`.
**Guard:** `requireAdminPortalAccess`.
**Grants:** `/api/admin/access`, `/api/admin/users` (GET), `/api/admin/runs`,
`/api/admin/runs/[runId]` (GET/PATCH/DELETE), `/api/admin/sync-subscription`,
`/api/admin/test-webhook`.
This is **not** full application administration.

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
`/api/admin/users/search`, `/api/admin/users/[uid]` (PATCH/DELETE),
`.../details`, `.../override`, `.../stripe/{cancel,reactivate,sync}`.
SYSTEM_ADMIN also satisfies ADMIN_PORTAL, because the same claim satisfies that
guard.

### GOVERNANCE_ADMIN
**Source:** a verified live Firebase Auth email on `GOVERNANCE_ADMIN_EMAILS`
**only**.
**Guards:** `checkAdminOnly`, `resolveGovernanceVisibleUserIds`.
**Grants:** governance-global visibility (every user's runs), governance policy
write, audit backfill, and the governance dashboard/policy presentation.

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

## FIRST_ADMIN_ENROLLMENT_BLOCKER_DECISION — OPEN, blocks first enrollment

**Status: UNDECIDED. This must be settled before the first address is added to
`ADMIN_EMAILS`.** It is deliberately NOT resolved in phase C3, because it is a
product/security decision about what ADMIN_PORTAL is *for*, not a defect to
patch.

Two capabilities currently sit at ADMIN_PORTAL and are reachable by any verified
`ADMIN_EMAILS` member holding no custom claim:

| Route | Method | Effect |
|---|---|---|
| `/api/admin/runs/[runId]` | `DELETE` | Permanently deletes **another user's** run / verification / video-verification document. |
| `/api/admin/runs/[runId]` | `PATCH` | Writes `set_governance_status` (`approved` / `needs_review` / `blocked`) on **another user's** run, audited as "Admin governance override". |

Two things make this a decision rather than a preference:

1. **It contradicts this document.** The tier contract above states that
   `ADMIN_EMAILS` confers no governance authority. The PATCH route lets an
   `ADMIN_EMAILS`-only administrator overwrite governance verdicts. Both
   statements cannot stand.
2. **Risk-line inversion.** The destructive single-document DELETE sits at
   ADMIN_PORTAL, while the strictly read-only `/api/admin/users/search` and the
   bulk `/api/admin/purge-runs` both require SYSTEM_ADMIN. An `ADMIN_EMAILS`
   administrator can delete other users' records one at a time but may not
   preview a user list.

Both are **pre-existing**: phases C1–C3 renamed the guards and did not move any
route between tiers. They are latent only because `ADMIN_EMAILS` is empty. **The
moment the first address is enrolled, they become live.**

### The decision to make

For each route, choose ONE and record it here with a date and a decider:

- **Keep at ADMIN_PORTAL** — accepting that an `ADMIN_EMAILS` administrator can
  delete any user's run and override governance status. If chosen, the
  "`ADMIN_EMAILS` confers no governance authority" claim in this document must
  be narrowed to "no governance *queue/policy/audit* authority", and the
  operational meaning of an ADMIN_EMAILS enrollment must be documented as
  including cross-tenant deletion.
- **Move to SYSTEM_ADMIN** — making ADMIN_PORTAL a genuinely read-mostly support
  tier. If chosen, it is its own PR with its own review, not a test-hardening
  phase, because it changes who can perform live operations.

Until one is recorded, first-admin enrollment is blocked.
