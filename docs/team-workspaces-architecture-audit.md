# Team Workspaces + Shared Research Projects — Architecture Audit

**Status: local-only research artifact. No code changes made. Not yet committed — exists purely as planning input for the Team Workspaces workstream.**

**Date: 2026-08-12**

## Why this document exists

Before writing any Team Workspaces / Shared Research Projects code, we needed a precise map of how ownership, authorization, and the existing "team" concept actually work today — not an assumption of how they *should* work. This audit was produced by reading the actual source (not inferred from naming), with file:line references throughout, across four dimensions: auth/ownership patterns, the full Firestore schema, the existing governance/team system, and every route that currently assumes single-user ownership.

**The single most important finding**: this codebase already has a "team" concept, but it is narrow, single-purpose, and structurally incompatible with "workspaces" as usually understood. There is also a second, completely separate ad-hoc sharing mechanism that doesn't know the first one exists. Any Team Workspaces design has to explicitly decide what to do with both, not just add a third one alongside them.

---

## 1. The two existing "sharing" mechanisms — and why they don't interoperate

### 1a. `teams/{teamId}` — a real, persisted entity, but built for governance review only

- Schema: `TeamDocument` (`lib/governance/teamTypes.ts:59-71`) — `{ id, name, createdBy, createdAt, members: TeamMember[], policyRules, settings, adaptiveReviewSettings?, adaptiveMultiReviewerSettings? }`.
- `TeamMember` (`teamTypes.ts:12-17`): `{ uid, email, role, joinedAt }`. `TeamMemberRole = "owner" | "admin" | "member"` (`teamTypes.ts:10`).
- **Members live in a flat array on the team doc, not a subcollection.** There's a standing TODO to migrate this once teams exceed ~100 members (Firestore's 1MB doc limit) — `app/api/teams/route.ts:116`, `teamTypes.ts:73`. Any workspace design assuming large teams needs to plan for this migration.
- **A user belongs to at most one team, full stop.** `UserProfile.teamId?: string` (singular, `lib/types.ts:119-121`) — not an array. Enforced at creation (`app/api/teams/route.ts:99-104`, rejects if `userData.teamId` is already set) and at invite time (`app/api/teams/members/route.ts:88-93`, rejects adding someone already on a *different* team). **This is a hard schema constraint, not a soft convention — "Workspaces" (plural) requires changing `UserProfile` and every helper that reads `.teamId` as a scalar.**
- Roles: `owner | admin | member`. `isTeamAdmin()` treats owner and admin as equivalent for most gates (`lib/teams/teamApiAuth.ts:71-73`); a few places (member removal, decision overrides) specifically require `owner`. **Plain `"member"` can never review or vote** — `ELIGIBLE_REVIEWER_ROLES = new Set(["owner","admin"])` (`lib/governance/adaptiveHumanReviewAssignment.ts:18-20`), enforced at multiple route call sites. This exclusion is deliberate, not an oversight — a workspace model where ordinary members collaborate (not just owner/admin deciding) needs genuinely new eligibility logic.
- Gated behind the Full plan (`planHasTeamGovernance`, `lib/plans.ts:149-153`).
- Everything under `app/api/teams/**` — run listing, decisions, multi-reviewer panels, audit export, policies — is built on this one `TeamDocument`.

### 1b. `governanceReviewerUid` / `governanceReviewerFor` — a completely separate, one-to-one peer-review relationship

- Lives as loose fields on `users/{uid}` — **no `teams/{teamId}` doc involved at all**: `governanceReviewerUid`/`governanceReviewerEmail` (the one reviewer *this* user assigned) and `governanceReviewerFor: string[]` (reverse index — whose runs this user can review), parsed by `lib/governance/reviewerFields.ts:5-15`.
- Managed by `app/api/governance/reviewer/route.ts` — assign one reviewer at a time (`:183-289`, rejects if one is already assigned), toggle, remove. Both sides require the Full plan.
- Visibility computed independently via `resolveGovernanceVisibleUserIds()` (`lib/governance/governanceVisibleUserIds.ts:32-79`) — a second, parallel "who can see whose stuff" mechanism that has nothing to do with `team.members`.

**Nothing in the codebase reconciles these two.** A user can be on a `teams/{teamId}` AND separately have an unrelated `governanceReviewerUid` assigned, and neither system is aware of the other. A Shared Research Projects feature needs to explicitly decide: does it supersede both, wrap both, or add a third parallel mechanism? (Strongly recommend not the third option.)

---

## 2. Full Firestore data model inventory

### Top-level collections

