# Phase 4C-A — Historical Personal-vs-Team Provenance Audit

## Correction (Phase 4C-A2, read-only follow-up)

The original version of this document classified all 87 legacy adaptive runs as `PROVEN_PERSONAL_ADAPTIVE` based on the joint absence of the `runs.teamGovernance` field and a matching `teamRuns` document. **That conclusion has been withdrawn.** A focused correction pass proved the underlying assumption — that at least one of those two markers was guaranteed to persist for every successful team-owned adaptive run — is false, and did so with a direct, explicit, existing test rather than inference:

`app/api/run-panel/__tests__/adaptiveTeamReviewProjectionWiring.spec.ts:419`, `"projection-creation failure preserves the adaptive answer and HTTP 200"` — a genuine team-eligible adaptive request (`loadUserAndTeam` returns a real team with `enabled:true`) whose `createAdaptiveTeamRunProjection` call returns `{status:"write_failed"}` still produces `response.status === 200`, `body.ok === true`, and `body.adaptive.adaptiveOutput` fully persisted and equal to the genuine output. The only difference is a transient HTTP-response field (`adaptiveTeamReviewProjectionStatus: "failed"`) that is **never itself written to Firestore**. Two further tests in the same file confirm the identical outcome when `loadUserAndTeam` or `createAdaptiveTeamRunProjection` outright *throw*, not just return a failure status.

Separately, direct re-reading of `lib/governance/teamGovernancePipeline.ts` (the legacy-path mechanism) shows the same shape: if the `teamRuns` write throws, the function returns early with **no `runs.teamGovernance` write ever attempted at all** — and the caller (`synthesize-panel/route.ts`) does not check this outcome before returning its own `200` to the client. Both markers, on both historical mechanisms, are **best-effort, non-transactional, secondary writes that execute after the canonical run is already complete** — never a precondition for canonical success. This is also explicitly documented intent elsewhere in the codebase (`docs/governance-decision-receipts-design.md`, on why `teamRuns` deliberately does not gate the canonical write: "a system that required BOTH writes to succeed would make `teamRuns` load-bearing again by accident").

**Consequence:** marker absence does not prove Personal origin. All 87 records have been reclassified `AMBIGUOUS_CONTEXT`. See the "Phase 4C-A2" sections below for the full re-analysis. The original per-section findings on team-deletion capability, git chronology, and the `createRun`/`PanelRun` canonical-schema analysis remain accurate and are retained below — only the marker-absence inference has been withdrawn.

Read-only investigation. No code changes, no production mutations, no `workspaceId` writes. Performed 2026-08-14/15 against `main` at `0cab412f06e1c7d206d9d5a030e782be0d713472` (Phase 4B production activation commit) and the live `convergepanel` Firebase project.

## Why this exists

Phase 4A concluded the legacy adaptive population was "probably Personal" from an empty current `teams` collection and the absence of a team-deletion code path in current source. That was sufficient to unblock Phase 4B (which never mutates history) but is not sufficient to irreversibly write `workspaceId` onto historical runs. This audit replaces "current state looks empty" with record-level, timestamped, historically-deployed evidence.

**Primary rule applied throughout:** classification never used current `users/{uid}.teamId`, current team membership, question/output text, or UI shape. Every conclusion below is derived from git history (what code was deployed, and when) and from **immutable, point-in-time markers persisted onto the canonical run at the moment it was created/synthesized** — never from what the data looks like today.

## 1. Repository / production baseline

- `origin/main` = local `HEAD` = `0cab412f06e1c7d206d9d5a030e782be0d713472` (fast-forwarded during this audit; matches the deployed production commit)
- Production deployment: `dpl_FSvSdAH9MmfTuV5Ta6aRv3miTC7Q`, Ready, aliased to convergepanel.com
- `P=true`, `W=true`, `RW=true`, canary=absent; Phase 4B Layer-A read integrity: live
- Repository size: 257 total commits, first commit `639b065` (2026-02-05)

## 2–9. Git-history team-lifecycle reconstruction

Searched full history (`git log --all`, `-G`/`-S` content search, `git rev-list --all` combined with `git grep` per-commit, deleted-file inventory) — not limited to `main`'s current tree.

