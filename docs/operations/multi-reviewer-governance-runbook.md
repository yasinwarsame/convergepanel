# Multi-Reviewer Governance — Operations Runbook

Step 5: Multi-Reviewer Production-Readiness Hardening, Seeded End-to-End Validation, and Release Controls.

This runbook covers **production-readiness only** — the release-state model, the non-production seed/cleanup harnesses, rollback behavior, observability, and repair procedures for the multi-reviewer governance panel feature (Parts B–F). It does not cover the feature's own design — see `docs/technical-documentation.md` ("Multi-Reviewer ... Parts B–F") and `docs/governance-decision-receipts-design.md` §29–34 for that.

## 1. Release state model

Two independent, additive gates, both required for a team to actually create/reconfigure a panel:

1. **Team opt-in** — `teams/{teamId}.adaptiveMultiReviewerSettings.enabled` (Firestore, per-team, existing since Part B). Absent or `false` for every team unless explicitly set.
2. **Global guard** — `MULTI_REVIEWER_GOVERNANCE_ENABLED` env var (`lib/env.ts`, `=== "true"` pattern). `false`/absent by default in every environment, including this repo's own `.env.local` unless an operator sets it.

Both gates are checked **only** at panel creation/reconfiguration (`PUT /api/teams/adaptive-runs/{runId}/review-panel`). Every other mutating route — vote submission, finalize, cancel, override — is a **drain operation** and is never gated by either flag. This is the core release-boundary invariant: disabling the feature can never strand an already-open panel with no forward path.

| Capability | Team opt-in required? | Global guard required? |
|---|---|---|
| Create / reconfigure panel (`PUT`) | Yes | Yes |
| Cast vote (`POST .../votes`) | No | No |
| Finalize (`POST .../finalize`) | No | No |
| Cancel panel (`DELETE`) | No | No |
| Owner override (`POST .../override`) | No | No |

Server-derived capability flags on `GET .../review-panel` reflect this split (`canReconfigurePanel` requires both gates; `canCancelPanel`, `canVote`, `canFinalize`, `canOverride` do not require the global guard). The client never re-derives these — it only renders what the server returns.

**Recommended release state for this repo today: both gates OFF.** No team has opted in in production, and the global guard defaults to `false`. Turning the feature on for a specific team requires an operator to explicitly set `adaptiveMultiReviewerSettings.enabled: true` on that team's document AND set `MULTI_REVIEWER_GOVERNANCE_ENABLED=true` in the deployment environment — both are required, so a single mistaken Firestore edit can never turn the feature on globally, and a single env var can never turn it on for a team that hasn't opted in.

## 2. Rollback procedure

To disable new panel creation without affecting any already-open or already-finalized panel:

1. Set `MULTI_REVIEWER_GOVERNANCE_ENABLED=false` (or unset it) in the deployment environment and redeploy/restart. In Next.js dev mode this takes effect on the next request without a manual restart (env file changes are auto-reloaded).
2. No Firestore migration, no data mutation, no panel state change. Existing open panels remain fully operable: reviewers can still vote, an admin can still finalize (once quorum is met) or cancel, and the owner can still override. Existing finalized panels remain fully readable.
3. The only user-visible change is that "Reconfigure reviewers" disappears from the panel UI (`AdaptiveMultiReviewerPanelSection.tsx`), replaced by: *"Multi-reviewer panel review has been disabled — this panel can still be cancelled, but not reconfigured."* Verified live in this step by toggling the env var against a running dev server and confirming this exact round trip (button disappears, all drain operations remain available, re-enabling brings the button back with no data loss).
4. To re-enable, reverse step 1. No other action is required.

Rolling back the **team-level** opt-in (`adaptiveMultiReviewerSettings.enabled: false`) has the identical effect, scoped to one team, and is likewise non-destructive to open/finalized panels.

## 3. Non-production seed harness

