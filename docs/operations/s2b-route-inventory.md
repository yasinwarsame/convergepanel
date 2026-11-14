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

1. **`GET /api/admin/users/search` and `GET /api/admin/users/[uid]/details`** —
   RESOLVED by owner ruling (2026-11-14): SYSTEM_ADMIN is mandatory for both. They
   return billing identifiers, subscription state, entitlement overrides and (details)
   administrative audit history. The A.6 evidence table in `admin-authority-tiers.md`,
   which listed them as ADMIN_PORTAL, is corrected to SYSTEM_ADMIN; the pin rows in
   `privilegedGuardPin.spec.ts` stay SYSTEM_ADMIN.
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

## Parser-aware authority-source pins (M-1 / M-2, owner authorization 2026-11-14)

`app/api/admin/__tests__/privilegedAuthoritySources.spec.ts`, on the TypeScript AST
(`lib/admin/__tests__/authoritySourceGraph.ts`), over every non-test source in the
repository (app, lib, components, hooks, scripts, extension, prisma, root tools):

- **M-1 — admin-claim reads.** Every read of an `admin` member in any spelling
  (member, optional, element with literal / template / aliased-constant key,
  destructuring incl. parameters and nesting, `in`, `Reflect.get` / `get` /
  `hasOwnProperty` / `hasOwn`) is pinned to (file, enclosing function, count) with a
  category: live-record (the guard's live snapshot), telemetry, retired (legacy
  helpers — asserted zero importers), inert-field (`isAdmin` on the session verifier
  — asserted zero server-side readers), write-log, client-ui, operator tooling.
- **M-2 — global governance scope.** Taint from the sole reader of
  `GOVERNANCE_ADMIN_EMAILS` (`isGovernanceAdminEmail`) is propagated through the whole
  import graph (named, aliased, default, namespace, re-export, export-star, dynamic
  import, require, module-local helpers/aliases). The tainted-export inventory and
  the importer table are pinned exactly. Also pinned: one env-list reader; one
  producer of each global marker (`"admin_global"`, `visibleUserIds: null`,
  `isSupportAdmin: true`); no literal-null visibility check; and each of the six
  mixed-audience handlers calls `resolveGovernanceRequestUser` before any tainted or
  protected call (module-local helpers inlined).
- Behavioural additions in `mixedAudienceGovernanceAuth.spec.ts`: with a warm
  global cache — disabled → 401, live-record outage → 503, token-verifier outage →
  503, revoked pre-revocation cookie → 401, each on all six handlers; a reviewer
  assigned by a Governance Admin gets `assigners` scope only.
- Stated limits: runtime-built keys (`"ad" + "min"`), access that never names
  `admin`, and runtime-built module specifiers are not statically resolvable; the
  behavioural specs remain the proof that the guard decides from the live record.

### Final bounded correction (F-1 / F-2 / F-3 / NIT, owner authorization 2026-11-14)

- **F-1 — seed-module completeness.** Taint starts at the function-level readers of
  `GOVERNANCE_ADMIN_EMAILS` INSIDE `lib/admin/config.ts` (`isGovernanceAdminEmail`,
  `governanceAdminListShapeForLog`), so a sibling wrapper in the same module is tainted by
  local closure before traversal leaves it. Pinned: the export surface of config.ts.
  Inventory change: +1 tainted export (`governanceAdminListShapeForLog`, log counts only,
  seeded conservatively) and +1 importer edge (queue route already imports it); importer
  FILE count unchanged. **Correction (final review):** as first delivered this round did
  NOT cover module-level reads — the reader pin filed every top-level read under one
  de-duplicated `<module>` bucket, so a module-level constant built from the list and used
  by `isApplicationAdminEmail` passed every suite (reviewer mutant R1). Superseded by the
  F-1-only round below.