| Item | Finding | Commit / evidence |
|---|---|---|
| First team commit | `1e19c8a` "Governance and Claim Verification" | 2026-03-25 16:36:19+03:00 — confirmed ancestor of `origin/main` (real deployed history, this repo auto-deploys `main` on merge) |
| First team creation route | `app/api/teams/route.ts` `POST` — same commit | Team ID format at creation: `` `team_${uid.slice(0,8)}_${Date.now()}` `` |
| First team adaptive-run support | `1785748` "Adaptive Result Schema platform + multi-reviewer governance" | 2026-08-01 23:33:33+03:00 — introduces `lib/firestore/teamRuns.ts` (`createAdaptiveTeamRunProjection`, `.create()`-based, Milestone-2-only) |
| First team governance support | Same as first team commit (`1e19c8a`) — `lib/governance/teamGovernancePipeline.ts` (`applyTeamGovernancePipeline`) shipped alongside team creation itself | 2026-03-25 |
| First `teamRuns` usage | **Corrected during this audit**: an initial regex search wrongly suggested `teamRuns` had zero writers between 2026-03-25 and 2026-08-01 (multi-line `.doc(id).set(...)` pattern wasn't matched by the first, too-strict `-G` pattern). Direct inspection of `1e19c8a`'s `teamGovernancePipeline.ts` proves `teamRuns` was written **from the same commit that introduced teams** — no gap. | `1e19c8a`, confirmed by direct `git show` |
| First production-capable team run | 2026-03-25 (same day as team creation) | `1e19c8a` |

**Historical team delete path found:** NO. `app/api/teams/route.ts` has been touched by exactly one commit ever (`1e19c8a`) — GET + POST only, never a DELETE, never modified since. Full-history search (`git log --all -G'deleteTeam|removeTeam|purgeTeam|cleanupTeam|teamDelete'`) across all 257 commits and all branches: zero matches. Full-history search for `.doc(...).delete()` on any team-ish path: zero matches.

**Historical deleted-cleanup-script found:** NO. Across all history, only **18 files have ever been deleted** repo-wide (`git log --all --diff-filter=D`); none are scripts, migrations, tools, admin utilities, or team-related. There has never been a script capable of deleting `teams/{teamId}` that was later removed.

**Historical account-deletion cascade found:** NO. `app/api/admin/users/[uid]/route.ts`'s `DELETE` handler has existed, byte-identical in scope, since the repository's very first commit (`639b065`, 2026-02-05 — predates teams entirely) through the current commit. Diffed both endpoints: the only change ever made was error-message redaction (security hardening, 2026-05-12), never a scope change. It deletes exactly two things: the Firebase Auth user, and the `users/{uid}` Firestore document. It has **never** touched `teams`, `runs`, `teamRuns`, or any governance/review collection, in any historical version.

**Recursive delete capability found:** NO. Zero matches anywhere in history for `recursiveDelete`, `bulkWriter`, or `batch.delete` combined with a teams/runs collection reference. The only `FieldValue.delete()` usage found (`app/api/teams/members/route.ts`, present since `1e19c8a`, unmodified since) removes the `teamId`/`teamRole` **fields from the removed member's own `users/{uid}` doc** — a "leave team" side effect, not a team-document deletion — and explicitly forbids removing the `owner` role member (`403 cannot_remove_owner`). The `teams/{teamId}` document itself is only ever `.update()`d (to shrink the `members` array), never `.delete()`d, anywhere in history.

## Team-run canonical shape / immutable markers

This is the central finding of the audit.

**The canonical `runs/{runId}` schema has never had a `teamId` field, in any commit since 2026-02-05.** `createRun()` (`lib/firestore/runs.ts`) has always taken `(runId, userId, question, selectedModels[, workspaceId])` — never a team parameter — and the `PanelRun` interface has never declared one. Team and Personal runs are created through the **identical** function, writing the **identical** schema. A run's team-vs-personal origin therefore cannot be read off any single field of the canonical document by itself.

Two independent, unconditional, run-time-triggered mechanisms exist instead, both of which persist a permanent, immutable, point-in-time record — neither is affected by later membership changes (a member removed from a team afterward does not retroactively change what was already written):

1. **Legacy path — `applyTeamGovernancePipeline()`** (`lib/governance/teamGovernancePipeline.ts`, unmodified since `1e19c8a`, 2026-03-25). Called **unconditionally** at the end of every successful `POST /api/synthesize-panel` request that has a `runId` (confirmed: single call site, not gated behind any schema-family branch — reached for legacy, legacy-adaptive, and Milestone-2 adaptive runs alike, since all schema-family branches feed the same final response path). Reads `users/{uid}.teamId` **at that exact moment**; if absent, returns `{}` immediately with **zero writes**. If present, it (a) creates a `teamRuns/{teamId}-{uid}-{timestamp}-{random}` document, and (b) — only after that write succeeds — merges `{ teamGovernance: <snapshot> }` onto `runs/{runId}`. So `runs/{runId}.teamGovernance` presence is a dual-confirmed marker: proves both a `teamRuns` write and the run-doc merge succeeded, at the moment this run's synthesis completed, for an owner who was on a team **at that instant**.
2. **Milestone-2 path — `createAdaptiveTeamRunProjection()`** (`lib/firestore/teamRuns.ts`, introduced 2026-08-01). Called from `app/api/run-panel/route.ts`'s adaptive-schema block, gated on `loadUserAndTeam(uid)` returning a team at run-creation time. Uses `.create()` (atomic create-if-absent, never overwrite) into `teamRuns/{teamId}_{runId}`.

**Could a team run exist in the `runs` collection without either marker?** Only if the owner was never on a team when synthesis ran (true Personal) or if the best-effort write failed. Both writes are wrapped in try/catch that log-and-continue rather than throw, so a failure is theoretically possible per-run; a **systemic failure across every one of 87 runs, 6 distinct owners, over 8 days** is not a plausible alternative explanation and is disclosed here as the residual, non-zero uncertainty rather than hidden.

## 10–14. Production run inventory (read-only, structural fields only — no question/output content read)

Recomputed from scratch, not assumed:

- **Total runs:** 197 | **Bound:** 7 (bound-valid: 7, bound-invalid: 0) | **Legacy:** 190
- **Legacy adaptive** (has `adaptiveOutput` or `legacyAdaptiveOutput`, not both): **87** — matches the figure used throughout the session; now independently reconfirmed by direct count, not carried forward as an assumption.
- **Legacy non-adaptive:** 103
- **Malformed** (missing/invalid `userId`, or both adaptive markers present simultaneously): **0**
- All 87 legacy adaptive runs have `createdAt` between **2026-08-05T02:32Z and 2026-08-13T18:54Z** — i.e., every one of them postdates 2026-08-01 (Milestone-2 launch) by 4+ days. None of the 87 predate team-run capability, so the "predates all team execution capability" proof category does not apply to this population — the dual-marker-absence proof (below) is what applies instead.
- **`runs/{runId}.teamGovernance` marker present:** 0 / 87
- **`teamRuns` document with matching `runId`:** 0 / 87 (queried across the whole `teamRuns` collection, which covers both the legacy doc-ID format and the Milestone-2 `buildAdaptiveTeamRunProjectionId` format in one pass)
- **Current `teams` collection:** 0 documents | **Current `teamRuns` collection:** 0 documents (both fully empty, not just for these 87 owners)
- **Unique owners among the 87:** 6 — all currently exist in Firebase Auth (none disabled, none missing), all currently have a valid Personal Workspace, none currently have `users/{uid}.teamId` set (all disclosed as corroborating context only, per the primary rule — not used as the classification basis)

## 15. Governance/audit residue

`humanReviewHistory`/`humanReviewAssignmentHistory`/`humanReviewPanelHistory` subcollections use `.create()` (atomic, throws on conflict) and have no delete path anywhere in history — same audit as Phase 4B's independent review already established for the read side. No separate residue check was needed beyond the `teamGovernance`/`teamRuns` markers above, since those are themselves the governance residue in question for pre-Milestone-2 team runs.

## 16. Git history vs. deployed history

Both `1e19c8a` (first team commit) and `1785748` (Milestone-2) are confirmed ancestors of `origin/main`, and this repository has no separate staging environment or manual-promotion gate (confirmed during Phase 4B's own deployment-pipeline verification) — Vercel auto-deploys `main` on every merge. Reachability on `main`'s ancestry is therefore equivalent to "was deployed to production" for this repo. No unmerged/experimental branch evidence was used anywhere in this audit.

**Limitation disclosed (item 22):** this audit cannot rule out out-of-repository mutation (manual Firebase Console edits, uncommitted local scripts, ad-hoc Admin SDK commands). No audit-log source for such actions exists. This is judged **irrelevant** to the classification, not merely unprovable: the proof used here does not depend on team documents never having been touched out-of-band — it depends only on whether the *specific, immutable markers written onto each of the 87 runs themselves* are present, and those markers are unaffected by any out-of-band operation on the `teams` collection (an out-of-band team edit couldn't retroactively add or remove a `teamGovernance` field on an already-written run document).

## 17–18. Decisions

- **Historical team-deletion-capability decision: `PROVEN_NO_TEAM_DELETION_CAPABILITY`.** Evidence: full-history function-name search (zero matches), full-history deleted-file inventory (18 files ever deleted, none team-related), byte-identical account-deletion scope since before teams existed, single-commit unmodified team-creation route with no DELETE method ever added.
- **Historical team-execution-capability decision:** earliest production date = 2026-03-25 (`1e19c8a`); canonical destination = `runs/{runId}` (shared with Personal, no distinguishing field) + `teamRuns` projection (distinguishing, separate collection); immutable markers = `runs.teamGovernance` (legacy, since 2026-03-25) and `teamRuns` document existence keyed by `runId` (both formats, since 2026-03-25 and 2026-08-01 respectively).

## 19–21. Per-run classification

All 87 legacy adaptive runs: **`PROVEN_PERSONAL_ADAPTIVE`**, reason code `personal_schema_marker_absent_dual_mechanism` — both independent, unconditional, run-time-triggered team markers are absent, for markers that (a) have existed and fired unconditionally since before any of these 87 runs were created, (b) are never deleted or retroactively alterable by later membership changes, (c) require an implausible systemic multi-owner multi-day write-failure to explain away.

Zero runs fell into `PROVEN_TEAM_ADAPTIVE`, `AMBIGUOUS_CONTEXT`, or `MALFORMED`.

## 22–23. Operational-history limitations

Covered above (§16). The persisted, per-run schema markers make the residual out-of-repository uncertainty irrelevant to this specific classification, as the task anticipated.

## 24–26. Exclusions confirmed

- The 7 current `workspaceId`-present runs were not touched, not reclassified, and remain `bound-valid` per this audit's own fresh read (matches Phase 4B's end-of-window sweep).
- 103 legacy non-adaptive runs recomputed and excluded — not Phase-4 backfill candidates under the current program scope.
- 0 malformed legacy runs found (checked across the full 190-run legacy population, not only the adaptive subset).

## 27–29. Workspace prerequisite / owner coverage (read-only)

For all 6 unique owners of the 87 proven-Personal candidates: deterministic Personal Workspace exists, embedded `id` matches, `ownerUserId` matches `run.userId`, `type=personal`, `schemaVersion=1` supported — **6/6 pass**, all pre-existing (created during Phase 2B provisioning), not created by this audit. Zero missing Workspaces, zero disabled/missing Auth owners among this population. The "deleted Auth owner" policy question (item 29) does not arise for the current 87-run population — noted as a **future Phase 4C-B policy question to resolve if/when a non-Auth-backed legacy owner is ever encountered**, not decided here.

## 30–32. Reproducibility

The classifier is deterministic by construction: same repository revision + same production dataset → same output, since it reads only `runs.teamGovernance` (immutable once written) and `teamRuns` collection membership (immutable once written, never deleted) — no wall-clock or current-membership input. Reason codes used: `personal_schema_marker_absent_dual_mechanism` (all 87). No other reason code was needed for this population; the framework (chronology-based proof for pre-capability runs, marker-based proof for post-capability runs) remains available for any future backfill candidate that doesn't fit this specific case.

## 33. Phase 4C-B gate

Gate conditions from the governing instructions:
- Every automatically eligible run is `PROVEN_PERSONAL_ADAPTIVE` — **yes, 87/87** of the eligible (legacy adaptive) population
- Ambiguous runs excluded — **n/a, zero found**
- Malformed runs excluded — **yes, 0 found and would be excluded if any existed**
- Workspace prerequisites deterministic — **yes, 6/6 owners verified**
- Classification implementable without question/content inspection — **yes**, entirely field-presence-based

**Gate: satisfied for this population.** ~~Phase 4C-B tooling may be scoped to these 87 runs specifically.~~ **Superseded — see Phase 4C-A2 below.**

---

## Phase 4C-A2 — Persistence-Guarantee Correction

### Candidate period
- **Candidate count:** 87 (recomputed fresh, matches Phase 4C-A)
- **Earliest `createdAt`:** 2026-08-05T02:32:33.415Z
- **Latest `createdAt`:** 2026-08-13T18:54:57.904Z
- **Relevant deployed code range:** `1785748` (2026-08-01, Milestone-2 launch) through the current `main` head — all 87 runs were created under this code, so both the legacy pipeline (active since 2026-03-25) and the Milestone-2 projection mechanism (active since 2026-08-01) were live for the entire candidate window.

### Canonical adaptive behavior
- **Can a team adaptive run contain `adaptiveOutput`:** yes, unconditionally — `run-panel/route.ts`'s adaptive-output write happens before, and independently of, the team-review-projection block; the projection block's own test suite proves output persistence is unaffected by projection failure.
- **Can a team adaptive run contain `legacyAdaptiveOutput`:** yes, by the same architecture — the legacy schema family's canonical write and the (also-legacy) `applyTeamGovernancePipeline` call are two independent operations in `synthesize-panel/route.ts`, with the governance call strictly *after* the response object (including `legacyAdaptiveOutput`) is already assembled.
- **Shared `createRun` writer:** confirmed — single function, `(runId, userId, question, selectedModels, workspaceId?)`, no team parameter, ever, in any commit.
- **Canonical Personal/team marker:** **none exists.** The `PanelRun` TypeScript interface (the complete canonical schema, `lib/firestore/runs.ts`) has never declared a team-related field. `teamGovernance` is not part of the typed interface at all — it is an ad hoc, untyped `.set(..., {merge:true})` from a different file.

### `teamGovernance`
- **Canonical or secondary:** secondary (best-effort, post-hoc merge)
- **Written for Milestone-2 adaptive team runs:** yes, if the run has a `runId` — the call site is unconditional across schema families
- **Written for legacy team runs:** yes, same call site
- **Persistence mandatory before success:** **no** — the enclosing `synthesize-panel` response is already built and returned regardless of this call's outcome
- **Failure tolerated:** yes — both the `teamRuns` write and the `runs.teamGovernance` merge are individually wrapped in try/catch that log and continue; a `teamRuns` failure causes the function to return *before even attempting* the `teamGovernance` merge
- **Can later be removed:** no removal capability found anywhere in history (searched for `FieldValue.delete()` / unmerged `.set()` / migration rewrites targeting this field — zero matches) — irrelevant to the corrected conclusion, since the defect is "never guaranteed to be written," not "written then erased"

### `teamRuns`
- **Canonical or projection:** projection, by explicit design documentation
- **Written for Milestone-2 adaptive team runs:** attempted via `createAdaptiveTeamRunProjection`, gated on `loadUserAndTeam`/`routeAdaptiveTeamReview` eligibility
- **Written for legacy team runs:** attempted via the same `applyTeamGovernancePipeline` call as above
- **Persistence mandatory before success:** **no** — directly proven by `adaptiveTeamReviewProjectionWiring.spec.ts:419/434/444` (HTTP 200 + `adaptiveOutput` intact on write failure, `loadUserAndTeam` throw, and `createAdaptiveTeamRunProjection` throw, all three)
- **Failure tolerated:** yes, explicitly tested as a first-class scenario, not merely an unhandled edge case
- **Can later be deleted:** no deletion capability found anywhere in history
- **Rebuilt/repaired:** no repair/reconciliation mechanism found for this specific projection

### Partial-failure analysis
- **Canonical team run can succeed if `teamRuns` write fails:** **yes** (proven by test, both mechanisms)
- **Canonical team run can succeed if `teamGovernance` write fails:** **yes** (the write is strictly after response assembly; failure is caught and logged only)
- **Secondary-failure invariant applies:** **yes** — this matches ConvergePanel's established, documented, cross-cutting rule that secondary/projection/audit writes never invalidate canonical success (the same rule Phase 4B's own review relied on for `humanReviewHistory`/audit writes). It was correctly identified as a general architectural principle in the original audit — the error was applying it only to reason about *reliability*, without following its second consequence: if a write is never guaranteed, its **absence cannot be used as proof of anything** either.

### Historical adaptive markers
- **`adaptiveOutput` / `legacyAdaptiveOutput` team-compatibility:** both can be written on a team-owned run; neither writer has ever been team-aware or team-exclusive — `createRun`/the adaptive-output writers apply identically regardless of the owner's team status. No semantics change found across history relevant to this question (the classification-relevant fact is the *absence* of team-conditional logic in these writers, which was confirmed by inspecting `run-panel/route.ts`'s and `synthesize-panel/route.ts`'s call structure — the adaptive-output write and the team-projection attempt are sibling operations, not a conditional pair).

### Marker-absence proof
- **`teamGovernance` absence alone sufficient:** no
- **`teamRuns` absence alone sufficient:** no
- **Joint absence sufficient:** **no** — both mechanisms can independently fail (or never fire, if `loadUserAndTeam` itself throws) without affecting canonical success, and the failure domains are not meaningfully coupled to a *third*, guaranteed signal that would make their joint failure self-evident
- **Exact reason:** direct test evidence (`adaptiveTeamReviewProjectionWiring.spec.ts`) plus direct source reading of `teamGovernancePipeline.ts` prove neither write is a precondition for the HTTP response the user receives, or for the canonical `runs/{runId}` document's completion.

### Deletion/removal history
- **`teams` deletion:** none found (unchanged from Phase 4C-A)
- **`teamRuns` deletion:** none found
- **`teamGovernance` field removal:** none found
- **Deleted scripts:** none found (unchanged, 18 total repo-wide, none team-related)
- **Migrations:** none exist
- **Out-of-band limitation:** unchanged — still cannot audit manual Console/Admin-SDK operations, but this is now moot for this population since the proof failed on other grounds first

### Final classification (Phase 4C-A2)
- **PROVEN_PERSONAL_ADAPTIVE:** 0
- **PROVEN_TEAM_ADAPTIVE:** 0 (no positive evidence of team origin either — this is not a re-classification to "these are team runs," it is a correct downgrade to "origin cannot be determined from available evidence")
- **AMBIGUOUS_CONTEXT:** 87
- **MALFORMED:** 0

### Proof methods used
- Canonical Personal marker: none available (schema has none)
- Schema/path impossibility: none available (team and Personal runs are byte-identical in canonical shape)
- Mandatory team-marker absence: **disproven** — this was the original (incorrect) basis
- Chronology: not applicable (all 87 postdate team-run capability by 4+ days minimum)
- Other: none found

### Phase decision
- **Phase 4C-A historical proof CLOSED:** no — closed only in the sense that the investigation is complete and conclusive; the *outcome* is that this population is not eligible, not that further investigation would help
- **Deterministically eligible backfill count:** **0**
- **Phase 4C-B ready to implement:** no, for this population. (The tooling design itself — schema/prerequisite validation, dry-run/execute safety pattern — remains valid future work whenever a genuinely eligible population exists, e.g., via a future canonical schema change that adds a real team marker at run-creation time, which would need to be a forward-looking product decision, not a historical-forensics one.)

**Production mutations performed: no**
**workspaceId writes: 0**
**Historical runs changed: no**
**Production flags changed: no**
**Phase 4D started: no**

---

## Formal disposition

- **Phase 4C-B (backfill tooling):** NOT APPLICABLE / CANCELLED SAFELY. Reason: historical Personal-vs-team context cannot be deterministically reconstructed from persisted state. Eligible records: 0. Historical mutations: 0.
- **Phase 4D (staged historical backfill):** will not occur. There is no eligible population to stage.
- **The 87 ambiguous adaptive runs remain legacy permanently**, unless future independent authoritative evidence appears (e.g., an out-of-band data source not covered by this audit's scope).

**Legacy is a supported compatibility state, not a migration failure state.** The existing, unchanged authorization model — `workspaceId` truly absent → existing `userId`/reviewer authorization, exactly as before Phase 3/4 — remains fully valid indefinitely for these records. Declaring the Workspace migration "successful" does not require every historical record to acquire a Workspace; it requires that every record, bound or legacy, resolves to correct, safe authorization on every read. Phase 4B already guarantees that for both populations.

## Permanent architectural lesson

**Absence of best-effort secondary state is not evidence that the associated execution context never existed.**

This mistake is easy to repeat because best-effort projections *look* like they should be reliable signals — they fire "unconditionally" in the sense of always being *attempted* — but "attempted unconditionally" and "guaranteed to persist" are different properties, and only the second one can support a negative inference (absence ⇒ never happened). ConvergePanel deliberately makes several kinds of state best-effort/non-transactional relative to canonical run success (`teamRuns`, `teamGovernance`, and by the same architectural pattern likely also governance projections, audit records, and any future shared-Workspace metadata) specifically so that a downstream write failure never degrades the user-facing result. That reliability property is valuable and should be kept — but it means none of those mechanisms can ever be used, on their own, to prove a historical negative. Any future historical-classification effort should check, before relying on a marker's absence, whether that marker's *presence* was ever actually a precondition for the canonical operation's success. If not, absence proves nothing, no matter how many independent best-effort mechanisms are checked jointly.