`scripts/seed-adaptive-multi-reviewer-e2e.ts` — writes a complete, deterministic, namespaced test fixture (one team, six users, six run scenarios) directly to the configured Firebase project using the **same pure production builders** real transactions use (`buildFinalizedAdaptiveHumanReviewPanel`, `buildOwnerOverriddenAdaptiveHumanReviewPanel`, etc.), so seeded documents are byte-identical to what a real transaction would produce.

**Safety controls** (`lib/governance/adaptiveGovernanceSeedSafety.ts`), all independently checked and all must pass:

- `ALLOW_NON_PROD_GOVERNANCE_SEED=true` must be set explicitly — absent by default.
- `--confirm-project=<projectId>` must be passed and must match the resolved Firebase project ID — a copy-paste project mismatch fails closed.
- Refuses if `NODE_ENV=production` or `VERCEL_ENV` is set (Vercel deployments never run this).
- Every document ID/path is prefixed `gov-e2e-seed-` (`GOVERNANCE_SEED_NAMESPACE`) and independently re-verified against that namespace immediately before every write.
- `--dry-run` (the default — must pass `--delete` on the cleanup script, or the seed script always writes once past the guard, to actually write) prints the plan without writing anything.
- No vote comment/condition text is ever seeded with real content — only literal placeholder strings.

**This repo has no separate dev/staging Firebase project** — seeding runs against the same project used for local development. This is why the guard is layered this heavily, and why the runbook explicitly does not recommend running this against any environment other than a developer's own local `.env.local`-configured project.

Six deterministic scenarios (all under one seed team, six seed users — owner, admin, and three reviewers all holding the "admin" team role required to be an eligible panel reviewer, plus one ordinary "member"):

| Scenario | Run ID suffix | State |
|---|---|---|
| A | `run-a-ready` | Quorum met, ready to finalize as approved |
| B | `run-b-deadlock` | Quorum met, no majority (deadlocked) |
| C | `run-c-waiting` | Below quorum, waiting for more votes |
| D | `run-d-finalized-aggregation` | Finalized via normal panel-vote aggregation |
| E | `run-e-finalized-override` | Finalized via owner override |
| F | `run-f-legacy-single-reviewer` | Legacy single-reviewer path, no panel at all |

Usage: `npm run governance:seed -- --dry-run --confirm-project=<projectId>`, then without `--dry-run` (interactive "type yes" confirmation unless `--yes` is also passed). Auth user credentials are printed to the console exactly once and never persisted or re-logged — if lost, reset the password directly via `adminAuth.updateUser(uid, { password })` in a scratch script (never commit such a script; delete it after use).

## 4. Non-production cleanup harness

`scripts/cleanup-adaptive-multi-reviewer-e2e.ts` — dry-run by default (requires `--delete` to actually remove anything), same guard as the seed script, same interactive confirmation.

**Two path sources, both required for complete cleanup:**

