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
**Guards:** `requireSystemAdminAccess` (cookie or bearer), and
`requireSystemAdminBearer` (bearer-only routes).
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
tier, and is currently empty in Production (so the route fails closed).

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
