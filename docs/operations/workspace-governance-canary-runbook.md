# Workspace Governance (Approval Workflow) — Phase 9D Canary Runbook

Phase 9C.5 hardening/canary-readiness output. Covers the **Workspace-bound** Approval Workflow (`APPROVAL_WORKFLOW_ENABLED`/`APPROVAL_WORKFLOW_CANARY_UIDS`, `resolveApprovalWorkflowAdmission()`) — single-review assignment/decision/resubmit, multi-reviewer panel (create/reconfigure/vote/finalize/cancel), Owner Override, and Approval-disabled drain completion. This is a **different system** from the legacy Team-scoped multi-reviewer feature covered by `docs/operations/multi-reviewer-governance-runbook.md` (`MULTI_REVIEWER_GOVERNANCE_ENABLED`) — do not conflate the two flag pairs or the two admission resolvers.

This document is the **operational** companion to the source-level work in Phases 9B.1–9C.5. It does not re-derive the feature's design — see `docs/technical-documentation.md` and the Phase 9 review contracts frozen across 9C.1–9C.4 for that.

## 0. Phase 9D canary closeout (executed) — READY_FOR_INTERNAL_RECANARY_ONLY

Sections 1–9 below were written *before* the Phase 9D canary ran, as the execution plan. This section records what actually happened. §§1–9 remain accurate as reference/procedure for a future recanary; they are not superseded.

**Canary-tested source:** `c28edbbf88a578a4c53516ecdf528f8e3c8e82c7`. Every result below was produced against this exact Production source SHA, independently verified via two convergent sources (GitHub commit-status + `vercel inspect` on the live alias) before and after every mutation phase. As of this closeout, `origin/main` and live Production are still exactly this SHA — no drift.

**Controlled identity geometry** (role aliases only — no UIDs recorded here): `A` = Workspace Owner (assignment/panel management, Override); `B` = Member, creator of all four purpose-built fixture runs; `C`, `D` = Reviewers. `C != D != B != A` throughout, verified at every step.

**Final governance matrix** (one dedicated internal-canary Workspace, one project, four purpose-built runs plus two preserved control artifacts):

| Run | Final state | Key paths proven |
|---|---|---|
| **RUN_B** | `APPROVED_ORDINARY` — unfiled, creator B, reviewer C | Assignment + assignment OCC · `changes_requested` → creator resubmit (assignment preserved) → ordinary final approval · governance OCC · self-review suppression · full ordinary-decision audit chain |
| **RUN_C** | `PANEL_FINALIZED_APPROVED` — filed, panel C+D, quorum 2 | Panel create · panel OCC · vote authorization/quorum · finalize + finalize OCC · `decidedVia: multi_reviewer_panel` · full finalize audit chain |
| **RUN_D** | `APPROVED_ORDINARY_AFTER_CANCELLED_PANEL` — unfiled | Open-panel assignment exclusion (real `409 active_panel`, not OCC) · one historical C vote survives cancellation · cancel OCC · cancelled-panel ordinary fallback · ordinary decision stays attributionally distinct from the cancelled panel |
| **RUN_E** | `OWNER_OVERRIDE_APPROVED_UNDER_DRAIN` — filed, panel C+D | Panel created while Approval-admitted · Approval canary fully withdrawn + redeploy · general queue denied (`404`) while direct existing-panel detail stayed reachable (`200`, `mode:"drain"`) · reconfigure denied at admission layer (`404`, not OCC) · vote/cancel/finalize routes proven drain-reachable (real votes; `409` OCC — never `404` admission denial — on cancel/finalize stale probes) · Owner Override executed, dual OCC, justification persisted, `decidedVia: multi_reviewer_owner_override`, richest audit trail of any mutation (4 writes) |
| Negative control | Unchanged | Non-adaptive, no `governanceRecord`, never appeared in any queue view or resolved as a review target for any of the four identities |
| Adaptive-admission proof | Unchanged | Adaptive, governance-eligible, deliberately preserved as a control artifact — never repurposed as a fifth mutation fixture |

**The single most important boundary proof:** under Approval drain, new-work routes and existing-open-panel routes fail with genuinely different HTTP semantics — `404` (concealed admission denial, rejected before any transaction) versus `409` (real canonical OCC/panel-state validation, meaning the request reached the panel). This distinction was verified directly, not inferred from UI state, on the reconfigure-denial probe, the stale-cancel probe, and the stale-finalize probe.