- **F-2 — indirect claim reads.** A repo-wide index resolves `"admin"` key constants across
  files (named / aliased / re-exported / `export *` / namespace imports, object-const
  members `C.ADMIN`, `NS.C.ADMIN`). New detections: enumeration (`Object.keys/entries/
  values/getOwnPropertyNames`, `Reflect.ownKeys`, `for…in` combined with the key),
  selection utilities (`pick`, `get`, `at`, … with the key or a key array). Fail-closed:
  a non-literal computed key or any enumeration on a claim/token receiver
  (`claims`, `customClaims`, `decoded*`, `idToken*`, `tokenResult`), and computed
  destructuring with an unresolvable key, must be allow-listed. Allow-list rows are now
  keyed file::function::kind. One reviewed false positive (`lib/agreementMap.ts`
  `claims[i]`: research-claim array).
- **F-3 — uid binding.** Structural: in all six mixed handlers every scope decision
  (`resolveGovernanceVisibleUserIds*`, `checkGovernancePolicyReadAccess`,
  `getAssignerUids`, the reviewer assigner query) receives a `const` uid derived from the
  authenticated result (`resolved.uid` / `caller.uid`), the auth wrapper returns
  `resolved.uid`, and the request-derived fields each handler reads are pinned (no
  identity field). Behavioural: real handlers with pass-through spies — user A signed in,
  user B (global Governance Admin) named in every request-supplied place — the resolver /
  policy check receive A's uid only; absent / malformed / mismatched credentials evaluate
  no scope at all.
- **NIT — shorthand markers.** `const visibleUserIds = null` / `isSupportAdmin = true`,
  their assignment forms, and reassignable bindings used in shorthand are producers.
- Limits (unchanged in kind): runtime-built keys and specifiers; access through objects
  that are not named as claim/token receivers and never name the key.

### F-1-only correction and owner-accepted static-analysis limits (owner ruling 2026-11-14)

- **F-1 (module-level reads and derived values).** `envDerivation` (test-only helper) attributes
  every env read in `lib/admin/config.ts` to its top-level declaration or statement — no
  `<module>` bucket — and computes every top-level declaration DERIVED from
  `GOVERNANCE_ADMIN_EMAILS` (direct read, reference to a derived declaration, or a
  module variable referenced by a derived function). One `violations()` function judges
  the real file and every control. Invariants: the derived set is exactly the two reviewed
  declarations and equals the taint seed; config.ts has no module-level bindings; exactly
  one module-level statement, classified as the startup warning (`if` without `else`,
  then-branch only `console.warn` with literal text) — not a generic exemption; no
  unresolvable `process.env` key; `isApplicationAdminEmail`'s full local closure reads only
  `ADMIN_EMAILS` and no derived value, and `isGovernanceAdminEmail`'s only
  `GOVERNANCE_ADMIN_EMAILS`. The repo-wide reader pin now records every occurrence (no
  de-duplication) and names module-level bindings/statements. Controls that fail: R1
  exactly, R1 via bracket key / key constant / destructuring / lazily filled cache,
  write-through from the governance predicate, a shared helper defaulting to the
  governance list, a dynamic env key, a non-warning module statement, a warning with an
  `else`, a second warning. Positive controls that pass: a function-local derived value in
  the governance predicate; an application-only helper. Behaviour: on a FRESH import
  (`jest.isolateModules`, so module-level values see the configured lists) a
  governance-only address is not an application admin and vice versa.
- **Correction (targeted review of 11274af, mutant E1b).** The statements above that
  `isApplicationAdminEmail`'s closure "reads only `ADMIN_EMAILS` and no derived value" and
  that the warning is "not a generic exemption" were overstated at 11274af: the
  derivation follows module-level BINDINGS only, so a governance list stored as a
  property of a function object (E1b: `governanceAdminListShapeForLog` writes it onto
  `canonicalizePrivilegedEmail`, `isApplicationAdminEmail` reads it) passed every suite,
  and a side effect in the warning CONDITION (E2) passed the static invariant. Corrected
  in the E1b round below.
