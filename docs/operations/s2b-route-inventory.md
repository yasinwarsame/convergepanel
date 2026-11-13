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
  4 ADMIN_PORTAL). The 22nd of the estimate was the secret bootstrap route, retired
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

## Mixed audience: guard AUTHENTICATION, scope decided downstream (owner ruling D)

These six handlers are not a single privileged tier, so the tier guard (which
answers 403 to anyone not holding the tier) would lock out legitimate non-admin
callers. Since the owner's ruling D they use the guard's AUTHENTICATION without a
tier decision — `authenticatePrivilegedPrincipal` (lib/admin/privilegedAccess.ts),
via `resolveGovernanceRequestUser` (lib/governance/authCheck.ts) — and keep their
existing uid-derived scoping. This is a FIXED inventory: the pin spec lists them,
and any other app/api handler touching an authority surface must be classified.

What that authentication guarantees on all six:

- **No silent fallback (SP-5).** A present-but-invalid, malformed, expired or
  revoked bearer never hands the request to a cookie (or the reverse); two
  credentials must name the same uid. Any of these is 401.
- **One live read; account state.** `disabled === false` exactly; a deleted
  account is 401.
- **Revocation of every presented credential.** Each credential's `auth_time` is
  compared with the live `tokensValidAfterTime` (absent cutoff allows; unparseable
  cutoff is revoked; strictly earlier is revoked, equal is not). So
  `revokeRefreshTokens(uid)` takes effect on the NEXT request for the cookie and the
  bearer alike — including for a revoked bearer presented beside a fresh cookie.
- **Outage is 503.** A verifier or Auth-lookup outage, or an uninitialised Admin
  SDK, is 503 (`Retry-After: 5`) by the guard's A-2 classification — never a grant
  and never a silent 401. (Before ruling D these were 401.)
- **Neutral denials.** `{ ok: false, error: { code: "unauthorized" | "auth_unavailable", message } }`,
  no identity, tier or scope data (`lib/governance/governanceAuthDenial.ts`).

Scope, decided after authentication from the uid only (unchanged):

- **Global scope** (`admin_global`, every owner's runs; review of any run) comes only
  from `resolveGovernanceVisibleUserIds*`, whose own live read must show a verified,
  enabled `GOVERNANCE_ADMIN_EMAILS` member. The 2-minute visibility cache key now
  also carries that live governance-admin decision, so an address removed from the
  list loses global scope on the next request even with a warm cache. Revoked or
  disabled admins are already 401 at authentication.
- **Ordinary reviewer / full-plan users** keep exactly their existing scope: the
  owners who assigned them (`assigners`), or nothing (`no_assigners`); free / lite
  callers get the plan refusal. A former GOVERNANCE_ADMIN who also holds a full plan
  falls back to that full-plan scope only — never global.
- **`/api/governance/reviewer` GET/POST** confer no privileged or cross-user /
  global capability: GET returns the caller's own settings and the assigners who
  chose the caller; POST changes the caller's own availability and own reviewer
  assignment (full plan required for everyone — a free-plan GOVERNANCE_ADMIN gets
  403). They are not a privileged path. They were moved onto the same
  authentication anyway (revocation-safe), at the cost of ONE live Auth read per
  request on a low-traffic settings surface; POST `assign_reviewer` takes the
  caller's own email from that read instead of a second `getUser`, so it makes no
  more Auth reads than before. Governance semantics are unchanged.

Proof through the real handlers:
`app/api/governance/__tests__/mixedAudienceGovernanceAuth.spec.ts` (each of the six:
ordinary access, privileged access, revoked bearer, revoked bearer + fresh cookie,
disabled, malformed, conflicting uids, verifier outage, getUser outage; cross-owner
scope; removal / revocation / disablement of a GOVERNANCE_ADMIN who holds a full
plan) and `lib/governance/__tests__/authCheckResolveGovernanceRequestUser.spec.ts`.
Team-bound artifacts are outside these legacy (System-C) handlers and are covered by
the existing `teamVerificationContainment` / `workspaceIntegrity` specs.

| Handler | Authentication | Scope | Audience | Writes |
|---|---|---|---|---|
| `GET /api/governance/policy` | guard authentication | `checkGovernancePolicyReadAccess` | GOVERNANCE_ADMIN **or** current `full` plan | no |
| `GET /api/governance/audit` | guard authentication | `resolveGovernanceVisibleUserIdsCached` | GOVERNANCE_ADMIN (global) **or** reviewer (scoped) | no |
| `GET /api/governance/queue` | guard authentication | `resolveGovernanceVisibleUserIdsCached` | GOVERNANCE_ADMIN (global) **or** reviewer (scoped) | no |
| `POST /api/governance/review` | guard authentication | `resolveGovernanceVisibleUserIds` | GOVERNANCE_ADMIN **or** assigned reviewer | yes — review decision |
| `GET /api/governance/reviewer` | guard authentication | own plan gate; own data | full-plan self-service | no |
| `POST /api/governance/reviewer` | guard authentication | own plan gate; own data | full-plan self-service | yes (own records) |

## Mutation classification (correction rounds)

| Mutant | Result | Evidence |
|---|---|---|
| `app/api/admin/users/[uid]/stripe/cancel/route.ts`: `adminUid: body.adminUid ?? auth.uid` | **KILLED** | Every mutating case in `privilegedRouteWiring.spec.ts` now carries `adminUid/byUid/actorUid/uid` = SPOOF in its body; the cancel attribution test fails (1 failure). The same mutant passed all 632 tests of the pre-correction spec, which never sent a spoofed `adminUid` to cancel. |
| `app/api/governance/policy/route.ts`: `byUid: body.byUid ?? resolved.uid` | **EQUIVALENT BY BARRIER** | Unreachable: `validatePolicyPartial` rejects every key outside `ALLOWED_POST_KEYS` with 400 before the store or audit sink is touched, so no request that reaches the attribution line can carry `byUid`. The barrier is pinned (a SPOOFED body → 400, the four fields named, zero writes, zero audit rows), and the combined mutant (drop the unknown-key rejection AND read `body.byUid`) is KILLED. |

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
2. **Mixed-audience governance handlers** — RESOLVED by owner ruling D: guard
   authentication without a tier decision (section above).
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