**Current Production configuration:** `APPROVAL_WORKFLOW_ENABLED` off/unset; `APPROVAL_WORKFLOW_CANARY_UIDS` absent (deleted, not merely emptied — confirmed via direct env read-back, no ambiguity this time); `TEAM_WORKSPACES_ENABLED` off/dark, `TEAM_WORKSPACES_CANARY_UIDS` unchanged from its pre-canary controlled set; Adaptive config untouched by this canary. This is the safe holding state the canary was left in — see §2 for the mechanics, already exercised as part of Phase 9D.5.

**Rollout decision: `READY_FOR_INTERNAL_RECANARY_ONLY`.** The governance state machine is Production-proven end-to-end. This is explicitly *not* authorization for external, broad, or global rollout — those remain blocked pending the prerequisites below. Full tier-by-tier reasoning:

| Tier | Status | Blocker / condition |
|---|---|---|
| 0 — Dark | READY | Current state |
| 1 — Internal controlled recanary | READY | No further prerequisite beyond the standard freeze/provenance protocol in §5–§6 |
| 2 — Small external Team canary | READY_WITH_CONDITIONS | Team invite-canary acceptance behavior (below) must be resolved/redesigned; env-observability operator procedure formalized; customer-facing audit/governance copy reviewed against actual coverage; explicit cohort/rollback/support plan defined |
| 3 — Broad Team rollout | BLOCKED | Panel-mutation audit coverage and governance-audit-durability debts need disposition; post-mutation UI reconciliation lag needs to be either reproduced-and-fixed or conclusively shown non-reproducible; also blocked by product strategy (broad Team rollout is intentionally deferred independent of this canary) |
| 4 — Global/GA | BLOCKED | Everything Tier 3 requires, plus operational/support readiness outside this canary's scope |

**Open technical debt at closeout** (see also §7–§8 below for pre-existing rollback/stop criteria that remain in force):