- **E1b round (owner ruling 2026-11-14).** Static, over `lib/admin/config.ts` only:
  `envDerivation(...).stateWrites` lists every assignment / compound assignment / `++` /
  `--` / `delete` whose target is a property or element access (function-object
  properties, computed keys, `process.env.X`, `globalThis.x`), every reference to
  `globalThis` / `global`, every `window` use other than `typeof window`, and every
  `Object.assign` / `Object.defineProperty(ies)` / `Object.setPrototypeOf` /
  `Reflect.set` / `Reflect.defineProperty` / `Reflect.setPrototypeOf` call. Any entry not
  in the reviewed-exception table (`REVIEWED_STATE_WRITES`, empty; each entry must name
  the exact operation and why it cannot transfer authority) fails. The startup warning
  is classified as such only with a PURE condition (no assignment / update / delete, no
  global object, no call other than `.trim()`), no `else`, and a then-branch of
  fixed-text `console.warn` only. Behaviour: in ONE fresh module instance the governance
  code paths run first (`governanceAdminListShapeForLog`, `isGovernanceAdminEmail`), then
  `isApplicationAdminEmail` for the same governance-only address must be false —
  repeated three times — and the reverse direction holds. Controls: E1b and its computed-
  key / `globalThis` / `Object.assign` / `Object.defineProperty` / `Reflect.set` variants
  and three condition side effects (incl. E2) fail statically; legitimate refactors (a
  function-local list, an application-only helper, a reordered pure condition) pass.
  The F-1 controls are now set up syntax-aware (by function name, via test-only helpers)
  instead of exact-text anchors, so a legitimate refactor of config.ts does not break a
  control's set-up; the exact closure pin on `isApplicationAdminEmail` was removed in
  favour of the semantic check. (Only the "warning with an `else`" control still slices the
  warning text; it locates the statement, it does not depend on predicate bodies.)
- **Scope of what is demonstrated.** Current runtime: the independent reviews found no
  authorization defect, and the live Preview matrix passed. Future regression detection:
  the shapes above are detected; state channels outside config.ts that never import a
  governance-tainted export, mutation through method calls on received objects
  (e.g. an array passed in and `push`ed), and runtime-built code are not modelled — this
  remains defence in depth, not a proof.
- **NIT.** The misnamed exports-only-seed test is renamed to what it asserts.
- **Static source analysis is defence in depth, not a proof.** These pins detect the
  enumerated shapes of future change; they do not prove every future authorization edit
  safe. The binding assurance remains the behavioural route tests, the live Preview
  matrix and human review.
- **Owner-accepted limitations (not fixed; NOT permission to introduce these patterns):**
  F-2 — imported string-enum claim keys; dotted property paths in selector utilities
  (`get(u, "customClaims.admin")`); multi-statement key enumeration (`const ks =
  Object.keys(d); … ks.includes("admin")`); indexing a constant key array; dynamic claim
  access through receivers not named as claims/tokens (`token`, `user`, `result`, `auth`).
  F-3 — contrived variable shadowing can defeat the name-based uid-source assertion;
  request headers are not part of the structural request-field pin. Mitigation for this
  release: behavioural uid-binding tests on all six handlers, and focused human review of
  every file that establishes administrator or global-governance authority.
- **Follow-up (engineering):** when any authorization surface changes, extend the analyzer
  with symbol-level (type-checker) resolution for enum keys, dotted selector paths,
  cross-statement enumeration and const-array indexing, scope-aware uid tracking, and a
  header pin.

### V5 behavioural gate and static-analysis scope freeze (owner ruling 2026-11-14)

- **Correction to the E1b paragraph above.** "No call other than `.trim()`" was overstated:
  the purity check treats only plain call expressions as calls, so a tagged template
  (and a `new` expression) in the warning condition is not rejected statically (V4b).
- **V5 — found by the independent review of b2a7cb5; the previous tests did not detect
  it.** `governanceAdminListShapeForLog` pushes the parsed list into `process.argv` only
  when it has two or more entries, and `isApplicationAdminEmail` checks `process.argv`.
  A method call on an ambient global is not a recorded state write, and every earlier
  behaviour test used one-entry lists, so the channel never activated. Had it been
  introduced, every governance admin would have gained ADMIN_PORTAL membership after
  the first queue GET whenever two or more governance admins were configured. The
  current implementation does NOT contain it (independent review; runtime diff empty).