| Collection | Doc type | Defined at | What it stores |
|---|---|---|---|
| `users` | `UserProfile` | `lib/types.ts:58+` | Profile, plan/subscription, usage counters, onboarding, governance-reviewer fields, `teamId`/`teamRole` |
| `runs` | `PanelRun` | `lib/firestore/runs.ts:78` | Deep Research panel run: `userId`, question, models, status, **plus merged-in** `adaptiveOutput`, `legacyAdaptiveOutput`, `governanceRecord`, `teamGovernance`, `adaptiveExportCounter`, `governanceStatus` |
| `verifications` | `ClaimVerificationFirestoreDoc` | `lib/firestore/verifications.ts:23` | Claim verification: `userId`, claim, verdict, consensus, model results, + governance fields |
| `videoVerifications` | inline (no dedicated type file) | `app/api/verify-video/route.ts:870-902` | Video verification results; same governance-merge pattern, but **no `lib/firestore/*.ts` helper exists** — writes are inline in the route |
| `teams` | `TeamDocument` | `lib/governance/teamTypes.ts:59` | See §1a |
| `teamRuns` | **two shapes coexist**: legacy `TeamRunDocument` + newer `AdaptiveTeamRunProjection` | `teamTypes.ts:100`, `lib/governance/adaptiveTeamReview.ts:137` | Projection/queue of a run for team review, scoped by `teamId`. Legacy uses random doc IDs; adaptive projection uses deterministic `${teamId}:${runId}` IDs. **Same collection, two ID schemes — confirm before building further on it.** |
| `appConfig/modelKeys` | ad hoc | `app/api/admin/keys/route.ts:27-28` | Server-stored LLM provider API keys |
| `appConfig/governancePolicy` | `GovernancePolicyFirestoreDoc` | `lib/governance/governanceFirestore.ts:10` | Singleton org-wide governance policy |
| `admin_audit_logs`, `admin_sessions`, `rate_limits`, `failed_governance_audits` | various | — | Operational/admin infrastructure, not user-facing |

### Subcollections (the only ones that exist anywhere)

All under `runs/{runId}/`: `exports/{exportId}` (`AdaptiveResearchExportV1`), `humanReviewHistory/{decisionId}`, `humanReviewAssignment/current`, `humanReviewAssignmentHistory/{eventId}`, `humanReviewPanel/current`, `humanReviewPanelHistory/{eventId}`, `humanReviewVotes/{voteId}`, `governanceEvents/{autoId}` (also exists under `verifications/{id}` and `videoVerifications/{id}`). Plus `appConfig/governancePolicy/auditEvents/{autoId}`.

**Nothing nests under `users`, `teams`, or `teamRuns` today.**

### Critical fact: no resource carries a `teamId`

`runs`, `verifications`, `videoVerifications`, and `exports` are **all owned by a single scalar `userId`/`ownerUid` field — none of them has a `teamId` or `workspaceId` field.** Team association only exists one layer removed, via the separate `teamRuns` projection collection. This means "share this run with my team" today is implemented as "copy a summary of this run into a team-visible queue," not "this run itself is team-owned." A workspace/project layer needs to decide whether to keep that indirection or make ownership itself multi-party.

### User quota/plan fields (all per-individual-user, zero team equivalents)

`plan`, `runsThisMonth`, `videoRunsThisMonth`, `usageMonth`, `totalRuns`, `tokensUsedCurrentPeriod`, `monthlyLimit`, `maxModelsPerRun`, Stripe fields, `override` (admin entitlement override) — all on `users/{uid}` (`lib/types.ts:74-92`, `lib/admin/entitlements.ts:66-74`). The only plan-level field already scoped to "team" rather than "individual" is `PlanConfig.teamGovernanceAccess` (`lib/plans.ts:124`) — a boolean gate, not a pooled resource.

### "workspace" / "project" vocabulary search result

- `workspace`: exactly one hit in the whole data model — a doc comment, `/** Team workspace (optional; enterprise governance) */` on `UserProfile.teamId` (`lib/types.ts:119`). No collection, no field, no scaffolding.
- `project`: zero data-model usage. All hits are npm/CLI/test noise.
- **There is no dormant workspace/project scaffolding to build on.** This is a green-field data model decision, constrained only by the existing `teams`/`teamRuns`/ownership patterns described above.

---

## 3. Auth resolution — how "who is calling this" is determined

