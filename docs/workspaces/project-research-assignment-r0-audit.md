# Project / Research Assignment — R0 Design & Security Audit

**Status:** read-only audit, no implementation. Audited at `main @ 6c89bdb0` on 2026-09-14.
Every claim was checked against source at that commit; file:line references are to that tree.
**Implementation is not authorized by this document.**

**Roadmap position.** Set by the product owner on 2026-09-14: Project/Research Assignment →
`/workspace/reviews` migration → legacy surface cleanup. Prerequisites now in place: Personal
research has a canonical URL (PR #160), Add-to-Team-Project is shipped and documented (PR #162,
#161), and Team research has a project-bound read surface.

**Frozen product rules this audit designs against** (from the roadmap memory, 2026-09-03, unchanged):

1. **Assignment is not authorization.** The Workspace stays the sole access boundary. Assignment
   records who is *responsible* among people who already have access. It must never become a
   second, parallel ACL.
2. Only **active** members of the Workspace can be assigned, to a Project or to research.
3. A **Project** can have **many** assignees. A **research run** has **one primary assignee** plus
   **zero or more reviewers**.
4. Removing someone from the Workspace must safely invalidate their *active* assignments **without
   destroying history**.
5. Assignment does not grant Workspace access, does not bypass capabilities, does not consume a
   collaborator seat, and does not affect AI quota or model execution.
6. Existing Projects and research with no assignee remain valid, shown as "Unassigned".
7. **No Project-specific role hierarchy** in v1 (no "Project Admin").

---

## 1. Findings — what exists today

### F1. "Reviewer(s)" for a research run already exist; only "assignee" is new

- Per-run reviewer assignment is `runs/{runId}/humanReviewAssignment/current`
  (`AdaptiveHumanReviewAssignmentV1`, `lib/governance/adaptiveHumanReviewAssignment.ts:113-142`):
  a fixed single document, `assignedReviewerUserId | null`, `revision` OCC, optional `dueAt`,
  `workspaceId`/`projectId` discovery mirrors that are "never authority".
- Multi-reviewer review is `runs/{runId}/humanReviewPanel/current`
  (`lib/governance/adaptiveHumanReviewPanel.ts`): `reviewerUserIds[]` (2–9, deduped, sorted),
  quorum, votes, finalization, owner override.
- Workspace mutations: `putWorkspaceReviewAssignment` / `deleteWorkspaceReviewAssignment`
  (`lib/workspaces/workspaceReviewMutations.ts:192-464`, capability `reviews.manage` **plus**
  `research.read` from the same membership), panel mutations in
  `lib/workspaces/workspaceReviewPanelMutations.ts`. Routes under
  `app/api/workspaces/[workspaceId]/runs/[runId]/review-*`.
- **Rule 3's "reviewers" therefore maps onto existing machinery.** The feature must not add a
  second reviewer field. What does not exist anywhere is a *responsibility* holder: a primary
  assignee for a run, and any assignee concept for a Project.

### F2. The single reviewer assignment and the panel are mutually exclusive per run

- `putWorkspaceReviewPanel` refuses when an assignment is active
  (`workspaceReviewPanelMutations.ts:357-358`, `single_review_active`); assignment and ordinary
  decision refuse when a panel is `open` (`workspaceReviewMutations.ts:241`, `active_panel`).
- Consequence: "one primary assignee + zero-or-more reviewers" is expressible only if the assignee
  is a **separate field** from both reviewer mechanisms. It is not expressible by widening either
  reviewer structure.

### F3. The codebase has already decided "assignment narrows, capability authorizes"

- `lib/workspaces/capabilities.ts:19-41`: `reviews.submit` is eligibility, never standalone vote
  authorization; a vote needs capability **and** the canonical per-run assignment.
- `lib/workspaces/workspaceReviewEligibility.ts:105-111`: "assignment never bypasses capability,
  and capability never bypasses assignment", proven by
  `lib/workspaces/__tests__/workspaceReviewEligibility.spec.ts:222-232` in both directions.
- `lib/projects/types.ts:22-27`: `ProjectV1` deliberately has no `ownerUserId`; `createdByUserId`
  is "non-authoritative audit/display metadata, never read by any authorization check", and
  `lib/firestore/__tests__/teamProjects.spec.ts:574` proves a removed creator is denied purely on
  current membership.
- Rule 1 is therefore not novel to this codebase. The design must be strictly *weaker* than the
  reviewer precedent: an assignee gains **no** capability at all, not even eligibility.

### F4. No membership transaction touches assignments; the orphan policy is a fresh decision

- `removeWorkspaceMembership`, `changeTeamWorkspaceMemberRole`, `transferTeamWorkspaceOwnership`
  (`lib/firestore/workspaceMemberships.ts`) write only membership, seat cache, and their audit
  event. Zero references to runs, projects, `humanReviewAssignment` or `humanReviewPanel`.
- Today's frozen answer for reviewers is **lazy invalidation**: nothing is written on removal;
  every read re-derives eligibility from current membership and reports the assignment as
  `state: "stale"` (`lib/workspaces/reviewContext.ts:304-323`,
  `lib/workspaces/reviewQueue.ts:144-155`); "assigned to me" and "overdue" views drop stale rows
  entirely (`reviewQueue.ts:379-380`, `:469-471`); every write re-validates the assignee against
  current membership.
- One gap in that precedent: a same-reviewer `dueAt` update skips eligibility re-validation
  (`workspaceReviewMutations.ts:248-251`), so a metadata update on a since-removed reviewer
  succeeds. The new feature must re-validate on **every** write.
- Rule 4 ("invalidate without destroying history") is satisfiable two ways: lazy invalidation at
  read time (matches precedent, no cascade, history untouched) or a cascade write inside the removal
  transaction (needs bounded queries plus new indexes, and turns a one-document mutation into a
  multi-document one). See Decision D4.

### F5. Nothing about responsibility or review assignment reaches the Workspace Audit Log

- `listWorkspaceAuditEvents.ts` reads only `workspaceMembershipEvents`. Reviewer assignment
  changes go to `runs/{runId}/humanReviewAssignmentHistory` best-effort **post-commit**
  (`workspaceReviewMutations.ts:348-355`); panel create/reconfigure/cancel write no record at all
  (open debt `TECH_DEBT_WORKSPACE_PANEL_MUTATION_AUDIT_COVERAGE`).
- The durable pattern is `tx.set()` of a `workspaceMembershipEvents` document inside the mutation's
  own transaction ("COMMITTED IFF AUDIT EVENT COMMITTED"), now used by removal, role change,
  ownership transfer, Project archive/restore and research snapshot.
- An assignment event is the **first** to need both a member target and a Project/run subject. The
  three existing identity shapes are member-shaped, project-shaped, and research-shaped, and the
  project/research shapes structurally have no `targetUid`
  (`lib/workspaces/workspaceMembershipEvents.ts:110-135`). A new identity shape is required.
- The audit UI is a literal ternary chain whose final `else` renders "Role changed"
  (`components/workspace/WorkspaceAuditLogShell.tsx:121-194`); a new type inserted after the final
  `else` would silently mislabel. That is the highest-value UI mutation for this feature.

### F6. Documents are tolerant of new fields; request bodies are strict allow-lists

- `isWellFormedProjectV1` accepts unknown fields by policy (`lib/projects/types.ts:64-69`);
  `validateTeamRunRowShape` enumerates no keys (`lib/workspaces/teamRunRowValidation.ts:31-53`).
  A stored `assigneeUids` / `assigneeUid` breaks no reader.
- Every mutation body parser rejects unknown keys as 400 `unexpected_field`
  (`lib/projects/projectMutationBody.ts`, `lib/projects/runProjectAssociationBody.ts`). Personal
  Project routes would therefore refuse an assignee key loudly.
- `projects` is **one shared collection** for Personal and Team; Personal DTOs are hand-written
  allow-lists (`lib/projects/projectDto.ts:34-43`) so a stray field is invisible, not an error. The
  one coupling hazard: tightening `isWellFormedProjectV1` for assignees would make every Personal
  Project page fail closed on a malformed Team-written value, because the guard is shared.
- `validateTeamRunRowShape` fails **closed** on an absent `projectId`, which is why every Team run
  writes `projectId` at creation. An `assigneeUid` must **not** join that strict set, or every
  existing Team run becomes invisible; it must classify "absent" as `null`.

### F7. Capability mapping falls out of precedent; no new capability or role is needed

Rows from `lib/workspaces/capabilities.ts:67-137`:

| Capability | Owner | Admin | Member | Reviewer | Viewer | Gates today |
|---|---|---|---|---|---|---|
| `projects.manage` | ✓ | ✓ | ✓ | | | rename, archive, restore |
| `research.organize` | ✓ | ✓ | ✓ | | | run→Project association, filing at creation |
| `research.create` | ✓ | ✓ | ✓ | | | Team research creation |
| `reviews.manage` | ✓ | ✓ | | | | reviewer assignment, panel config |

Managing a Project's assignees ≈ `projects.manage`. Setting a run's assignee ≈ `research.organize`.
Both are held by Owner/Admin/Member and denied to Reviewer/Viewer. Rule 7 is honoured with zero
change to the matrix. Reusing `reviews.manage` would silently couple responsibility to review
management and is rejected.

### F8. Two OCC dialects exist, chosen by target; pick per document

- Project document: caller-supplied `expectedUpdateTime` compared early, then passed as the
  native `lastUpdateTime` precondition on `tx.update` (`lib/firestore/teamProjects.ts:300-313`).
  The `TeamProjectMutation` union (`teamProjects.ts:188`) and the write `Pick<...>` at `:306` are
  the only two places the mutable field set is enumerated.
- Run single-field mutation: value comparison `expectedProjectId` → `conflict`, no-op →
  `unchanged` (`lib/projects/associateTeamRunWithProject.ts:196-203`).
- No-op posture differs: membership mutations return 200 `{changed:false}` with no write and no
  event; association returns 409 `unchanged`. The new feature must pick one and say so (D6).

### F9. The Team surfaces where assignment would appear, and their constraints

- **Project list row** (`components/workspace/projects/TeamProjectLifecycleRow.tsx:73-127`): the
  established sibling-action pattern; actions render only when `canManageProjects &&
  project.updateTime !== null`. A per-row "Manage assignees" control fits directly.
- **Project detail** (`TeamProjectDetailShell.tsx`): receives `project: {id, name, status}` with
  **no OCC token** and no live resync; the Server Component gets `documentUpdateTime` from
  `getProject()` and discards it. Research rows are plain links with **no action slot**
  (Team run→Project association UI is explicitly deferred, `:11-13`). Two prerequisites for any
  editor here: pass the token through, and add an action slot beside the link (never inside it,
  per `WorkspaceRunCard.tsx:45-55`).
- **Members shell** (`WorkspaceMembersShell.tsx:555-610`): the per-person row/action pattern and
  the house rule that client eligibility mirrors are labelled UX mirrors of named server functions.
- **Member picker source:** `GET /api/workspaces/{W}/members` → `WorkspaceMemberItem {uid,
  displayName, role, isCanonicalOwner, joinedAt, updateTimeToken}`, capability `members.read`
  (Owner/Admin/Member only; Reviewer/Viewer cannot list members). No `useWorkspaceMembers` hook
  exists; two shells call the fetcher inline. `reviewerCandidates` is deliberately **not** a
  directory and is filtered to review-eligible roles; it is the wrong source for assignees.
- **Display names:** `resolveWorkspaceReviewerDisplayNames()` resolves a uid only when a
  membership document (active **or** removed) evidences it, else a fixed fallback, never a raw uid
  (`lib/workspaces/workspaceReviewerIdentity.ts:22-32`). A removed assignee therefore still renders
  by name in history, which is exactly Rule 4's "without destroying history".
- **Team detail read model** returns `{runId, question, governanceStatus?, results}` with no
  assignee slot (`lib/firestore/teamWorkspaceRuns.ts:188-192`); adding one is additive.

### F10. "Mine" views exist only for reviews; per-user filters must stay view filters

- The only per-viewer scoping in the product is `reviewQueue.ts`'s `assigned_to_me` / `overdue`,
  which query the `humanReviewAssignment` collection group for *discovery* and then revalidate every
  row against the canonical run and current membership. No "My Projects" / "My Research" exists.
- The Team Project list's authorization boundary is `workspaceId == W` **alone**
  (`lib/projects/listTeamProjects.ts:12-14`). An `assigneeUids array-contains uid` predicate would be
  the first per-user predicate on Team Projects and is acceptable **only** as a view filter layered
  on the Workspace boundary.
- Indexes today: `projects` has one composite (`workspaceId, status, createdAt`); `runs` has ten,
  none with an assignee field; `workspaceMemberships` has none and needs none. New queries need:
  `projects {workspaceId ASC, status ASC, assigneeUids CONTAINS, createdAt DESC}`, `runs
  {workspaceId ASC, assigneeUid ASC, createdAt DESC}` and `{workspaceId ASC, projectId ASC,
  assigneeUid ASC, createdAt DESC}`. `array-contains` is one-per-query, so "assigned to me ∧ status
  in […]" on Projects would spend that slot.

### F11. Seat, quota, and rollout independence are established and testable

- Seats count people (active non-owner memberships + pending invitations) and nothing else
  (`lib/workspaces/teamWorkspaceSeatAdmission.ts:16-21`). Two specs pin "capacity governs people,
  not research/projects" with a structural tripwire (fake store without the seat collection) and a
  source-level ban (`lib/firestore/__tests__/teamProjectSeatCapacityIndependence.spec.ts`,
  `teamWorkspaceRunSeatCapacityIndependence.spec.ts`). Rule 5 gets a third such spec.
- Quota: the only writer is `checkAndIncrementUsageForRun`, called only by routes that spend model
  tokens. Assignment calls nothing in `lib/stripe/*`.
- Rollout: the house convention is a new structurally identical module per flag
  (`lib/workspaces/approvalWorkflowRollout.ts:5-9`), checked inside the primitive before any
  Firestore access, with non-admission concealed identically to unauthorized (Phase 10C.1A). The
  Team Approval Workflow (reviewer assignment UI) is recorded as **dark in Production**; Team
  Workspaces are canary-scoped.

### F12. Protected systems this feature must not touch

Legacy team governance: `lib/governance/teamGovernancePipeline.ts`, `lib/firestore/teamRuns.ts`
and the `teamRuns`/`teams` collections, `lib/teams/*`, every route under `app/api/teams/**`.
Personal peer review: `lib/governance/personalReviewerAssignment.ts`,
`lib/governance/reviewerFields.ts` and the `users/{uid}.governanceReviewer*` fields,
`app/api/governance/**`, `app/api/user/reviews/**`. Review state machine:
`humanReviewAssignment/current`, `humanReviewPanel/current`, their history subcollections,
`workspaceReviewEligibility.ts` semantics (unless D8 says otherwise). Also `lib/stripe/*`,
`middleware.ts`, `firestore.rules` (catch-all deny already covers any new collection), export
system, claim/video verification execution.

---

## 2. Proposed shape (recommendation, not frozen)

### 2.1 Data model

**Project assignees** — a top-level field on the Team Project document:

```ts
// projects/{projectId} (Team only; never written for Personal)
assigneeUids?: string[];   // absent == [] == "Unassigned"; deduped, sorted, max 20
```

Why a field and not a subcollection: assignees are bounded (a Workspace has at most 6 people
today), the Project already has native `lastUpdateTime` OCC and an in-transaction audit event,
`isWellFormedProjectV1` tolerates the field, and only the `TeamProjectMutation` union and the write
`Pick` need widening. A subcollection would forfeit the single-document OCC and need a
collection-group index for any list filter.

**Research assignee** — a top-level field on the run document:

```ts
// runs/{runId} (Team-bound runs only)
assigneeUid?: string | null;   // absent == null == "Unassigned"
```

Written with the run→Project association dialect (one field, value-comparison OCC). **Reviewers
are not a new field**: they remain `humanReviewAssignment/current` and `humanReviewPanel/current`.

**Never stored:** display names, emails, roles, timestamps of the assignee (all have canonical
homes), any `assignedBy` on the document (the audit event carries the actor).

### 2.2 Mutations

- `POST /api/workspaces/{W}/projects/{P}/assignees` — body exactly `{ assigneeUids: string[],
  expectedUpdateTime }`. A fourth `TeamProjectMutation` member `{kind: "set_assignees",
  assigneeUids}` flowing through `updateTeamProjectFields`' frozen order: `projects.manage` in the
  transaction → Project read, bound, `status === "active"` (archived Project: 409, same as the
  lifecycle precedent) → **every** uid validated against a transaction-read membership: exists,
  bound, `status === "active"`, same Workspace → dedupe/sort/cap → early token compare + native
  precondition → `tx.update({assigneeUids, updatedAt})` → `tx.set(audit event)`. Setting the full
  list (not add/remove) keeps the mutation idempotent and the OCC token meaningful.
- `PATCH /api/workspaces/{W}/runs/{runId}/assignee` — body exactly `{ assigneeUid: string|null,
  expectedAssigneeUid: string|null }`. Mirrors `associateTeamRunWithProject`: `research.organize`
  in the transaction → run read + `validateTeamRunRowShape` (Team-bound only; legacy/Personal
  conceal as `run_not_found`) → expected-state compare → target membership validated when non-null
  → `tx.update(runRef, {assigneeUid})`, exactly one field, no `updatedAt`, no mirrors.
- Rollout: `PROJECT_ASSIGNMENT_ENABLED` / `PROJECT_ASSIGNMENT_CANARY_UIDS`, a new
  `lib/workspaces/projectAssignmentRollout.ts` clone, checked inside both primitives after
  `resolveTeamWorkspaceTargetAdmission`. Non-admission concealed as unauthorized.
- Rate limit: UID-scoped, 20/60s, matching the association route.
- No `checkAndIncrementUsageForRun`, no seat read, no model call.

### 2.3 Audit events (in the same transaction)

Two new `workspaceMembershipEvents` types with a new identity shape carrying both subject and
members:

- `workspace_project_assignees_changed`: `actorUid, workspaceId, projectId, projectName,
  addedUids[], removedUids[], at`.
- `workspace_research_assignee_changed`: `actorUid, workspaceId, projectId, projectName, runId,
  runQuestion, previousAssigneeUid | null, assigneeUid | null, at`.

DTOs expose display names only (actor, added/removed/previous/new), `project.name`,
`research.question`; never any id. Reader validator gets a fourth branch **before** the member
fall-through; UI gets branches **before** the final `else`. No new index: the existing
`{workspaceId, at}` serves the log.

### 2.4 Reads and views

- `TeamProjectSummaryDto` gains `assignees: {uid, displayName}[]` resolved through
  `resolveWorkspaceReviewerDisplayNames` (membership-evidenced only) plus `state: "active" |
  "stale"` per assignee, derived from current membership at read time. `TeamRunSummaryDto` and the
  Team run detail gain `assignee: {uid, displayName, state} | null`.
- v1 views: assignees shown on Project rows and Project detail; assignee shown on research rows and
  run detail; a `?assignee=me` filter on the Team Project list and Team Project research list as a
  **view filter** over the Workspace boundary. "Needs My Review" already exists as the review
  queue's `assigned_to_me`. A cross-Workspace "My Projects" landing is out of v1.

### 2.5 Orphan policy (Rule 4)

Recommended: **lazy invalidation, no cascade write**. Removal and role change stay single-document
mutations. Every read derives `state` from current membership; a removed assignee renders by name
(history preserved) with `state: "stale"` and is excluded from "assigned to me" views; every write
re-validates the target. A later "clear stale assignees" manager action can be added if wanted.

### 2.6 Client

- Project list row: "Assignees" chips + a "Manage assignees" sibling action gated on
  `canManageProjects && project.updateTime !== null`, opening a member-picker dialog that offers the
  member list (`members.read` surfaces), never filters by capability, and renders server denials
  honestly (the `AddToTeamProjectDialog` posture).
- Project detail: pass `documentUpdateTime` through from the Server Component so the header can
  host the same control; research rows gain a sibling action slot (`WorkspaceRunCard` pattern) with
  an "Assign" control gated on `research.organize`.
- Extract `useWorkspaceMembers` from the two inline fetchers as the picker's data source.

---

## 3. Security invariants the implementation must prove (with the mutation that kills each)

1. Assignment grants nothing: an assignee with Viewer role still cannot create research, rename
   or archive the Project, or read anything a Viewer cannot — mutation: branch any capability
   check on `assigneeUids`/`assigneeUid`.
2. A removed member's assignment grants nothing and reads as stale — mutation: skip the
   current-membership check in the read model.
3. Only active same-Workspace members can be assigned — mutations: drop the `status === "active"`
   check; drop the `workspaceId` bind (assign a member of another Workspace).
4. Setting Project assignees needs `projects.manage`; Reviewer and Viewer get 403 — mutation:
   require `projects.read`.
5. Setting a run assignee needs `research.organize` — mutation: require `research.read`.
6. Authorization is re-derived inside the write transaction — mutation: reuse a module-level cache
   of a prior authorization.
7. Every write re-validates the target, including a same-uid repeat — mutation: copy the
   reviewer "same reviewer skips validation" shortcut.
8. `workspaceId`/`projectId`/`runId` come from the path only — mutation: read them from the body.
9. Personal Projects and Personal/legacy runs can never receive an assignee — mutation: accept a
   `personal-*` Workspace or a `legacy` run shape.
10. Archived Projects refuse assignee changes — mutation: drop the status check.
11. OCC: stale `expectedUpdateTime` / `expectedAssigneeUid` is rejected before any write —
    mutations: drop the early compare; drop the native precondition.
12. Audit event is atomic with the write and carries no display name or email — mutations: move
    the `tx.set` post-commit; write `displayName` into the event.
13. Audit DTO exposes no uid or id — mutation: surface `targetUid`.
14. Audit UI renders the new types before the final `else` — mutation: move the branch after it.
15. No seat consumed or read — mutation: import the seat admission module (structural tripwire).
16. No quota, no model execution — mutation: call the usage incrementer.
17. Per-user list filters never replace the Workspace boundary — mutation: drop `workspaceId ==`
    from the assignee query.
18. Names resolve only through membership evidence — mutation: call the global resolver directly
    with a stored uid.
19. Rollout non-admission is concealed as unauthorized — mutation: return 503.
20. Rate limit is UID-scoped — mutation: key on Workspace.

Every denial needs a positive control on the same fixture; every mutation is run and recorded
KILLED (`docs/operations/security-test-falsifiability.md`); the runner must invoke Jest with
`--runTestsByPath` for bracketed route paths and treat "No tests found" as invalid.

---

## 4. Decisions required before implementation (recommendations marked)

- **D1. Storage shape.** Top-level `assigneeUids` on the Project and `assigneeUid` on the run
  (recommended), or subcollections.
- **D2. Assignee eligibility beyond "active member".** Any active role (recommended for Projects,
  since responsibility for a Project is meaningful for a Reviewer or Viewer who monitors it), or
  only roles holding `research.create` for a run assignee (recommended: a run's "researcher" must
  be able to run research).
- **D3. Cap on Project assignees.** Recommend 20 (far above the seat limit, future-proof, keeps the
  audit event bounded).
- **D4. Orphan policy.** Lazy invalidation at read time (recommended, matches precedent, no cascade)
  versus cascade inside the removal transaction (needs indexes and multi-document writes).
- **D5. Audit granularity.** Two event types with full added/removed lists (recommended) versus one
  event per member change.
- **D6. No-op posture.** 200 `{changed:false}` with no write and no event for both mutations
  (recommended, membership-style) versus 409 `unchanged` (association-style).
- **D7. Views in v1.** Show + filter-by-assignee on Team Project list and Project research list
  (recommended). Defer a cross-Workspace "My Projects" landing and any "My Research" outside a
  Project.
- **D8. Assignee vs reviewer coupling.** Leave review eligibility untouched in v1 (recommended;
  the self-review guard is keyed on the run creator today) and only *warn* in the UI when the
  assignee is also the assigned reviewer; or extend `violates*SelfReviewGuard` to the assignee, which
  touches the review state machine.
- **D9. Project assignee editor location.** List row only in v1 (has the OCC token) versus also the
  detail header (requires passing `documentUpdateTime` through the Server Component).
- **D10. Rollout gate.** A dedicated `PROJECT_ASSIGNMENT_ENABLED` flag with canary (recommended)
  versus riding solely on Team Workspace admission.

---

## 5. Explicitly out of scope for the implementation phase

Any new capability or Project-level role; any change to reviewer assignment, panels, votes, or
`workspaceReviewEligibility.ts` unless D8 chooses it; Personal Workspaces; the `/workspace/reviews`
migration; assignment inside the Add-to-Team-Project dialog; notifications; due dates for
assignees; changes to `firestore.rules`; touching any protected system in F12.

---

## 6. Source material

Three parallel source-reading passes (review-assignment model and lifecycle; Project/run surfaces
and capabilities; membership lifecycle, audit vocabulary, protected systems), each cited by
file:line at `6c89bdb0`, followed by direct re-verification of the load-bearing claims: the
single-assignment/panel mutual exclusion, the same-reviewer validation skip, the absence of any
removal cascade, the `createdByUserId` precedent and tolerant Project validator, the capability rows,
the detail page's missing OCC token, and the index inventory. Design docs consulted:
`docs/workspaces/phase8-team-workspace-foundation.md` (capability matrix, reviews.submit
correction), `docs/workspaces/architecture.md`, `docs/governance-decision-receipts-design.md` §28,
`docs/operations/workspace-governance-canary-runbook.md` (queue-view indexes, open debts),
`docs/workspaces/add-to-team-project-r0-audit.md` (the audit and evidence conventions reused here).