- **Fix (behaviour, not analyzer).** A fresh-module, order-sensitive test block over the
  real exported functions: an empty `ADMIN_EMAILS` with two and with three governance
  admins; one application-only admin alongside two governance-only admins; all six
  execution orders of shape-log / governance check / application check, repeated and
  reversed on one instance; a positive control (an address on both lists holds both
  memberships, each list grants only its own tier). Env and `process.argv` are restored
  after each test. The exact V5 mutation applied to the real config.ts fails these
  tests on the application-admin assertion after the shape-log and governance calls.
- **Static analysis frozen as defence in depth.** No further analyzer expansion. Known,
  owner-accepted limitations of the config.ts static checks: mutation through methods of
  shared global objects (`process.argv.push`, V1/V5), aliased or dynamically selected
  mutators (`const asg = Object.assign`, V2), computed call paths (`Object["assign"]`, V3),
  tagged-template and `new` side effects (V4b), channels activated only under
  conditions a test does not exercise, runtime-generated code and other dynamic
  behaviour, and the previously accepted F-2/F-3 limitations. A documented limitation is
  NOT permission to introduce that pattern in security-sensitive code.
- **What is and is not demonstrated.** Behavioural tests protect the demonstrated
  invariants (ADMIN_PORTAL and GOVERNANCE_ADMIN memberships are independent, for one,
  several, and empty lists, in any call order) but are not a universal proof against
  future regressions. Any change to a privileged-authority source file
  (`lib/admin/config.ts`, `lib/admin/verifiedAdminIdentity.ts`,
  `lib/admin/privilegedAccess.ts`, `lib/firebase/auth-helpers.ts`,
  `lib/governance/governanceVisibleUserIds.ts`, the six mixed governance handlers)
  requires explicit security-focused review. The independent-review verdicts recorded
  for 11274af and b2a7cb5 (F-1 NOT CLEAN, test blind spots) stand as recorded.

### PR #319 CI corrections (owner authorization 2026-11-14)

- **CodeQL #40 (`js/redos`, high, test-only).** The `"use client"` detector in
  `serverFiles()` (privilegedAuthoritySources.spec.ts) was an exponential-backtracking
  regex introduced by S2-b. It is replaced by `hasUseClientDirective` (test-only helper),
  linear in input size; the regex is removed. **Strictness contract (owner ruling, after
  the bounded review of 13c1921 found the first version weaker):** it answers CLIENT only
  if the FIRST statement is a standalone string literal spelled raw exactly
  `"use client"` / `'use client'`, AND the text before it is only whitespace, `//`
  comments ended by "\n", and block comments (a linear scanner; no shebang, no other
  line terminator, nothing else). Everything else is SERVER (fail closed: the file stays
  under the server-side pins). So it never answers CLIENT where the original regex
  answered SERVER; it is stricter for `"use client" + x`, `"use client".length`,
  `"use client", 1`, mismatched quotes. Evidence: on the 737 `app/` / `lib/` /
  `middleware.ts` files in the spec's own file set (`sourceFiles(ROOTS)`; a separate
  `git ls-files` count gave 740 because it also counted three test-support files the spec
  excludes by design: `lib/pdf/__fixtures__/layoutCanary.tsx`,
  `lib/pdf/__fixtures__/layoutFixtures.ts` and `lib/synthesis/trustSummary.test.ts`) — 704 SERVER, 33 CLIENT, 0 differences; 200,000 generated headers —
  0 cases of new-CLIENT/old-SERVER. The reviewer's M6 (a server file beginning
  `"use strict"; "use client";` reading `isAdmin`) is a spec control and fails the
  inert-field pin on the real tree.
- **Parse memoization (test-only).** `parseCached` keys a tree on (script kind, file
  name, exact source text): identical content reuses the tree, any change reparses, and
  the cache is per jest test file and per process. Every security pin keeps its exact
  expected value, and dedicated tests show that a mutated real source is analysed afresh.
  Measured locally: privilegedAuthoritySources 149.2 s → 19.7 s.
- **Quality Gate `timeout-minutes` 20 → 30** (`.github/workflows/quality-gate.yml`, the
  Quality Gate job only). Main's runs were already 11.6–18.9 min; the PR #319 run was
  cancelled at the 20-minute limit with 715 suites passed and 0 failed.