1. **Static seed-plan paths** — every path the seed plan is known to have written, derived from the same pure plan builder the seed script uses (never a live query). This is the primary source of truth and covers everything seeding itself wrote.
2. **Live subcollection sweep** (added during this step, after being caught by this step's own real browser verification pass) — a real vote/finalize/override API call made against a seeded run *after* seeding writes documents the static plan never listed (another reviewer's vote, a finalization's history entry). Firestore does not cascade-delete subcollections when a parent document is deleted, so these would otherwise be orphaned. The cleanup script now additionally queries the `humanReviewVotes` and `humanReviewPanelHistory` subcollections **live**, but only ever scoped under a `runs/{runId}` path that has already passed the namespace check — never a broad or top-level collection-group query. Every path this sweep finds is still re-verified against the seed namespace before use.

Every candidate path (from either source) is independently re-verified via `isWithinSeedNamespace()` immediately before deletion — never trusted solely because it came from a builder function. Firebase Auth accounts are intentionally **not** deleted (inert without their one-time-printed password; remove manually via the Firebase Console if desired).

Usage: `ALLOW_NON_PROD_GOVERNANCE_SEED=true npm run governance:seed:cleanup -- --dry-run --confirm-project=<projectId>` to preview, then `--delete --yes` to execute. Idempotent — safe to re-run; reports "already absent" separately from "deleted" and separately from "failed," and a partial failure can simply be re-run.

**Verified this step:** live seed → full manual browser verification across six scenarios and four roles (owner, admin-role reviewer ×3, ordinary member) → dry-run cleanup (found 35 static + 4 live-written documents) → live delete (39 deleted, 0 failed) → direct Firestore query confirming 0 `gov-e2e-seed-*` documents remain across `teamRuns`, `teams`, `users`, and `runs`.

## 5. Observability

`lib/governance/adaptiveGovernanceTelemetry.ts` — a thin, structurally-safe wrapper around the existing `logger` (`@/lib/logger`), never a second logging system. `logAdaptiveGovernanceEvent(operation, metadata)` is called from ~10 sites in `lib/firestore/runs.ts` covering panel lifecycle, vote submission/conflict, finalization outcomes (completed/waiting/deadlocked/stale), override outcomes (completed/stale/already-finalized), repair outcomes, and malformed-record/unsupported-schema-version detection.

**Allowed metadata (exhaustive — nothing else exists on the type):** `runId`, `teamId`, `panelRevision`, `statusCategory`, `failureCategory`, `artifactStatus`, `aggregationPolicyVersion`, plus the `operation` name itself.

**Forbidden — structurally impossible to pass, not just discouraged:** vote comment, vote conditions, override justification, prompt text, decision receipt content, source content, model output, reviewer email, reviewer display name, raw request body, raw Firestore error objects. There is no field on `AdaptiveGovernanceTelemetryMetadata` for any of these, so a caller cannot accidentally pass one.

This complements (does not replace) the pre-existing `logger.warn(...)` calls in `lib/firestore/runs.ts` and the two repair services, which already cover secondary-artifact write failures with safe metadata.

**Metrics/dashboards:** no metrics infrastructure (StatsD, Datadog, etc.) exists in this codebase beyond structured `logger` calls and existing Sentry/PostHog wiring for unrelated surfaces. This step does not add one — the structured `logAdaptiveGovernanceEvent` calls are the metrics surface for now; wiring them into a dashboard is future work, not a release blocker (all activity is dual-observable via the existing `admin_audit_logs` collection and panel history for that same reason).

## 6. Repair procedures

The finalization and override transactions each already re-verify canonical state fresh on every call and are individually idempotent (a retry against an already-finalized/-overridden panel returns the original outcome unchanged, never re-decides). Two internal repair services (Part E, Part F) backfill missing **secondary** artifacts — panel history, the shared human-review history entry, the governance event, the admin-audit entry, the `teamRuns` projection sync — for a panel whose canonical `governanceRecord.humanReview` write already succeeded but one or more of those secondary writes did not (partial-failure recovery, not correction of canonical state).

**Repair is never destructive and never re-decides an outcome.** It only fills in a missing secondary artifact to match the canonical state that already exists. If canonical state and the panel ever disagree in a way repair cannot resolve, it fails closed (`repair_inconsistent`) rather than guessing — this is intentional; an operator must investigate manually rather than have the system silently pick a side.

| Symptom | Cause | Procedure |
|---|---|---|
| Panel shows finalized/overridden but the shared review-history list is missing an entry for it | Secondary write failed after canonical write succeeded (e.g. transient Firestore error) | Re-trigger the same finalize/override request with identical parameters (`expectedPanelRevision`/`expectedGovernanceUpdatedAt` matching current state) — the transaction is idempotent and will invoke the repair path, backfilling the missing history entry without re-deciding anything. |
| `teamRuns` projection status is stale relative to the panel's actual outcome | Same as above, scoped to the projection sync step | Same procedure — re-trigger the identical finalize/override call. |
| A governance event or admin-audit entry is missing for an otherwise-finalized panel | Same class of partial failure | Same procedure. |
| `panel_already_finalized` shows up where `inconsistent_finalization_state` was expected | Not a bug — this is the disclosed, additive Part F fix distinguishing "already decided via a different path" (override) from a genuine inconsistency. No action needed. |
| A reviewer reports their vote shows as "not yet voted" on a finalized/cancelled panel they know they voted on | The Part F `panel.revision - 1` vote-read bug (fixed this step) — confirm the deployed build includes the fix (`app/api/teams/adaptive-runs/[runId]/review-panel/route.ts`, `voteRevision` computation). If already deployed with the fix and still reproducing, treat as a NEW defect and escalate — do not assume it is the known issue. |
| Canonical `governanceRecord.humanReview` and the panel's own `status`/outcome genuinely disagree (not just a missing secondary artifact) | Data corruption or a bug in a write path | **Do not attempt automatic repair.** This is exactly the case repair fails closed on. Investigate manually: read both documents directly, determine which is correct against the panel history and vote records, and correct via a manual, audited Firestore write — never via re-running the API, since re-running assumes the panel's own state is trustworthy input. |
| An operator needs to disable panel creation immediately (incident, unexpected bug) | — | Follow §2 Rollback procedure. Does not require any of the above. |
| A non-production seed/cleanup run fails partway through | Transient Firestore error, or a project-ID mismatch was caught by the guard | Both scripts are idempotent — re-run the identical command. Seeding uses `.create()`/`.set()` appropriately per document; cleanup reports "already absent" separately from "deleted" so a partial retry never double-counts. |

**No automatic mutation retry exists anywhere in this feature** — every retry above is an operator manually re-issuing the same request, not a background job or scheduled task.

## 7. Security review summary

- Vote comment/conditions text and override justification are scoped to their author (or, for override justification, visible per the existing owner-override authorization matrix) and never appear in logs, telemetry, or any endpoint response aimed at another reviewer.
- `canOverride` is `role === "owner"` exactly — never `isTeamAdmin()` — confirmed both by static code review and by live testing in this step (a non-owner admin's `GET .../review-panel` response returns `canOverride: false`, and the section does not render).
- The ordinary-member negative path (no team-admin/owner role) is denied server-side at every layer — confirmed live via both the queue index (`/team/reviews`) and a direct deep link to a specific panel (`/team/reviews/{runId}`), both returning an explicit access-denied state rather than a blank page or partial data leak.
- **RESOLVED** (was disclosed here as out-of-scope; fixed in two later steps — see `docs/operations/auth-session-sync-runbook.md` for full detail): the session-identity desync described in the original version of this section is fixed. Step 6 rebuilt the client/server session-synchronization lifecycle (login/logout/switch, an explicit `syncState` machine, `getRequestUid()` cookie/bearer cross-checking) for the team/governance route family. Step 7 then found the same root-cause pattern independently duplicated across 19 other routes — including the protected Claim Verification and Video Verification paths — and centralized ALL of them onto one shared, hardened resolver (`lib/auth/resolveRequestIdentity.ts`). A Step 7 recovery pass then closed one further live-verified gap: a stale cookie for one user alongside an unverifiable (expired/invalid/malformed) bearer token for a DIFFERENT user was still silently authorizing via the cookie alone; the final policy requires BOTH credentials to independently validate and agree whenever both are present, with no remaining fallback case. No cookie-first or invalid-credential-fallback path remains anywhere in the repository as of Step 7's completion.

## 8. Performance review summary

No release-blocking performance issues were found. Panel/vote reads use deterministic document IDs (never a collection query) throughout the vote/finalize/override paths, matching the existing single-reviewer pattern. The `GET .../review-panel` read model does one additional read per listed reviewer (their vote document) — bounded by `requiredReviewerCount`, which is itself bounded by team size; no unbounded query exists anywhere in this feature.

## 9. Manual browser verification — what was actually exercised

Performed against the real (only) Firebase project for this repo, using the seed harness above, with `MULTI_REVIEWER_GOVERNANCE_ENABLED=true` and the seed team's own `adaptiveMultiReviewerSettings.enabled: true`.

- **Owner**: logged in, viewed the review queue, opened Scenario A (ready), finalized it, verified the resulting artifacts (final status, history entry, votes unchanged). Opened Scenario B (deadlocked), performed an owner override, verified artifacts and that reviewer votes remained visible and unchanged. Verified the rollback UI round trip (§2) on Scenario C.
- **Admin-role reviewers** (reviewer-1/2/3, all hold team role "admin," the role required to be panel-eligible): reviewer-2 cast a vote on Scenario C with a private comment, confirmed the vote became immutable after reload, confirmed no Owner Override section is visible to them (non-owner). Reviewer-3 was used for the stale-multi-tab test (§ below).
- **Ordinary member** (team role "member," not panel-eligible): confirmed denied access at both the review-queue index and a direct deep link to a specific panel.
- **Stale-write race**: with reviewer-3's vote form loaded on an open panel (Scenario C), the panel was finalized out-of-band via a separate authenticated session (owner). Submitting reviewer-3's now-stale vote was cleanly rejected ("This review is no longer pending") with no corruption, no silent success, and no automatic retry; a manual reload showed the correct finalized state and reviewer-3 correctly listed as "No vote."
- **Cleanup**: dry-run, live delete, and a direct post-delete Firestore query confirming zero seeded documents remain (§4).

No automated browser-test framework exists in this repo (confirmed by audit, §5.7 of the original Step 5 instructions) — this verification was manual, and is not repeatable via CI. The existing 151 Jest suites / 2807 tests (mocked) plus this manual pass together constitute the full verification for this release; TypeScript (`npx tsc --noEmit`) and ESLint are both clean.

## 10. Release recommendation

**Ship disabled.** Both gates (§1) default to off in every environment. No further code changes are required to release this state — it is the state the repo is already in. Enabling the feature for a specific team in production requires an operator to deliberately set both the global env var and that team's Firestore opt-in field; there is no path by which the feature activates itself.

**Previously-known limitation, now resolved:** the session-identity desync described in §7 (originally disclosed as out-of-scope for this step) has since been fixed repository-wide — see `docs/operations/auth-session-sync-runbook.md`. Enabling multi-reviewer governance now inherits that fully strict, repository-wide identity-consistency guarantee with no known remaining gap; this section is left in place as a historical record of what was found and how it was later closed, not as an open item.

## 11. Step 8 — Controlled enablement / canary rollout rehearsal

**Everything in this section is a REHEARSAL, run against this repo's own (only) Firebase project using the non-production `gov-e2e-seed-*` harness (§3), on localhost. No production environment variable was changed, no real team was touched, and no real deploy occurred.** It exists to produce a validated runbook the operator can follow when performing the real rollout, and to catch any procedural or code gap before that happens — not as a record of a production event.

**8.1 — Release configuration audit.** Confirmed both gates (§1) default off in this repo's `.env.local`. `MULTI_REVIEWER_GOVERNANCE_ENABLED` was the only variable toggled during this rehearsal, always via a `.env.local` edit + local dev-server restart (the local equivalent of a redeploy).

**8.2/8.3 — Canary definition and pre-deploy checklist.** The rehearsal canary was the existing seed team `gov-e2e-seed-team-1` (already opted in via seed data: `adaptiveMultiReviewerSettings.enabled: true`). Pre-deploy checklist item confirmed: global gate OFF before any other step, canary team's opt-in already present in Firestore, seed Auth users' passwords freshly reset for this session (never logged beyond a one-time console print).

**8.4/8.5 — Gate-off baseline and gate-on verification (live, browser + code).**
- Gate off, team opted in: logged in as the seed owner, loaded a panel on the canary team, confirmed only "Cancel panel" and the drain controls render — no "Reconfigure reviewers" — with the exact UI message from §2 step 3.
- Gate on (env flipped, dev server restarted): reloaded the identical panel, confirmed "Reconfigure reviewers" now appears.
- Server-side confirmation (not just UI): the `PUT` create/reconfigure route independently re-checks both gates before any mutation and rejects with 403 `multi_reviewer_disabled` if either is false — verified by direct code reading, not inferred from the UI. Drain routes (`votes`, `finalize`, `override`) have zero references to either gate anywhere in their source, confirmed by grep.
- Full governance/auth/team Jest suite (46 suites / 1,060 tests) re-run clean after each gate flip; dev server log free of errors at each checkpoint.

**8.6/8.7 — Full canary lifecycle, all four paths exercised live:**
- **Ready path** (Scenario C): a second live reviewer identity cast a real "Approve" vote (private comment field correctly labeled "visible only to you" before submission), quorum was reached, and Finalize produced an immutable "Approved via Panel vote" record with correct artifacts.
- **Deadlock/override path** (Scenario B): confirmed live that a team-admin (non-owner) sees no Owner Override section and that the `override` route independently enforces `role === "owner"` server-side (403 `insufficient_role` otherwise, deliberately excluding admin — see route comment). The owner then performed a real override with a required justification; result: "Approved via Owner override" — a provenance value distinct from the ready path's "Panel vote" — with both original votes (Approved/Rejected) preserved unchanged.
- **Stale two-tab path** (Scenario A, reset via re-seed): the same identity opened the same ready-to-finalize panel in two tabs and clicked Finalize in both within ~2 seconds. Both requests returned HTTP 200; a direct Firestore read afterward confirmed exactly one `humanReviewPanelHistory` entry and one panel revision — the finalize transaction is idempotent under a same-identity race, not merely lucky in the UI.
- **Rollback-drain path**: with an open, quorum-met panel (Scenario C, reset via re-seed) and the global gate flipped OFF mid-flight, Finalize was executed as a genuine drain operation and succeeded fully (200, correct artifacts) — confirming rollback never strands an open panel, matching §1's core invariant under a live test rather than by inspection alone.

**8.8/8.9 — Monitoring window and acceptance criteria.** A literal elapsed business day was not executable within this session; the monitoring window was proxied by reviewing the structured dev-server request log and the full test suite at every state transition in §8.4–8.7. Acceptance criteria evaluated, all met: no identity confusion (inherits Step 6/7's repository-wide fix), dual-gate enforcement holds under live UI + API + code inspection, all four lifecycle paths function correctly end-to-end, no duplicate/corrupted artifacts under a concurrent race, rollback never strands an open panel, no server errors observed at any checkpoint, full test suite stable throughout.

**8.10/8.11 — Repair drill.** Using the existing idempotent `repairAdaptivePanelFinalizationArtifacts()` service (§6) against Scenario D: deleted its `humanReviewPanelHistory` entry directly, ran repair — restored, byte-identical to the deleted document. Ran repair again — reported `already_complete`, still exactly one history document (no duplicate). Canonical `governanceRecord.humanReview`, the panel's `finalStatus`/`revision`, and both vote documents were verified byte-identical before and after every step; the repair service never touched them, exactly as designed.

**Broader-rollout recommendation:** per this playbook's own default, **limited expansion, not immediate general availability.** Concretely: enable both gates for the existing canary team plus 1–2 additional volunteer/friendly teams in production, run for one real business week with the structured `logAdaptiveGovernanceEvent` logs and `admin_audit_logs` as the actual (non-proxied) monitoring signal, then reassess before any wider rollout. Nothing in this rehearsal surfaced a defect serious enough to block that limited expansion, but a rehearsal against seed data is not a substitute for observing real usage patterns and real reviewer behavior at least once before GA.

**Rehearsal harness state after this step:** all six scenarios were re-seeded (idempotent `set`-mode overwrite) back to their originally-designed pristine state after the live tests above mutated several of them. The harness (team, six Auth users, six run scenarios) was intentionally **left in place** for reuse in a future session rather than torn down — full teardown is available via `cleanup-adaptive-multi-reviewer-e2e.ts --delete` (§4) but deletes Firebase Auth accounts as well as Firestore documents, which is more consequential than this step's own scope required. The global gate was restored to `false` in `.env.local` at the end of this step, matching this repo's documented default (§1).