- Canonical mechanism: `resolveRequestIdentity()` (`lib/auth/resolveRequestIdentity.ts:150-192`), used by ~15+ routes. Checks **both** the `__session` cookie (`verifySessionCookie()`) and `Authorization: Bearer` (`verifyIdToken()`) independently; if both are present they must resolve to the same uid or the request fails closed (`credential_mismatch`, `:180-184`). This is a hardened rewrite of an older, weaker "cookie wins if present" pattern.
- **`middleware.ts` only gates `/admin/:path*`**, and only checks cookie *presence*, not validity (`middleware.ts:20-37`). It never touches `/api/**`. **All authorization in this codebase is route-level — there is no central chokepoint where "does this uid have access to X" is enforced once.** A workspace feature will need to add its access check to every relevant route individually (or introduce a new shared helper), the same way ownership checks work today.
- **Admin API auth was not migrated** to `resolveRequestIdentity` — `requireAdminApiAccess()` (`lib/firebase/auth-helpers.ts:172-208`) still uses the older, independent cookie-or-bearer logic. Not directly relevant to workspaces, but worth fixing opportunistically since a new auth surface will touch this file.
- **CLAUDE.md's auth section is stale** — describes ad hoc per-route calls rather than the current unified resolver. Worth a docs fix alongside any workspace auth work.

---

## 4. Ownership-check patterns — five distinct idioms, no shared helper

There is no `canAccess(uid, resource)`-style shared function anywhere. Five different idioms are in live use:

| Style | Example | Where |
|---|---|---|
| A. Single-field equality (`owner !== uid` → 403) | `app/api/user/runs/[runId]/route.ts:64-65` | Most `app/api/user/**` routes |
| B. Dual-field-name fallback (`userId ?? uid`) | `app/api/user/verifications/[verificationId]/route.ts:80-88` | Verifications, run-governance (legacy field-name migration never fully backfilled) |
| C. Ownership wrapped in a multi-axis verdict function | `lib/adaptiveSchema/exportAuthorization.ts:77-121` | Export authorization — combines ownership + plan + governance state. **Best existing template for composing ownership with other axes**, but currently hard-gates `isRunOwner` first (`:78-80`) with a comment explicitly noting single-owner was a deliberate Phase-1 simplification to revisit |
| D. Team-id equality + role, not user-id equality | `app/api/teams/runs/[runId]/decision/route.ts:83-89` | Everything under `app/api/teams/**` — the only place multi-person access already works |
| E. Admin bypass, no check at all | `app/api/admin/runs/[runId]/route.ts:44-201` | Admin routes (expected — not a gap) |

### Full blast radius — every route with a single-owner assumption that a workspace feature would need to touch

