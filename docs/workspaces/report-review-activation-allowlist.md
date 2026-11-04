# Report review: single-workspace activation allow-list (Order B)

Status: allow-list mechanism added 2026-11-03 (owner authorization). Pilot configuration proposed 2026-11-04.

**TeamCP pilot configuration.** The pilot PR sets `REPORT_REVIEW_ENABLED = true` and `REPORT_REVIEW_WORKSPACE_ALLOWLIST = ["Aw6kbjROOaOIhCXUiKlq"]` (Team Workspace "TeamCP"). Merging and deploying that change **is** the activation action and needs separate owner authorization. Before it is deployed, Production runs with the switch `false` and the list `[]`.

Once deployed, report review is available only in TeamCP, and only to TeamCP members who also pass two existing, environment-driven admission gates:
- **Team Workspaces admission** (`TEAM_WORKSPACES_ENABLED`, or the canary lists `TEAM_WORKSPACES_CANARY_UIDS` (per user) / `TEAM_WORKSPACES_CANARY_WORKSPACE_IDS` (per Workspace); `lib/workspaces/teamWorkspaceTargetAdmission.ts`). A member who fails it cannot open the Team research page at all (404).
- **Approval Workflow admission** (`APPROVAL_WORKFLOW_ENABLED`, or the per-user canary `APPROVAL_WORKFLOW_CANARY_UIDS`; `lib/workspaces/reportReviewRouteSupport.ts`). A member who fails it still sees the research page. On a run without a governed review, the report-review panel's requests are concealed (404), and the panel falls back to the unchanged Order A "Approval review" notice ("This research result can't be submitted for approval…"). That reads like an ineligible run, not a failed gate.

Confirm both gates for the pilot accounts before activation.

**Index precondition.** Once enabled, TeamCP's Approval Queue status views use the merged scan, which needs the four `reportReview.*` composite indexes on `runs`. Without them those views answer 503 `review_queue_index_unavailable`, governed items included. The indexes were deployed to `convergepanel` on 2026-11-04 and verified READY (ids `CICAgPigl4sK`, `CICAgNjr6JwK`, `CICAgITszIAK`, `CICAgJjFqZMK`). A full comparison the same day found the live composite-index set (54, all READY) equal to `firestore.indexes.json`, with nothing missing or extra. Re-verify they are READY immediately before merging.

**Rollback.** Revert that change (switch `false`, list `[]`) and redeploy. The "Audit Log after rollback" section below applies.

The shipped configuration is pinned, against the real module, by `lib/workspaces/__tests__/reportReviewTeamcpPilot.spec.ts`.

## Rule

`isReportReviewEnabledForWorkspace(workspaceId)` (in `lib/workspaces/reportReviewActivation.ts`) is true only when **all** of these hold:

1. the compile-time switch is exactly `true`;
2. the allow-list is valid:
   - an array of 1 to `REPORT_REVIEW_MAX_ACTIVE_WORKSPACES` (= 1) ids;
   - each id is 1 to 128 of `[A-Za-z0-9_-]`;
   - no duplicates;
3. the Workspace the operation targets is listed.

**Defaults and failure.** An empty list, or the switch off, means disabled. Any malformed configuration (more than one id, a duplicate, an empty or path-like id, a non-array) disables report review **in every Workspace**. It never falls back to "allow all".

**Where the list lives.** The allow-list is a compile-time constant, not an environment variable. `lib/env.ts` is frozen by the Order 6 boundary suites, and a reviewed code change is the intended control for activation. Activating the trial is a separate, owner-authorized PR that flips the switch and names exactly the owner's trial Workspace id (the TeamCP pilot above). No Workspace id is added without such a decision.

## Surfaces (each checks the Workspace it targets)

| Surface | Workspace checked |
|---|---|
| Submit, resubmit, decide, context, export (HTTP: `reportReviewCaller`) | The route's `workspaceId`, before anything else about the request |
| `submitReportReview`, `resubmitReportReview`, `decideReportReview`, `getReportReviewContext` | The `workspaceId` argument; containment then requires the run to belong to it |
| Assignment and reassignment hook (submitter guard and report-review audit rows); reviewer-candidate submitter exclusion | The run's own validated `workspaceId` (callers have already checked it equals the requested one) |
| Combined Approval Queue (merged scan, report-review revalidation) and the cursor-mode check | The queue's `workspaceId` |
| Research pages (`reportReviewEnabled`) | The authorized page Workspace (`access.workspace.id`) |

A static test checks that only `reportReviewRollout.ts` and `reportReviewActivation.ts` read the raw switch.

The allow-list **adds** a restriction and grants nothing. These checks all still apply unchanged, and are tested inside the trial Workspace:
- membership and capabilities (Reviewer and Viewer cannot submit);
- reviewer eligibility;
- no self-review;
- the submitter and creator restrictions;
- Workspace containment.

A member of the trial Workspace gets nothing in another Workspace: the route, mutation, context, export and queue all refuse there. Addressing the trial Workspace with another Workspace's run is refused by containment.

**Unlisted Workspaces** behave exactly as before B2. Even a leftover report review there, for example after a rollback, stays dormant:
- the submitter is assignable;
- no report-review audit row is written;
- the candidate list is unchanged;
- decisions are refused;
- the queue is the governed-only scan. It is byte-identical whether the feature is on (for another Workspace) or fully off.

Governed review never consults the rule.

## Audit Log after rollback (owner ruling, 2026-11-03)

A rollback (switch off, or the trial Workspace removed from the allow-list) stops **new** report-review operations:
- submission, decisions and resubmission are refused;
- a reviewer assignment becomes an ordinary assignment and writes no report-review audit row.

It does **not** erase evidence. Existing report-review Audit Log rows stay visible, byte-identical, to users authorized to read that Workspace's Audit Log (`audit.read`).

Privacy and authorization boundaries are unchanged:
- A removed member loses Audit Log and report-review access.
- Another Workspace never sees the rows.
- Rows carry only the question snapshot, statuses, cycle and display names. They never include the purpose note, conditions or reviewer comments.

When research is deleted, the deletion workflow in #287 (S1) redacts the question snapshot in these rows. They then show as "[deleted research]" and are kept, never dropped.

Tested in `reportReviewActivation.spec.ts`. The existing code already satisfied the ruling, so no implementation change was needed.
