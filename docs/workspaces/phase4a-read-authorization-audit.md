# Phase 4A — Workspace-Aware Read Authorization Architecture + Historical Run Audit

Read-only architecture/threat-model pass. No code changed, no production data mutated, no routes touched. Companion to [`docs/workspaces/architecture.md`](./architecture.md) (Phases 1-3D, all complete/live) — this document begins Phase 4, which is design-only as of this writing.

## Correction log (post-initial-draft security review)

A second read-only review pass found three issues in the initial draft of this document, two of them security-significant. This document has been corrected in place; the sections below reflect the **final** recommended architecture. Original reasoning is preserved inline where it's useful context for why the correction matters, but nothing below should be read as "two valid options" — the corrected version is the only one to build against.

1. **The originally-proposed `WORKSPACE_AWARE_READS_ENABLED` boolean flag was wrong and has been rejected.** The original draft argued that "flag off = identical to pre-Phase-4B behavior, therefore not a downgrade" — that framing is itself the error. Once `workspaceId` is a security-relevant signal, the invariant is about the *current* standing rule ("present → must validate"), not about matching some prior baseline. A flag that lets a bound resource skip validation is a downgrade regardless of what existed before Phase 4B shipped. See the corrected §8.
2. **The claim that reviewer-inbox/list routes could skip Workspace validation entirely was wrong.** That conflated Layer B (who is allowed in) with Layer A (is the resource's own claimed association even valid) — a reviewer's assignment being valid says nothing about whether the *run* they're assigned to has a corrupted Workspace binding. See the corrected §7 and the new "Lists and bulk reads" section.
3. **"Zero teams have ever existed" was asserted from the current empty `teams` collection without first proving teams can't be deleted.** That's a real gap — collection-empty-today does not by itself prove collection-was-always-empty unless deletion is structurally impossible. This has now been investigated directly (see the corrected §10) and the original conclusion holds, but it holds for a different, actually-proven reason, not the originally-asserted one.

A fourth, non-security practical point was also folded in: the associated-run population is no longer a fixed 4 now that global `RW=true` is live — Phase 4B must treat it as a live count, gated at deployment time, not a number from this audit.

## 1. Repository state

Local `HEAD` == `origin/main` == `c3f76616563e20f11a4ab6ab3b73a685d096fc2b` (PR #44 merge — the Phase 3A/3D-era commit). Production deployment (`dpl_DSPUxMLCRxGYpSfq6KezGHtZyofy`) is built from this exact commit. Zero application-code diff. The only uncommitted local changes are two documentation files (this file's siblings), not shipped to production. Phase 3 remains the deployed baseline; nothing in this audit required or performed a redeploy.

## 2. The core security invariant, restated precisely

```
run.workspaceId truly absent (undefined)  → LEGACY            (existing owner/reviewer/team auth, unchanged)
run.workspaceId present + fully valid     → WORKSPACE_BOUND_VALID   (integrity-gated, then existing auth composes)
run.workspaceId present + any invalid     → WORKSPACE_BOUND_INVALID (fail closed, unconditionally, regardless of requester identity)
```
`null`, `""`, whitespace, wrong type all collapse into "present but invalid," never into "absent." This is already exactly how `lib/workspaces/workspaceResolver.ts`'s `resolveWorkspaceContext()` behaves today (Phase 1, built and tested, never wired to a route) — Phase 4 does not need to invent this distinction, only reuse it.

## 3. Read-route inventory — summary

A dedicated research pass (full grep-verified inventory, ~40 route/function entries with file:line citations, archived in this session's working notes) found:

- **Zero server actions exist** in this repo — all server-side run access is `app/api/**/route.ts` or `lib/**` helpers called from those routes.
- **Direct client Firestore access to `runs` is structurally impossible** — `firestore.rules` is a blanket deny (`match /{document=**} { allow read, write: if false; }`) except `users/{uid}` (self) and `appConfig/modelKeys` (admin). Every run read is Admin-SDK-mediated.
- Five route groups touch run data: **Personal/owner** (`/api/user/**` — history, detail, governance, review-history, decision, export×3, reviews inbox, run-governance, synthesize-panel), **Team** (`/api/teams/**` — 10 routes, entirely `teamRuns`-projection-mediated, never read `run.userId`), **Governance** (`/api/governance/**` — its own visibility model, `governanceReviewerUid`/`governanceReviewerFor`), **Admin** (`/api/admin/**` — no ownership scoping at all, `admin: true` claim only), and roughly 20 non-route `lib/` functions (governance panel/vote/history CRUD, export record CRUD, repair scripts) that read/write `runs/{runId}` but are not independently authorization-gated — they're called from already-authorized routes.

**Confirmed, with a dedicated existing regression test (`app/api/user/runs/[runId]/__tests__/phase3WorkspaceIdInert.spec.ts`): no read route anywhere in the codebase currently reads `run.workspaceId`.** It is 100% write-side today. This means Phase 4B is purely additive — there is no existing behavior depending on `workspaceId` being ignored that could regress.

## 4. Authorization architecture — seven distinct idioms, no single centralized helper

| Idiom | Mechanism | Routes |
|---|---|---|
| A | `String(data.userId ?? "") !== uid` → 403 | export (create/list), first tier of run-detail/governance |
| A′ | `data.userId ?? data.uid` dual-field fallback | `user/run-governance`, `governance/review` |
| A″ | **Lenient**: `runUserId !== undefined && runUserId !== uid` — a run with NO `userId` field is readable by anyone | `synthesize-panel` GET/POST (flagged as a pre-existing weak point, out of Phase 4 scope to fix) |
| B | `resolveAdaptiveRunAccess({uid, runOwnerUid, assignment, humanReviewStatus})` — owner OR the run's own frozen `humanReviewAssignment/current` reviewer, nothing else | run-detail, governance, review-history, decision |
| C | `loadUserAndTeam` → `isTeamAdmin` → `teamRuns/{runId}` projection validity (duplicated inline **9 times**, including once inside a `/api/user/` route) | all 10 `/api/teams/adaptive-runs/**` routes |
| D | `resolveGovernanceRequestUser` → `resolveGovernanceVisibleUserIds` → `runOwnerVisibleInGovernance` (legacy System-C: `users/{uid}.governanceReviewerUid`/`governanceReviewerFor`) | `/api/governance/**` |
| E | `requireAdminApiAccess`/`requireAdmin` — `admin: true` claim only, zero ownership scoping | `/api/admin/**` |
| F | `resolveAdaptiveExportVerdict` (plan entitlement, layered on top of Idiom A) | export routes only |
| G | Query-scoped (`.where("userId","==",uid)` or a `collectionGroup` filtered on the caller's own uid) — the query itself is the authorization boundary, no per-doc check follows | `panel-history`, `reviews` inbox |

**Confirmed exactly what the prompt asked to investigate**: `authorizeWorkspaceResourceAccess()`, `checkWorkspaceAccess()`, and `resolveWorkspaceContextForResource()` **all already exist** (`lib/workspaces/workspaceAccess.ts`, `lib/workspaces/workspaceResolver.ts`), are fully typed, fully unit-tested (`workspaceResolver.spec.ts`, `workspaceAccess.spec.ts`), and are **called by zero routes**. They are Phase 1 deliverables, built specifically so a later phase would have "a single, already-tested place to call rather than re-deriving this logic per route" (the module's own header comment).

**Critical gap found in the existing Phase 1 code, not previously exercised because nothing calls it yet**: `checkWorkspaceAccess()` checks *requester-uid* against `workspace.ownerUserId`. It never checks *`run.userId`* against `workspace.ownerUserId`. `authorizeWorkspaceResourceAccess()`'s `legacyOwnerUserId` parameter is only consulted on the `legacy` branch — it plays no role once resolution reaches `resolved`. **This means the existing Phase 1 code, reused as-is, does not protect against a Workspace document whose `ownerUserId` has been mutated to point at someone other than the run's actual owner** (Threat 8, below) — it only protects against the *requester* not matching. Phase 4B must add one new, explicit cross-check that doesn't exist anywhere in the codebase today: `resolution.context.ownerUserId === run.userId`. See §7.

## 5. Phase-1 resolver semantics — confirmed by direct code read

`resolveWorkspaceContext()` (`lib/workspaces/workspaceResolver.ts:76-134`), pure, exhaustively tested:

| Input | Outcome |
|---|---|
| `workspaceId` truly `undefined` | `legacy` — the **only** path to legacy, regardless of flag state |
| `null` / `""` / whitespace / wrong type, `W=true` | `malformed` |
| same, `W=false` | `workspaces_disabled` (checked *before* the malformed check — presence alone triggers this) |
| valid id, Workspace doc missing | `not_found` |
| Workspace doc malformed (bad schema/id/type/owner) | `malformed` |
| Workspace doc id ≠ requested id | `malformed` (double-enforced: once at the Firestore-read layer, once in the resolver) |
| `ownerUserId` empty/falsy | `malformed` |
| `ownerUserId` present but mismatched vs. *requester* | **not a resolution failure** — resolves `resolved`; the mismatch is an access-layer denial (`checkWorkspaceAccess` → `not_owner`) |
| `type !== "personal"` | `unsupported_workspace_type` |
| Firestore read throws / unavailable | `lookup_failed` (both cases collapsed) |
| `W=false`, `workspaceId` present in any form | `workspaces_disabled` — **no Firestore read is even attempted** |

This exactly satisfies the "never downgrade to legacy" invariant already — Phase 4 does not need to re-derive this, only compose around it correctly.

## 6. Resource classification (adopted, matches the user's proposed design exactly)

`LEGACY` / `WORKSPACE_BOUND_VALID` / `WORKSPACE_BOUND_INVALID`, derived solely from `resolveWorkspaceContext()`'s `kind` (`legacy` → LEGACY; `resolved` → VALID; everything else → INVALID). No truthiness checks anywhere — the resolver already enforces this.

## 7. Associated-run authorization — two-layer composition (corrected)

**Layer A (integrity) and Layer B (grant) are strictly separate, and Layer A executes for every canonical-run resource carrying a `workspaceId`, in every route that discloses run content or metadata — unconditionally, before Layer B, regardless of the requester's role.** No caller's role — owner, reviewer, admin — determines whether Layer A runs. This was stated correctly in the original draft's abstract framing but the original §7 undermined it by treating admin and team as "unaffected" in a way that implied integrity was conditional on route type; it is not. It is conditional only on one thing: does this resource have a `workspaceId`.

**Layer A — requester-independent integrity primitive.** `resolveWorkspaceContextForResource({workspaceId, legacyOwnerUserId})` already takes no requester identity (confirmed by its own signature — this was verified, not assumed) and is therefore already the correct shape for Layer A. It is missing exactly one check identified in §4/§13 below: `resolution.context.ownerUserId === run.userId`. The Phase 4B primitive is a thin new wrapper, not a Phase-1 refactor:

```
validateRunWorkspaceAssociation(run: { userId: string; workspaceId?: unknown }): 
  { classification: "LEGACY" } 
  | { classification: "WORKSPACE_BOUND_VALID"; workspaceId: string }
  | { classification: "WORKSPACE_BOUND_INVALID"; reason: ... }
```
Internally: call `resolveWorkspaceContextForResource({ workspaceId: run.workspaceId, legacyOwnerUserId: run.userId })`; if `kind === "legacy"` → `LEGACY`; if `kind === "resolved"` **and** `context.ownerUserId === run.userId` → `WORKSPACE_BOUND_VALID`; every other case (including a `resolved` context whose owner doesn't match the run) → `WORKSPACE_BOUND_INVALID`. Takes no `uid` parameter at all — it cannot be handed a requester identity even by accident, which is the property that makes it safe to reuse identically across owner routes, reviewer routes, admin routes, and list routes without risk of the two layers being conflated at a call site.

**Layer B — existing authorization, unchanged, runs only after Layer A passes.** For `LEGACY`: zero Workspace lookup, exact existing route logic (Idiom A/A′/B/C/D/E as already implemented). For `WORKSPACE_BOUND_VALID`: the route's existing owner/reviewer/admin/team logic runs exactly as today — reviewer access via `resolveAdaptiveRunAccess()` is untouched, a reviewer still never needs to own the Workspace. For `WORKSPACE_BOUND_INVALID`: **deny, full stop, before Layer B is even reached** — this is the same for every requester, including the run's own owner (§13 in the original prompt: "invalid bound run + requester == run.userId → deny. `run.userId` cannot rescue an invalid Workspace association.").

| Requester | `LEGACY` | `WORKSPACE_BOUND_VALID` | `WORKSPACE_BOUND_INVALID` |
|---|---|---|---|
| Owner | allow (existing logic, unchanged) | allow (existing logic, unchanged, only after Layer A passes) | **deny — no exception** |
| Assigned personal reviewer | allow (existing logic, unchanged) | allow (existing logic, unchanged, only after Layer A passes) | **deny — no exception** |
| Unrelated user | deny (existing logic, unchanged) | deny (existing logic, unchanged) | deny |
| Admin | allow (existing logic, unaffected) | allow, but **Layer A still executes first** — an admin route is not an exemption from integrity validation; it is an existing Layer-B grant that happens to be broad. If a genuinely separate forensic/corruption-inspection capability is ever wanted for admins to view a known-invalid bound run, that must be a new, explicitly-designed, separately-authorized capability — never an implicit side effect of the existing admin bypass. Not designed here. | deny by default, pending the explicit forensic-capability decision above |
| Team route (Idiom C) | unaffected — team routes never read `run.userId` or `workspaceId` today, and Phase 3 never binds a team-owned run to a Personal Workspace | not currently reachable — Phase 3's `hasTeam` exclusion means no run visible via a team route should ever carry a Personal `workspaceId` in practice; if one somehow did, Layer A would still apply | same |

## 8. Feature-flag model (corrected — rejects the original boolean design)

**The original `WORKSPACE_AWARE_READS_ENABLED=false → skip validation, use legacy auth` design is rejected.** The original justification — "flag off matches pre-Phase-4B behavior, so it's not a downgrade" — compares against the wrong baseline. The security invariant is a standing rule about the *current* state of the world ("`workspaceId` present → must validate"), not a promise never to regress below whatever existed before this feature shipped. Once Phase 4B code exists and a resource carries `workspaceId`, there is no safe moment for that resource to be served without Layer A running — "we used to not check this" does not make skipping the check acceptable now that checking it is the whole point.

**Adopted: no conventional read-enable flag (Model B).** Phase 4B does not create a new Workspace-derived *grant* — Layer B is unchanged. It only adds a mandatory *integrity precondition* in front of grants that already exist. An integrity precondition is not an optional feature and should not have a runtime on/off switch, for the same reason a signature-verification step wouldn't get a boolean bypass.

**Why an account-scoped or run-scoped canary (mirroring Phase 3A) does not work here, unlike the write side:** Phase 3A's canary was safe because *writing* `workspaceId` is opt-in per account — a non-canary account's runs simply never receive the field, so there's nothing to under-protect. Phase 4B's situation is different: **because global `RW=true` has been live since Phase 3D, runs already exist (and keep being created) with `workspaceId` set, for accounts that would not be in any hypothetical read-canary allowlist.** A canary flag that validates only for allowlisted accounts would leave every *other* account's already-bound runs unvalidated on read — exactly the forbidden downgrade, just scoped to "everyone not on the allowlist" instead of "everyone." There is no safe way to make Layer A conditional on the requester's account.

**Rollout mechanism**: ship a complete read-equivalence class (§ "Phase 4B implementation unit" below) as ordinary reviewed code through the standard deploy pipeline (branch protection, CI, Vercel deploy) — the same mechanism used for every other code change in this codebase, not a runtime toggle. Before shipping, run the mandatory pre-deployment reconciliation (§13) as a gate: if any currently-bound run fails integrity, block the deploy until investigated (never repair automatically as part of the gate).

**Emergency response, if something goes wrong post-deployment**: preferred is fix-forward (patch, redeploy, ~2-3 min per the measured Phase 3A/3C figures). A genuine code-level rollback (reverting to pre-Phase-4B code) is permitted **only after a fresh read-only integrity sweep proves every currently-bound run is valid** — because rolling back to code that never calls Layer A has the *exact same* safety property as Layer A itself, for a data set that's already 100% valid; it stops being safe the moment even one bound run is actually invalid, since rolling back would then serve that invalid run under legacy auth. If the incident *is* an integrity problem (some bound run really is invalid, or the check itself has a bug), the correct response is fix-forward or a targeted deny for the specific affected run(s) — never a global relaxation, and never a rollback used as a way to avoid dealing with a real integrity finding. This is a procedural runbook requirement, not a code mechanism — no new flag is introduced to implement it.

**`WORKSPACES_ENABLED=false` is confirmed, again, not usable as a read rollback.** For any resource already carrying `workspaceId`, this produces `workspaces_disabled` — itself a deny — which is safe in the sense that it doesn't downgrade to legacy, but it also breaks legitimate owner/reviewer access to that resource entirely. It is not a "rollback" in any useful sense; it is closer to an outage for the affected records. `W` remains what it has always been documented as: an authorization/read prerequisite, never a routine operational lever.

## Lists and bulk reads (new section — corrects the original "reviewer inbox can skip validation" error)

Any route response that discloses `runId`, question/title, status, report metadata, model metadata, `createdAt`, owner, review metadata, or export metadata for a canonical run is part of the read surface and is in scope for Layer A — **including list/bulk routes.** A detail route denying a corrupt bound run while a list route still shows its title/status/metadata is a leak of exactly the fact Layer A exists to protect, so list and detail authorization must agree.

**Per-route-class policy:**
- **Owner history (`panel-history`)**: every row in a given response shares the *same* authenticated caller as owner, and every Personal adaptive run for a given owner binds to the *same* deterministic Workspace (`personal-{ownerUid}`) by construction. So an owner-scoped list needs **at most one** Workspace lookup per request, applied to every bound row in that page — not one lookup per row. This is a real O(1) property of the data model, not an approximation.
- **Reviewer inbox (`user/reviews`) and reviewer history**: rows come from different owners, so `workspaceId` varies per row. Do **not** skip validation (the original error). Instead: collect the distinct `workspaceId` values present on the page, batch-fetch each **unique** Workspace exactly once (Firestore `getAll()` on the deduplicated doc references — the same batching idiom `user/reviews` already uses for its parent-run batch-get today), then apply each resolved result to every row that shares that `workspaceId`. Worst case is bounded by the number of *distinct* owners on the page, not the number of rows, and it's one round-trip via `getAll()`, not N sequential reads — avoiding true N+1 latency while still performing full per-row integrity validation.
- **Export history, governance lists, admin run lists**: same requester-agnostic Layer A applies to any row that discloses canonical run identity/content. A governance route that returns *only* `governanceRecord` fields without run identity/content is a child-resource disclosure, not a canonical-run disclosure, and does not need Layer A wired in — but the moment a route returns run identity or content (question, status, title, owner), it's in scope. This distinction must be made per-route during Phase 4B implementation, not assumed.
- **Invalid-row policy**: **omit the row from the response and emit a structured server-side diagnostic (log, with the resolver's specific reason) — never fail the entire list, never silently include the invalid row.** Failing the whole list over one bad row is its own regression (one corrupted association could take down an owner's entire history page); silently including it is the forbidden downgrade. Omit-and-log already has direct precedent in this codebase: `user/reviews` already skips a row when its governance record is malformed, logging a warning rather than failing the whole inbox or fabricating the row.
- **Transient vs. persistent failure**: a transient `lookup_failed` (Firestore hiccup) should also omit the row from that specific response (fail closed for *that* request) but is expected to resolve on a subsequent request with no state change needed — worth a lower-urgency log/alert than a persistent `not_found`/`malformed`/`unsupported_workspace_type`, which will recur on every request until investigated and warrants operator attention.

## 9. Error semantics

Recommend collapsing the resolver's 5 distinct invalid-outcome reasons into route-facing responses **consistent with each route's own existing convention**, not a new global standard — `user/runs/[runId]/exports/[exportId]` already deliberately returns `404` (not `403`) for non-owner to avoid confirming resource existence; other routes use `403`. Changing an existing route's external status code is itself a compatibility-relevant decision, out of scope for this architecture pass. Internally, always log the specific resolver reason (`not_found`/`malformed`/`unsupported_workspace_type`/`lookup_failed`/`workspaces_disabled`/the new ownership-cross-check failure) for operator diagnostics — never expose which specific reason externally, since that would let a caller distinguish "this Workspace doesn't exist" from "you're not its owner," a private-existence leak.

## 10. Historical run inventory — production data, read-only

Total runs: **194**. Field presence (`adminDb.collection("runs")`, structural keys only, zero question-text reads):

| Signal | Count | Meaning |
|---|---|---|
| `workspaceId` | 4 | Already Workspace-associated (Phase 3A/3C/3D) |
| `adaptiveOutput` | 60 | Milestone-2 adaptive schema (9 schemas) |
| `legacyAdaptiveOutput` | 31 | Legacy-family adaptive schema (8 schemas + factual_lookup) |
| neither | 103 | Non-adaptive (plain Deep Research) |
| `governanceStatus` | 64 | **Not used as an adaptive marker** — does not correlate 1:1 with `adaptiveOutput`/`legacyAdaptiveOutput` counts; likely a broader/older field also used by the non-adaptive team policy engine. Flagged for a closer code-level look if Phase 4C ever needs it; not relied on here. |

`adaptiveOutput`/`legacyAdaptiveOutput` are the only markers used for the adaptive/non-adaptive axis — both are written by exactly one function each (`persistAdaptiveOutput`/`persistLegacyAdaptiveOutput`, `lib/firestore/runs.ts`), confirmed by direct source read, never inferred from question text, output shape, or model count.

**Earliest run overall: 2026-04-01. Earliest with `adaptiveOutput`: 2026-08-05. Earliest with `legacyAdaptiveOutput`: 2026-08-06.** Consistent with the Adaptive Result Schema System's documented production-enablement date (2026-08-05) — any run before that date is definitely non-adaptive by construction, not by inference.

### The decisive Personal-vs-Team finding (corrected — now with the required proof)

The original draft asserted "zero teams have ever existed" directly from the current-empty `teams` collection, without first establishing that a team document, once created, can't later be removed. That's a real gap: collection-empty-today only proves collection-was-always-empty if deletion is structurally impossible. This has now been checked directly rather than assumed.

**Team documents cannot be deleted through any code path in this repository, confirmed exhaustively.** Every reference to `collection("teams")` across the entire codebase (`app/`, `lib/`, `scripts/`) was enumerated and each one is a `.get()` (read), `.set()` (creation, `app/api/teams/route.ts`), or `.update()` (member-array mutation in `app/api/teams/members/route.ts`, policy-rules mutation in `app/api/teams/policies/route.ts`, a team-review write in `lib/firestore/runs.ts`). **Zero `.delete()` calls exist against a `teams/{teamId}` document anywhere.** No team-deletion route exists. The one route that removes a *member* (`DELETE /api/teams/members`) only filters that uid out of the `members` array via `.update({members})` and clears the member's own `teamId`/`teamRole` — it never touches the team document itself, so a team that loses every member still exists as a document with an empty `members` array, and would still have been counted by the `teams` collection query. Admin user deletion (`DELETE /api/admin/users/[uid]`) only deletes `users/{uid}` — zero cascade into `teams`. No cleanup/migration script referencing team deletion exists.

Given that, **the current-empty `teams` collection is now genuinely sufficient historical proof**: if a team had ever been created at any point in this project's history, its document would still exist today regardless of what later happened to its members, and would have appeared in the collection scan that found zero documents. **This means every one of the 194 runs was necessarily created in Personal context** — not inferred from any user's *current* `teamId` (which the program explicitly forbids using for historical classification), and not merely asserted from current state, but proven from the conjunction of (a) team creation is the only lifecycle event that writes the collection, (b) no deletion path exists, and (c) the collection is empty now. The `teamRuns` collection being separately empty is consistent corroboration, not the primary evidence.

**What changed from the original draft is the proof, not the conclusion** — the number (0 `DEFINITELY_TEAM`, 87 `DEFINITELY_PERSONAL_ADAPTIVE`) is unchanged, but it was previously asserted and is now established.

### Classification result

| Category | Count |
|---|---|
| `ALREADY_WORKSPACE_ASSOCIATED` | 4 |
| `DEFINITELY_PERSONAL_ADAPTIVE` (adaptive marker present; Personal confirmed via zero-teams-ever-existed) | 87 |
| `DEFINITELY_TEAM` | 0 |
| `DEFINITELY_NON_ADAPTIVE` | 103 |
| `AMBIGUOUS` | 0 |
| `MALFORMED` (missing `userId` or `status`) | 0 |

87 + 4 = 91 = 60 (`adaptiveOutput`) + 31 (`legacyAdaptiveOutput`), reconciling exactly. 87 + 0 + 103 + 0 + 0 = 190 = 194 − 4, reconciling exactly.

**No question text was read at any point in this audit.** Classification used only: `workspaceId` presence, `adaptiveOutput`/`legacyAdaptiveOutput` presence, `userId`/`status` presence, and full enumeration of the `teams` and `teamRuns` collections.

## 11. The Workspace-associated population is dynamic (corrected — was originally treated as a fixed 4)

The original draft's population of 4 associated runs was accurate at audit time but was implicitly treated as if it would still be 4 when Phase 4B ships. That's no longer a safe assumption: **global `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED=true` has been live since Phase 3D**, so every new Personal adaptive run created between this audit and Phase 4B's actual deployment acquires a `workspaceId` automatically. The population Phase 4B must protect is "every run with `workspaceId` present at deployment time," not a number from this document.

**Mandatory pre-deployment gate (re-run immediately before shipping Phase 4B, not relied on from this audit):** for every currently-bound run, require `workspaceId` is a valid non-empty string, `workspaceId === personal-{run.userId}`, the Workspace document exists, its embedded `id` matches, `ownerUserId === run.userId`, `type === "personal"`, and `schemaVersion` is supported. **If any bound run fails any check, the Phase 4B deployment is blocked** until investigated — never auto-repaired as part of the gate.

A fresh read-only recount at the time of this correction (2026-08-14, same day as the original audit): **194 total runs, 4 bound, 190 legacy — unchanged in absolute terms, but confirmed via a fresh query rather than reused from the earlier count.** All 4 currently-bound runs pass every gate check listed above with no exceptions. This is a snapshot, explicitly not a number to hardcode into Phase 4B's design — the gate itself, re-run at actual deployment time, is the durable artifact.

## 12. Backfill architecture (design only — Phase 4C, not built)

- **Eligible class**: `DEFINITELY_PERSONAL_ADAPTIVE` only (87 currently). `DEFINITELY_NON_ADAPTIVE` and `ALREADY_WORKSPACE_ASSOCIATED` are never touched by a backfill tool.
- **Workspace prerequisite**: mirrors Phase 3's binding check exactly (`type=personal`, `ownerUserId=run.userId`, `id` matches, `schemaVersion` supported). Fails → classify, do not write.
- **Never auto-provisions.** Never calls `ensurePersonalWorkspace()`/`createPersonalWorkspace()` — a run whose owner lacks a Workspace is classified `workspace_missing` and skipped, exactly like Phase 3's write-time behavior. Given the Phase 3B/3C/3D reconciliation showed 89/89 (now presumably higher) coverage with 0 missing, this should rarely fire in practice, but the tool must never repair it inline.
- **Write only if `workspaceId` truly absent** — reusing Firestore's `undefined`/field-absence semantics, never a truthiness check. Never overwrite an existing valid, invalid, null, or empty `workspaceId` — those require separate investigation, never migration-repair.
- **Concurrency**: Firestore transaction or `updateTime` precondition per candidate, mirroring Phase 2B's `mapWithConcurrency` bounded-worker-pool pattern (5 default, 20 ceiling) — never blind-overwrite a run that changed between read and write.
- **Idempotency**: rerunning after a successful pass must show `writes: 0`, `already_valid: <prior count>` — mirrors Phase 2B's own proven idempotency contract exactly.
- **Dry-run default**, `--execute` required, same production guard chain as Phase 2B (`--confirm-project=`, `ALLOW_*` literal env var, `NODE_ENV`/`VERCEL_ENV` defense-in-depth, interactive confirm unless `--yes`).
- **Artifact**: `runId`, `ownerUid` (if needed for verification), classification, status, reason code only — never question text, model output, or email. Gitignored, same as Phase 2B's `workspace-provisioning-*.json` convention.

## 13. Threat model — key scenarios

| Scenario | Required outcome | Basis |
|---|---|---|
| Deleted Workspace (run has `workspaceId`, doc later removed) | Deny (`not_found`) | Existing resolver behavior, confirmed |
| **Workspace owner mutated** (`run.userId=A`, `workspace.ownerUserId` changed to `B`) | Deny | **Requires the new cross-check from §4/§7 — the existing bundled helper alone does not catch this**, since it only compares requester-vs-workspace-owner, never run-vs-workspace-owner |
| Workspace `type` mutated to `"team"` | Deny (`unsupported_workspace_type`) | Existing resolver behavior, confirmed — team Workspaces remain categorically unsupported, no shared-access inference |
| Unsupported future `schemaVersion` | Deny (`malformed`, collapsed — no separate `unsupported_version` outcome exists for Workspace docs today) | Existing `isWellFormedWorkspaceV1` guard, confirmed |
| Firestore lookup failure | Deny (`lookup_failed`), distinguishable internally from `unauthorized` for operator diagnostics, never externally | Existing resolver behavior, confirmed |
| Client-supplied `workspaceId`/`ownerUserId`/`bypassWorkspace=true` etc. | Structurally impossible — classification derives solely from the server-fetched `run` document; a dedicated regression test already proves `workspaceId` is inert on every current read route | Confirmed via `phase3WorkspaceIdInert.spec.ts` + direct grep |
| Export/regeneration as an alternate read channel | Regeneration (`GET .../exports/[exportId]`) already re-checks *current* ownership and *current* plan entitlement on every call (not a permanent grant frozen at creation) — Phase 4B must extend this same live re-check to include the Workspace integrity gate, not just ownership | Confirmed via direct route read |
| History/reviewer-inbox list vs. detail-route consistency | **Corrected.** List routes are query-scoped for *access* (who can see which rows), but that's Layer B, not Layer A — a row's own Workspace association can still be invalid regardless of who's allowed to see the row. List and detail routes must apply Layer A consistently, or a list can disclose metadata for a run the detail route would deny. See "Lists and bulk reads" (§7 addendum) for the corrected per-route-class policy. | Original row was the second security error corrected in this pass |
| N+1 performance risk at scale (Phase 4C/4D) | Avoidable **without skipping validation**: owner-scoped lists need one Workspace lookup per request (every row shares the same deterministic owner-Workspace). Reviewer-scoped lists need one batched `getAll()` over the distinct `workspaceId` values on the page — bounded by unique owners, not row count, and one round-trip, not N sequential ones. Reviewer rows are still fully validated, just efficiently. | Design recommendation, not yet implemented — see "Lists and bulk reads" |

## 14. Sequencing — confirmed

**Option A (validate reads on the 4 already-associated runs first, then backfill) is correct**, on failure-blast-radius grounds alone: 4 known-clean runs vs. 87+ legacy runs is a two-orders-of-magnitude difference in exposure for a first production read-authorization change. No change to the proposed A→B→C→D subphase split.

## 15. Rollback model (corrected — no flag-based rollback exists; procedural, sweep-gated code rollback only)

There is no runtime flag to roll back, by design (§8). Rollback is a **procedure**, not a switch:

- **Legacy fallback is never permitted, at any point, for any reason.** A known-invalid bound run must never become accessible through legacy `userId`/reviewer authorization, whether via a flag, a code rollback, or an operator override.
- **`WORKSPACES_ENABLED=false` remains not usable as a rollback** — for any resource already carrying `workspaceId`, it produces a deny (`workspaces_disabled`), not a restoration of prior access; it would break legitimate owner/reviewer access to those specific resources rather than fixing anything.
- **A genuine code-level rollback (reverting the deployed commit to before Phase 4B) is permitted only after a fresh read-only integrity sweep proves every currently-bound run is valid.** Reasoning: reverting to code that never calls Layer A is only as safe as Layer A itself when 100% of the current bound population is already valid — at that point, "validate" and "don't validate" produce the identical allow/deny outcome for every existing row, so the revert is observably risk-free for current data (though it reopens the window for a *future* invalid association to go unvalidated, which is why this is an emergency measure, not a routine one).
- **If the incident is itself an integrity problem** (a bound run really is invalid, or the validation logic has a bug), rolling back does not fix that — it would serve the invalid run under legacy auth, which is the exact outcome being prevented. The correct response is fix-forward, or a targeted deny for the specific affected run(s) while a fix is prepared — never a global relaxation used to route around a real finding.
- **The underlying owner/reviewer authorization code must never be deleted from any route, in Phase 4B or any later phase — only wrapped by the new Layer A gate.** This is what keeps a code-level rollback conceptually simple (removing the wrapper, not reconstructing deleted logic) if it's ever needed under the sweep-gated condition above. If a future phase ever removes the legacy auth path in favor of Workspace-only logic, that is a materially different and more dangerous decision requiring its own explicit review — not something to do incidentally while implementing Phase 4B/4C/4D.

## 16. Protected systems — confirmed untouched, directly verified

`app/api/verify-claim/route.ts` never writes to the `runs` collection (confirmed via direct grep — zero matches). `app/api/verify-video/route.ts` writes only to `videoVerifications` (confirmed via direct grep). Both are structurally isolated from this entire program, not merely policy-excluded — there is no `runs`-collection code path for either to accidentally intersect with.

## 17. Phase 4A decision (final, post-correction)

Architecture is now closed and sufficiently defined to proceed to Phase 4B design/implementation. Three things changed in this correction pass, none of which invalidate the overall direction: (1) the read-rollout mechanism is code-deploy-based with no runtime flag, not the originally-proposed boolean; (2) every canonical-run-disclosing route, including list/bulk routes, is in scope for Layer A — nothing is exempt by route type; (3) the Personal-vs-Team historical conclusion is unchanged (0 team runs, 87 Personal-adaptive) but now rests on a proven fact (team documents cannot be deleted) instead of an unproven assertion. A concrete new implementation requirement was also identified that did not exist in the codebase before this audit: the run-to-workspace ownership cross-check (§7). The associated-run population must be treated as dynamic and gated fresh at deployment time (§11), not assumed from this document. Read rollout can avoid a security downgrade because no runtime lever exists that could cause one — the only rollback path is a procedural, sweep-gated code revert (§15), never a flag.

Phase 4C's classification foundation (adaptive markers, Personal-vs-Team) is now proven, not merely provisional — but Phase 4C readiness to *implement* remains gated behind Phase 4B shipping and proving itself first (§14's sequencing decision is unchanged).