| ID | Status | Rollout impact |
|---|---|---|
| `TECH_DEBT_GOVERNANCE_AUDIT_DURABILITY` | Open, architectural | Every write that source defines succeeded in Production with zero misses across 3 mutation phases; the underlying best-effort/post-commit architecture is still unproven under real partial-failure conditions. Disposition (harden or explicitly accept) required before Tier 3. |
| `TECH_DEBT_WORKSPACE_PANEL_MUTATION_AUDIT_COVERAGE` | Open, architectural | Confirmed in Production: panel create/vote/cancel write **zero** immutable secondary record (the canonical resource document is the only evidence); finalize writes 3; Owner Override writes 4. This inverted coverage (rarest action = best audit trail) needs a positioning review before Tier 2 and either implementation hardening or an explicit product decision before Tier 3. |
| `TECH_DEBT_TEAM_INVITE_CANARY_ACCEPTANCE` | Open, product decision | While Team is globally dark, `acceptWorkspaceInvitation()` independently re-checks the *invitee's* own Team-canary admission, not just the inviter's — discovered during fixture construction, worked around only because every controlled identity was pre-admitted. **Concrete Tier 2 blocker** for any real external invitee. |
| `TECH_DEBT_VERCEL_SENSITIVE_ENV_OBSERVABILITY` | Open, operational | `vercel env pull` was repeatedly ambiguous for canary UID variables specifically (not other env vars) across this canary; every case was resolved via a real functional admission/denial probe, never by trusting the CLI read-back. See the operator procedure below. Does not affect authorization correctness; formalize before Tier 3. |
| `TECH_DEBT_9D2_POST_MUTATION_UI_RECONCILIATION` | Open, non-blocking (safety-wise) | Recurred non-reproducibly (same operation, same component, different phases: RUN_B assignment/approval once stale, RUN_D's equivalents immediate, one RUN_E vote UI no-op). Never produced an exploitable stale-actionable control — every occurrence was independently confirmed harmless via a direct OCC/authorization read. Does not block Tier 1; should be diagnosed before Tier 3. |

Unchanged from pre-canary: `TECH_DEBT_ADAPTIVE_PLANNER_AUTH_ORDERING` (separate Adaptive rollout axis, no Approval impact), `TECH_DEBT_9C4_PANEL_LOOKUP_FAILURE_DEDICATED_TEST` (not exercised by this canary — happy paths only, stays open), `TECH_DEBT_9C3_RECONCILIATION_WINDOW_PERMANENT_TEST` (distinct mechanism from the UI lag above, stays open). `TECH_DEBT_9C3_MUTATION_LOCK_THROW_BACKSTOP` is **resolved** (confirmed via real `try/finally` since Phase 9C.3-R2C).

**Vercel sensitive-env operator procedure** (the concrete lesson from repeated ambiguous read-back during this canary): do not treat `vercel env pull` as authoritative for a canary UID variable's stored value. After any such change: (1) make one controlled write attempt — do not retry blindly if the CLI reports success but read-back looks wrong; (2) if ambiguous, have the operator confirm/complete the change via the Vercel dashboard directly; (3) redeploy the exact reviewed source SHA (env changes to an existing deployment do not take effect until a fresh deployment); (4) verify the new deployment's source SHA via the two-source method in §5; (5) prove the change functionally — a real admission or denial probe against the actual route, never inferred from `env pull` alone.

**Recanary / source-change policy:** the SHA above (`c28edbbf88a578a4c53516ecdf528f8e3c8e82c7`) is what was tested. A future change touching `lib/workspaces/workspaceReview*.ts`, `reviewContext.ts`, any `review-*` route, or the OCC/panel/vote/finalize/cancel/override logic requires focused review, relevant permanent tests, the normal protected-merge path, fresh Production provenance verification, and a **targeted** recanary of the specific invariant the change touches — not a full re-run of Phases 9D.0–9D.6. An unrelated source change follows the normal release workflow with no recanary requirement.

**Fixture preservation:** the dedicated canary Workspace, its project, RUN_B/C/D/E, the negative control, and the adaptive-admission proof are intentional Production canary evidence, not customer data. They should not be deleted or modified casually — retained pending an explicit future retention/cleanup decision.

**Product-promise gap:** whether ConvergePanel's actual customer-facing governance/audit copy overclaims relative to the coverage documented above (`TECH_DEBT_WORKSPACE_PANEL_MUTATION_AUDIT_COVERAGE`) was **not assessed** in this canary — it requires a narrowly-scoped review of the actual copy, which was out of scope for a Production application-state audit. Flagged as a follow-up, not resolved either way.

## 1. Release state model (as of Phase 9C.5)

Two independent, additive gates, both required, exactly mirroring the Team Workspaces canary precedent (`lib/workspaces/teamWorkspacesRollout.ts`):

1. **Team Workspace access** — `resolveTeamWorkspacesMode()` / `resolveTeamRunWorkspaceAccess()` (`TEAM_WORKSPACES_ENABLED`, `TEAM_WORKSPACES_CANARY_UIDS`). Governs whether the caller has a Workspace at all.
2. **Approval Workflow admission** — `resolveApprovalWorkflowAdmission()` (`APPROVAL_WORKFLOW_ENABLED`, `APPROVAL_WORKFLOW_CANARY_UIDS`, `lib/workspaces/approvalWorkflowRollout.ts`). Governs whether *new* governance work (queue, assignment, ordinary decision, resubmit, panel create/reconfigure) is admitted.

**Verified precedence** (read from actual route source, not assumed): every mutating/list route checks Approval admission first (zero I/O, pure), then independently re-checks Team Workspace access — neither gate substitutes for the other. Being on the Approval canary list never grants Workspace access; the existing permanent test `app/api/workspaces/[workspaceId]/review-queue/__tests__/route.spec.ts` ("caller is Approval-Workflow canary, but Team Workspace access denies -> still denied") locks this in.

**Drain is asymmetric and per-run only**, not a third global gate: `getWorkspaceRunDetail()` / `getReviewContext()` admit a caller when `approvalAdmitted === true` **OR** a validly-parsed existing `humanReviewPanel/current` document exists for that specific run — this OR-condition exists ONLY on the per-run detail read path, never on the review-queue LIST route (which requires `approvalAdmitted === true` outright, no drain fallback — a disabled feature never resurfaces in queue discovery). Once admitted via drain, `viewer.mode === "drain"` forces `canCreatePanel`/`canReconfigurePanel`/`canManageAssignment`/`canSubmitDecision`/`canResubmit` to `false` server-side, and the client independently, defensively suppresses those same five affordances even under a forged/stale `can*` fixture (Phase 9C.4-R1C).

**Recommended release state for this repo today: both gates OFF.** No Workspace has any panel/assignment data outside local test seeding; `APPROVAL_WORKFLOW_ENABLED`/`TEAM_WORKSPACES_ENABLED` are both `false`/absent by default.

## 2. Rollback procedure (Approval Workflow only — no data mutation)

1. Set `APPROVAL_WORKFLOW_ENABLED=false` (or remove the canary UID) in the deployment environment and redeploy/restart.
2. No Firestore migration, no panel/assignment/governance-record mutation. Any already-open panel remains fully operable in drain: reviewers can still vote, a manager can still finalize (once quorum is met) or cancel, and an Owner with `reviews.override` can still override — none of these five actions carry an Approval gate at all (verified: `finalizeWorkspaceReviewPanel`/`deleteWorkspaceReviewPanel`/`submitWorkspaceReviewPanelVote`/`overrideWorkspaceReviewPanel` never call `resolveApprovalWorkflowAdmission()`; only `putWorkspaceReviewPanel`, the review-queue route, and the ordinary assignment/decision/resubmit routes do).
3. The only user-visible change on an already-open panel's detail page is the "Completion mode" banner replacing normal-mode composition, and "Start panel review"/"Change reviewers" disappearing.
4. To re-enable, reverse step 1. No other action required.

Rolling back Team Workspace access (`TEAM_WORKSPACES_ENABLED=false` or removing a canary uid) is the outer, stricter gate — it removes Workspace access entirely, including drain, for the affected uid(s).

## 3. Preconditions before Phase 9D canary execution

1. Phase 9C.5 merged to `main`; exact merge SHA recorded here before proceeding.
2. All 8 Phase 9B.4 review-queue Firestore indexes deployed (see §4) and confirmed `READY` in the Firebase console — not merely `firestore.indexes.json` containing the definitions.
3. Vercel Production deployment source SHA independently verified to equal the Phase 9C.5 merge SHA (see §5) — not assumed from a successful `git push`.
4. A designated canary identity (`<CANARY_UID>`) added to `TEAM_WORKSPACES_CANARY_UIDS` and `APPROVAL_WORKFLOW_CANARY_UIDS` — the SAME uid on both lists, since both gates are independently required.
5. A known test `<WORKSPACE_ID>` / `<PROJECT_ID>` / `<RUN_ID>` prepared, owned by or accessible to `<CANARY_UID>`, with a real adaptive Deep Research run in a reviewable governance state. Producing that run requires a THIRD, independent gate (Phase 9D.0-A): the run's creator must be admitted through `ADAPTIVE_SCHEMAS_CANARY_UIDS` (or the global `ADAPTIVE_SCHEMAS_ENABLED`, which remains `false` for this canary) — without it, `/api/workspaces/{workspaceId}/runs` silently falls back to the legacy, non-adaptive pipeline and the resulting run is never governance-eligible.
6. A rollback operator identified and reachable for the duration of the canary window.
7. No broader Team Workspaces or Approval Workflow rollout — canary remains a single explicit uid (or a small, deliberate, explicitly-enumerated set, capped at `MAX_APPROVAL_WORKFLOW_CANARY_UIDS`/`MAX_TEAM_WORKSPACES_CANARY_UIDS` = 10 each).

## 4. Firestore index deployment (Phase 9D only — NOT this phase)

The 8 review-queue-specific composite indexes, independently re-derived from the actual query shapes in `lib/workspaces/reviewQueue.ts` against `firestore.indexes.json` as of the Phase 9C.5 merge SHA:

| Query | Index fields |
|---|---|
| `needs_review` view (no project filter) | `runs`: `workspaceId ASC, governanceRecord.humanReview.status ASC, createdAt DESC` |
| `needs_review` view (project filter) | `runs`: `workspaceId ASC, projectId ASC, governanceRecord.humanReview.status ASC, createdAt DESC` |
| `changes_requested` / `recently_approved` views (no project filter) | `runs`: `workspaceId ASC, governanceRecord.humanReview.status ASC, governanceRecord.humanReview.reviewedAt DESC` |
| `changes_requested` / `recently_approved` views (project filter) | `runs`: `workspaceId ASC, projectId ASC, governanceRecord.humanReview.status ASC, governanceRecord.humanReview.reviewedAt DESC` |
| `assigned_to_me` view (no project filter) | `humanReviewAssignment` (collection group): `workspaceId ASC, assignedReviewerUserId ASC, assignedAt DESC` |
| `assigned_to_me` view (project filter) | `humanReviewAssignment` (collection group): `workspaceId ASC, projectId ASC, assignedReviewerUserId ASC, assignedAt DESC` |
| `overdue` view (no project filter) | `humanReviewAssignment` (collection group): `workspaceId ASC, dueAt ASC` |
| `overdue` view (project filter) | `humanReviewAssignment` (collection group): `workspaceId ASC, projectId ASC, dueAt ASC` |

All 8 are present in `firestore.indexes.json` with exactly these field orders (verified 2026-08-26 against the actual query code — not from memory). Two additional `runs` indexes (`workspaceId ASC, createdAt DESC` and `workspaceId ASC, projectId ASC, createdAt DESC`, no status filter) also exist in the same file but belong to `lib/workspaces/listTeamWorkspaceRuns.ts` (the Workspace research list page), not the review queue — do not conflate them when auditing "queue readiness."

**Status entering Phase 9D: `DEFINED_NOT_DEPLOYED`. Status at Phase 9D.6 closeout: all 8 deployed and confirmed `READY`** (Phase 9D.0 preflight). Deployment command (kept for reference / a future recanary needing a fresh project):

```bash
# 1. Confirm the checked-out SHA matches the intended Production release SHA.
git rev-parse HEAD

# 2. Confirm the Firebase CLI is authenticated against the correct project
#    (this repo has no separate dev/staging project — double-check before running).
firebase projects:list
firebase use <project-id>

# 3. Deploy ONLY the Firestore indexes — never bundle with a rules or functions deploy.
firebase deploy --only firestore:indexes

# 4. Poll until every new index shows READY (not BUILDING) in the Firebase console
#    (Firestore > Indexes), or via:
firebase firestore:indexes
```

Abort/rollback: an index deploy is additive and non-destructive — if a definition is wrong, fix `firestore.indexes.json` and redeploy; do not attempt to "undo" a building index by deleting it while queue traffic may depend on the old (still-present) index it doesn't replace.

## 5. Vercel Production source-SHA provenance

**Status as of this document: `BLOCKED_BY_ACCOUNT_SCOPE` (Vercel MCP integration only). Resolved for Phase 9D via the local `vercel` CLI**, which has its own, separately-authenticated session with working `--scope convergepanel-ai` access (`vercel inspect <domain> --scope convergepanel-ai`, `vercel ls --scope convergepanel-ai --prod`) — unlike the MCP tool, which still returns `403 Forbidden` against project `prj_g59RoJlSaZmBQX2aSKmWrQI7JvhV` / team `team_Vh8IpYZQKv5TJTh1XAuO32sm`. Every Production source-SHA verification across Phases 9D.0–9D.6 used the two-source method: `vercel inspect` on the live alias, cross-checked against GitHub's own Vercel commit-status (`gh api repos/.../commits/<SHA>/status`, `target_url` embeds the same deployment ID) — both must converge on the identical deployment ID. Do not substitute "the push succeeded" or "the preview deployment passed" for this.

## 6. Phase 9D canary sequence (documented only — do not execute from this repo/session)

Ordered, one controlled identity at a time:

**A.** Verify Production source SHA (§5, now unblocked) matches the intended Phase 9C.5 (or later) merge SHA.
**B.** Verify all 8 indexes (§4) are `READY`.
**C.** Add `<CANARY_UID>` to `TEAM_WORKSPACES_CANARY_UIDS` (if not already Team-enabled for that identity); confirm via a queue-route smoke request that access is granted.
**D.** Add the SAME `<CANARY_UID>` to `APPROVAL_WORKFLOW_CANARY_UIDS`; confirm `reviewDecision`-equivalent admission via a `review-context` smoke request.
**E.** Queue read smoke — all four views (`needs_review`, `changes_requested`, `recently_approved`, `assigned_to_me`) plus `overdue`, with and without a project filter, for `<WORKSPACE_ID>`.
**F.** Review detail read — `/workspace/reviews/[runId]` for `<RUN_ID>`, confirm normal-mode composition (no Completion-mode banner, since Approval is now admitted for this identity).
**G.** Ordinary assignment — assign `<CANARY_UID>` (or a second controlled reviewer identity) to `<RUN_ID>`.
**H.** Ordinary review decision — submit a decision; confirm `governanceRecord.humanReview.status` transitions correctly and the queue view updates.
**I.** `changes_requested` + resubmit — request changes, resubmit as creator/manager, confirm return to `unreviewed` with assignment preserved.
**J.** Panel create — on a SEPARATE dedicated `<RUN_ID>`, create a 2–3 reviewer panel.
**K.** Panel vote — cast votes toward quorum.
**L.** Panel finalize — finalize once quorum is met; confirm canonical governance status.
**M.** Panel cancel — on a separate controlled run, cancel an open panel; confirm ordinary single-review fallback becomes available per canonical `can*`.
**N.** Owner Override — on a dedicated eligible run (open panel, Owner identity with `reviews.override`), submit an override with a justification; confirm dual-OCC request, canonical result, and provenance (`decidedVia: multi_reviewer_owner_override`).
**O.** Drain-mode controlled check — ONLY if it can be exercised without disrupting any other user: temporarily disable `APPROVAL_WORKFLOW_ENABLED`/remove the canary uid with an already-open panel present, confirm the Completion-mode banner and drain-permitted actions (vote/finalize/cancel/Override, per that run's own `can*`), confirm "Start panel review"/"Change reviewers"/assignment/ordinary-decision/resubmit are absent even though the panel exists. Re-enable immediately after.
**P.** Audit-event verification — confirm `humanReviewHistory`, `governanceEvents`, and `admin_audit_logs` entries were written for each terminal action above (§7 also covers the "best-effort, not atomic" caveat — a missing best-effort write is a `logger.warn`, not a blocking failure, but should still be checked).
**Q.** Error/log inspection — review server logs for unexpected `warn`/`error` entries during the sequence above.
**R.** Rollback decision — proceed to broader rollout only if every step above passed with no unexplained anomaly; otherwise execute §2.

## 7. Immediate stop / rollback criteria

Halt the canary and execute §2 rollback immediately on any of:

- Unexpected `401`/`403`/`404` pattern on a request that should have succeeded (or the reverse — success where denial was expected).
- Any cross-Workspace data leakage (a canary-identity request surfaces a run/panel/reviewer/project belonging to a Workspace the identity does not have access to).
- Wrong rows in a queue view (a run appears in a view its canonical status/assignment doesn't justify).
- An OCC conflict (409) followed by an automatic/blind replay anywhere (backend or UI) — every mutation type in this system requires explicit user resubmission after a conflict; observing otherwise is a regression of a frozen invariant.
- A duplicate governance mutation from a single user action (double-submit protection failure).
- A governance mutation that succeeded canonically but produced zero corresponding history/event/audit record where one is contractually expected (see §1's atomicity caveat below — a `logger.warn` alone is not disqualifying, but silent total absence across retries is).
- A stale/superseded vote counted toward current quorum, or a reconfigured panel's old-revision vote counted toward the new revision's quorum.
- Ordinary self-review becoming reachable (a creator submitting/voting on their own artifact through the peer-review path — Owner Override is the only sanctioned exception, and only through its own explicit, justified path).
- Drain mode admitting ANY new-work control (panel create/reconfigure, assignment, ordinary decision, resubmit) under any circumstance.
- Owner Override becoming available to an identity without `reviews.override`.
- §5's Production source-SHA verification turning out to have been wrong (i.e., discovering Production is NOT actually running the SHA assumed in §6.A).
- A Firestore index-related query failure (`FAILED_PRECONDITION` / "requires an index") on any of the 8 queue views.
- An elevated rate of 5xx responses on any Workspace governance route during the canary window.

## 8. Rollback order

1. **Disable Approval Workflow canary admission first** — remove the canary uid from `APPROVAL_WORKFLOW_CANARY_UIDS` (or set `APPROVAL_WORKFLOW_ENABLED=false` if broader than a single-uid canary was in effect) and redeploy/restart. This is the narrowest, fastest, fully reversible action (§2).
2. Leave Team Workspace access (`TEAM_WORKSPACES_CANARY_UIDS`/`TEAM_WORKSPACES_ENABLED`) untouched unless the incident specifically implicates Team-level access itself — Team access is a broader, separate feature surface, and rolling it back is not required merely to stop new Approval-gated governance work.
3. Never delete governance records, panel documents, vote documents, assignment documents, or audit/history entries as part of rollback — every governance mutation in this system is additive/status-transition, never a physical delete (panels/assignments use terminal `status` values, not document removal). Rollback disables *future* admission; it never rewrites or removes what already happened.
4. If a data-correctness issue (not an admission issue) is found, treat it as a separate incident requiring its own investigation — do not attempt an ad hoc Firestore edit under canary time pressure.

## 9. Placeholders — no secrets

This document uses only placeholders: `<CANARY_UID>`, `<WORKSPACE_ID>`, `<PROJECT_ID>`, `<RUN_ID>`. Never substitute real values into a committed copy of this file; real values belong only in the operator's own working notes for the canary window.
