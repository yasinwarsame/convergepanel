# S2-b privileged route inventory

Enumerated from the filesystem at branch `feat/s2b-privileged-route-wiring`
(base `25336ac`). Every handler under `app/api/admin/**`, every governance
handler, and every other route that checked the `admin` claim or an admin email
list. The tier column of the wired handlers is pinned by
`app/api/admin/__tests__/privilegedGuardPin.spec.ts`; behaviour is proven through
the real handlers by `app/api/admin/__tests__/privilegedRouteWiring.spec.ts`.

Search used: `app/api/admin/**/route.ts`, `app/api/governance/**/route.ts`, and a
repository grep (app/, lib/, components/, middleware.ts) for
`requireSystemAdminAccess`, `requireSystemAdminBearer`, `requireAdminPortalAccess`,
`requireAdminApiAccess`, `requireAdmin`, `verifyAdminToken`, `getRequestUser`,
`checkIsAdmin*`, `checkAdminOnly`, `hasVerified*Authority`,
`resolveVerifiedAdminScopes`, `is*AdminEmail`, `ADMIN_EMAILS`, `.admin === true`,
`customClaims`. No other server route reads the claim or an allowlist.

## Count reconciliation

The earlier design estimate was ~22 admin + ~8 governance handlers. Actual:

- **21** handlers in **16** route files under `app/api/admin/**` (17 SYSTEM_ADMIN,
  4 ADMIN_PORTAL). The 22nd of the estimate was `POST /api/admin/set-admin`, retired
  in S1 (the file no longer exists).
- **8** governance handlers in 6 files. Only **2** are a single privileged tier
  (GOVERNANCE_ADMIN) and are wired to the guard. The other 6 serve a mixed
  audience and are deliberately left on their existing mechanism (see below).
- Total wired: **23** handlers.

## Wired to `requirePrivilegedAccess`

"Before" is the guard each handler used at the base commit. "Tier" is unchanged
by S2-b in every row (no route was broadened or narrowed).

| Handler | Before | Tier (before = after) | Writes |
|---|---|---|---|
| `GET /api/admin/access` | `requireAdminPortalAccess` + inline token-claim read for `systemAdmin` | ADMIN_PORTAL | no (probe; `systemAdmin` is now the LIVE claim) |
| `GET /api/admin/keys` | `requireSystemAdminBearer` | SYSTEM_ADMIN | no (reads provider credentials) |
| `POST /api/admin/keys` | `requireSystemAdminBearer` | SYSTEM_ADMIN | yes — `appConfig/modelKeys` |
| `POST /api/admin/purge-runs` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — durable bulk research deletion |
| `GET /api/admin/runs` | `requireAdminPortalAccess` | ADMIN_PORTAL | no (cross-user read) |
| `GET /api/admin/runs/[runId]` | `requireAdminPortalAccess` | ADMIN_PORTAL | no (cross-user read) |
| `PATCH /api/admin/runs/[runId]` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — governance status + audit row |
| `DELETE /api/admin/runs/[runId]` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — cross-user delete + audit row |
| `POST /api/admin/set-role` | `requireSystemAdminBearer` | SYSTEM_ADMIN | yes — custom claims + `users/{uid}.role` |
| `POST /api/admin/sync-subscription` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — billing state |
| `POST /api/admin/test-webhook` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — runs `handleSubscriptionChange` |
| `GET /api/admin/users` | `requireAdminPortalAccess` | ADMIN_PORTAL | no (every user document) |
| `GET /api/admin/users/search` | `requireSystemAdminAccess` | SYSTEM_ADMIN | no |
| `PATCH /api/admin/users/[uid]` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — Auth `updateUser(disabled)` + Firestore |
| `DELETE /api/admin/users/[uid]` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — Auth `deleteUser` + Firestore |
| `GET /api/admin/users/[uid]/details` | `requireSystemAdminAccess` | SYSTEM_ADMIN | no |
| `POST /api/admin/users/[uid]/override` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — entitlement override + audit log |
| `DELETE /api/admin/users/[uid]/override` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — entitlement override + audit log |
| `POST /api/admin/users/[uid]/stripe/cancel` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — Stripe cancel/update + Firestore + audit log |
| `POST /api/admin/users/[uid]/stripe/reactivate` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — Stripe update + Firestore + audit log |
| `POST /api/admin/users/[uid]/stripe/sync` | `requireSystemAdminAccess` | SYSTEM_ADMIN | yes — Firestore + audit log (reads Stripe) |
| `POST /api/governance/audit/backfill` | `resolveGovernanceRequestUser` + `checkAdminOnly` | GOVERNANCE_ADMIN | yes — up to 400 `admin_audit_logs` rows |
| `POST /api/governance/policy` | `resolveGovernanceRequestUser` + `checkAdminOnly` | GOVERNANCE_ADMIN | yes — policy + audit event |