**Read/write on an existing resource** (7 routes, all `owner/userId !== uid → 403` or query-scoped):
`app/api/user/runs/[runId]/route.ts`, `.../export/route.ts`, `.../exports/route.ts`, `.../exports/[exportId]/route.ts`, `app/api/user/verifications/[verificationId]/route.ts`, `app/api/user/run-governance/route.ts`, `app/api/user/panel-history/route.ts` (query-level `.where("userId","==",uid)` at 3 call sites — **Firestore can't OR two different equality filters in one query, so team-scoped visibility needs a second query path entirely, not a relaxed filter**).

**Resource creation** (4 routes — each tags the new doc with exactly one `userId`/`ownerUid` and checks quota against exactly one `users/{uid}` doc):
`app/api/run-panel/route.ts` (`createRun(runId, uid, ...)` at `:341`), `app/api/verify-claim/route.ts` (`userId: uid` at `:316`), `app/api/verify-video/route.ts` (`userId: uid` at `:866`), `app/api/synthesize-panel/route.ts` (`runUserId !== uid` re-check at `:312, :665`, with an explicit backward-compat exception for legacy runs with no `userId` at all).

**Billing/quota**: `lib/stripe/usageCheck.ts`'s `checkAndIncrementUsageForRun()` runs a Firestore transaction against exactly one `users/{uid}` doc (`:261-288`) — no `teamId` parameter exists anywhere in this file. **"Who pays" and "who owns" are the same single uid today, atomically.** A workspace design needs an explicit decision: keep billing on the initiating member's individual counter (cheapest, no new code), or introduce a pooled `teams/{teamId}.runsThisMonth` counter (needs a new transaction target and a parallel `evaluateUsageGate`).

### The one existing precedent for multi-person access: `app/api/teams/**`

`app/api/teams/runs/route.ts` shows the pattern: query the **derived** `teamRuns` collection by `teamId` (not the canonical `runs` collection by `userId`), then apply role-based visibility in application code — admins see every row, plain members see only their own (`:94`, `:145-147`). Decision routes gate on `isTeamAdmin(memberRole(uid, team))` + `resource.teamId === team.id`, not identity equality.

**The caveat that matters most**: this pattern governs the *projection* (`teamRuns`), never the canonical `runs`/`verifications`/`videoVerifications` doc itself, which still has exactly one `userId`. Reusing this pattern for real shared ownership means either (a) teaching the canonical docs to carry `teamId`, or (b) teaching every route in the blast-radius list above to also accept team-based access the way the projection already does.

A second, narrower precedent: `lib/governance/governanceVisibleUserIds.ts` — reviewer-assignment-based visibility (a run becomes visible to someone other than its owner via `governanceReviewerFor`), independent of the team system. A third existing "someone other than the owner can see this" mechanism to be aware of, on top of the two in §1.

---

## 5. What's reusable vs. what needs genuinely new work

### Reusable as-is
- `memberRole()` / `isTeamAdmin()` (`lib/teams/teamApiAuth.ts:66-73`) — small, composable, well-tested. Trivially reusable for "is this user privileged in this workspace" regardless of the action.
- The team doc's additive-optional-settings-block pattern (`adaptiveReviewSettings?`, `adaptiveMultiReviewerSettings?`) — each new capability is its own opt-in, fail-closed block. A `sharedResearchProjects?` block on the team/workspace doc could follow the identical shape.
- `teamId`-scoped Firestore query + app-level role filtering — audited, no IDOR risk (per the project's own design doc), and directly reusable for project-scoped listing.
- `exportAuthorization.ts`'s multi-axis verdict pattern (ownership + plan + governance composed into one allow/deny decision) — the right shape for "can this uid access this shared resource," just needs the ownership axis widened.

### Needs genuinely new design — nothing to extend
- **Invitation flow**: confirmed via exhaustive grep — **does not exist at all.** Team membership today is synchronous admin-adds-by-email, and the invitee must already have an account (`app/api/teams/members/route.ts:70-82`, 404 `"User must have a ConvergePanel account first"` if not). No pending/invited state, no email delivery, no accept/decline, no token/expiry model. Building invitations means starting from zero, not extending anything.
- **Per-project/per-run membership**: doesn't exist — today's sharing is all-or-nothing at the team level (admin sees everything, member sees only their own). "Share this specific research project with these 3 people" has no existing scaffolding — it's a new sub-membership concept, not a variant of team membership.
- **Multi-workspace-per-user**: `users/{uid}.teamId` is a hard singular constraint, actively enforced. Needs a schema change (`teamId` → `teamIds[]` or a membership subcollection) plus every `loadUserAndTeam`-style helper updated.
- **Team-pooled billing**: zero scaffolding, as above.
- **Ordinary-member collaboration on review-like actions**: `ELIGIBLE_REVIEWER_ROLES` deliberately excludes plain `"member"` from reviewing/voting. If Workspaces wants regular members to collaborate (not just owner/admin deciding), that's new eligibility logic, not a relaxed constant.

---

## 6. Open questions this audit surfaces (not answered here — decisions for the next planning pass)

1. Does Shared Research Projects **replace** the existing `teams/{teamId}` governance system, **extend** it (add project-level sub-membership within a team), or run **alongside** it as a distinct concept? (Strong recommendation against a third parallel system, given §1's finding that two already don't talk to each other.)
2. Does a "workspace" map 1:1 to today's `team`, or is it a new, more general concept that a team could contain multiple of?
3. Do we lift the one-team-per-user constraint, or keep it and make "workspace" a role/label within a still-singular team?
4. Is ownership of a run/export ever actually transferred to a workspace (new `teamId`/`workspaceId` field on the canonical doc), or does sharing stay indirect via a projection collection, as `teamRuns` already does?
5. Billing: pooled per-workspace usage, or still per-individual-member?
6. Do we need real async invitations (email, pending state, expiry) for v1, or is "admin adds an existing user by email" (today's model) acceptable for a first version?
7. Given `panel-history`'s query-level scoping, is a second teamId-scoped query path (with client-side merge) acceptable, or does this push toward denormalizing a `teamId` onto every resource doc regardless of the ownership-model decision?

---

## Source material

This audit synthesizes four parallel research passes (auth/ownership patterns, Firestore schema inventory, governance/team roles + invitation flows, and the full ownership-route blast radius), each conducted via direct source reading with file:line citation, not inference from naming or documentation. The project's own `docs/governance-decision-receipts-design.md` (2869 lines) is also directly relevant — it documents several precedents cited above (the `teamRuns` audit/queue/decision-of-record design smell in legacy rows, the deliberate separation of `AdaptiveReviewSettings` from `AdaptiveMultiReviewerSettings`, the IDOR audit of `teamId`-scoped queries) and is worth reading in full before the next planning pass.