By tier: **SYSTEM_ADMIN 17**, **ADMIN_PORTAL 4**, **GOVERNANCE_ADMIN 2**.

## Deliberately NOT wired (mixed audience)

These are not a single privileged tier, so the guard (which answers 403 to anyone
not holding the tier) would lock out legitimate non-admin callers. They stay on
their existing identity resolution (`resolveGovernanceRequestUser` — live record,
disabled-account refusal — or, for `/reviewer`, `resolveRequestIdentity`) plus
their own uid-derived scoping. They are listed in the pin spec so a new governance
handler cannot appear without a decision.

| Handler | Current guard | Audience | Writes |
|---|---|---|---|
| `GET /api/governance/policy` | `resolveGovernanceRequestUser` + `checkGovernancePolicyReadAccess` | GOVERNANCE_ADMIN **or** current `full` plan | no |
| `GET /api/governance/audit` | `resolveGovernanceRequestUser` + `resolveGovernanceVisibleUserIdsCached` | GOVERNANCE_ADMIN (global) **or** reviewer (scoped) | no |
| `GET /api/governance/queue` | `resolveGovernanceRequestUser` + `resolveGovernanceVisibleUserIdsCached` | GOVERNANCE_ADMIN (global) **or** reviewer (scoped) | no |
| `POST /api/governance/review` | `resolveGovernanceRequestUser` + `resolveGovernanceVisibleUserIds` | GOVERNANCE_ADMIN **or** assigned reviewer | yes — review decision |
| `GET /api/governance/reviewer` | `resolveRequestIdentity` + own plan gate | plan-gated self-service | no |
| `POST /api/governance/reviewer` | `resolveRequestIdentity` + own plan gate | plan-gated self-service | yes |

Other non-route uses found by the grep, none of them authorization:
`app/api/user/usage` emits the legacy presentation `role: "admin"` from
`resolveVerifiedAdminScopes` (documented as never authorizing anything);
`app/admin/page.tsx` and `hooks/useAdminPortalAccess.ts` are client UI affordances
over `GET /api/admin/access`; `middleware.ts` checks only `__session` presence for
`/admin/*` pages and is unchanged.

## Owner questions

1. **`GET /api/admin/users/search` and `GET /api/admin/users/[uid]/details`.**
   The code at the base commit gates both at SYSTEM_ADMIN; the A.6 evidence table in
   `admin-authority-tiers.md` lists them as ADMIN_PORTAL. Kept at the STRICTER tier
   (SYSTEM_ADMIN, the code). Decide whether they should be ADMIN_PORTAL reads; if so
   it is a one-line tier change plus the pin row.
2. **Mixed-audience governance handlers** (table above). Wiring them would need a
   guard mode that returns the live snapshot without a tier decision (or a
   "GOVERNANCE_ADMIN or reviewer" composite). Out of S2-b's approved design; decide
   whether a follow-up slice should do it.
3. **Legacy helpers.** `requireSystemAdminAccess`, `requireAdminPortalAccess`,
   `requireAdminApiAccess`/`requireAdmin`, `verifyAdminToken`, `checkIsAdmin*`
   (`lib/firebase/auth-helpers.ts`), `requireSystemAdminBearer`/`getRequestUser`
   (`lib/firebase/adminAuth.ts`) and `checkAdminOnly` (`lib/governance/authCheck.ts`)
   now have no route callers; the pin spec forbids any `app/` or middleware caller.
   Deleting them also deletes or rewrites their own unit specs
   (`systemAdminClaimStrictness`, `adminAuthoritySeparation`,
   `disabledAccountAuthority`, `r25AdminSessionCookieGrantsNothing`,
   `privilegedRevocation`, `governanceClaimIsolation`). Proposed as a separate
   small slice.
