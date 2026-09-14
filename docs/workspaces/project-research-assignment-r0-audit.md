# Project / Research Assignment — R0 Design & Security Audit

**Status:** read-only audit, no implementation. Audited at `main @ 6c89bdb0` on 2026-09-14.
Every claim was checked against source at that commit; file:line references are to that tree.
**Implementation is not authorized by this document.**

**Owner review 2026-09-14: decisions D1–D10 are FROZEN (§4)** and the implementation brief in §6 is
the contract for a later implementation phase. §2 has been made consistent with the frozen
decisions. This remains a design record; implementation, merge, and Production contact are not
authorized by it.

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

## 2. Frozen shape (consistent with the decisions in §4)

### 2.1 Data model (D1, D3)

**Project assignees** — a top-level field on the Team Project document:

```ts
// projects/{projectId} (Team only; never written for Personal Projects)
assigneeUids?: string[];   // absent == [] == "Unassigned"; deduplicated, canonically sorted, max 20
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
are not a new field** (D8): they remain `humanReviewAssignment/current` and
`humanReviewPanel/current`, untouched.

No assignment subcollections (D1). **Never stored:** display names, emails, roles, timestamps of
the assignee (all have canonical homes), any `assignedBy` on the document (the audit event carries
the actor).

### 2.2 Eligibility (D2) — two rules, one principle

- **Project assignee:** any **active** membership in **this** Workspace, any role including
  Reviewer and Viewer. Responsibility for a Project is meaningful for someone who monitors it.
- **Run assignee:** an **active** membership in **this** Workspace whose role holds
  `research.create` under the current matrix (today Owner, Admin, Member). A run's researcher must
  be able to run research.
- In both cases the server validates the target inside the write transaction from a
  transaction-read membership document. The client picker mirrors the run-assignee rule for UX
  only, labelled as a mirror of the named server predicate, and never decides anything.
- **Assignment grants no capability and no authorization**, not even eligibility for anything else.

### 2.3 Mutations

- `POST /api/workspaces/{W}/projects/{P}/assignees` — body exactly `{ assigneeUids: string[],
  expectedUpdateTime }`. A fourth `TeamProjectMutation` member `{kind: "set_assignees",
  assigneeUids}` flowing through `updateTeamProjectFields`' frozen order. **Authoritative order
  (identical to §6.4):**
  1. pure request normalization with no Firestore I/O: shape check, then canonical
     deduplication and sort, then the cap of 20 **unique** uids enforced (`too_many_assignees`)
     **before any membership read**;
  2. Team Workspace admission, then Project Assignment rollout admission;
  3. transaction begins;
  4. `projects.manage` via `authorizeTeamWorkspaceMutationInTransaction`;
  5. Project read through `tx`, bound, well-formed, `status === "active"` (archived: 409,
     lifecycle precedent);
  6. caller `expectedUpdateTime` compared against the transaction-read Project `updateTime`;
     **a stale token returns `conflict` immediately** — before any target validation and before
     any no-op consideration;
  7. **every** canonical target membership read through `tx` and validated: exists, bound,
     `status === "active"`, same Workspace (D2 Project rule) — at most 20 reads, performed on
     **every** write including a repeat of the current list (D4);
  8. semantic no-op determination: the canonical requested set equals the normalized stored set
     ⇒ `unchanged` ⇒ 200 `{changed:false}`, no write, no timestamp change, no audit event (D6);
  9. real change: `tx.update({assigneeUids, updatedAt})` with the same native
     `{lastUpdateTime: expectedUpdateTime}` precondition;
  10. `tx.set(audit event)` in the same transaction.
  Setting the full list (not add/remove) keeps the mutation idempotent and the OCC token
  meaningful. **A stale token can never receive a successful no-op response.**
- `PATCH /api/workspaces/{W}/runs/{runId}/assignee` — body exactly `{ assigneeUid: string|null,
  expectedAssigneeUid: string|null }`. Mirrors `associateTeamRunWithProject`. **Authoritative
  order (identical to §6.4):**
  1. Team Workspace admission, then Project Assignment rollout admission;
  2. transaction begins;
  3. `research.organize` via `authorizeTeamWorkspaceMutationInTransaction`;
  4. canonical Team run read through `tx` and `validateTeamRunRowShape` (legacy/Personal/foreign
     conceal as `run_not_found`);
  5. `expectedAssigneeUid` compared with the **normalized** current assignee (§6.6); mismatch ⇒
     `conflict`;
  6. when the requested assignee is non-null, that membership is read through `tx` and validated:
     same Workspace, `status === "active"`, role currently holds `research.create` (D2 run rule).
     **This step runs even when the requested assignee equals the current assignee** (D4) — the
     "same reviewer skips re-validation" defect is structurally impossible to copy because
     validation precedes the no-op decision;
  7. only after successful validation, semantic no-op determination: requested equals normalized
     current ⇒ `unchanged` ⇒ 200 `{changed:false}`, zero writes, zero audit events (D6);
  8. real change: `tx.update(runRef, {assigneeUid})`, exactly one field, no `updatedAt`, no
     mirrors;
  9. `tx.set(audit event)` in the same transaction, with the Project metadata obtained per §2.4.
- **No-op posture (D6):** a no-op is decided only after OCC/expected-state and target validation
  have both succeeded. It writes nothing, bumps no timestamp, emits no event, and the route answers
  200 `{ ok: true, changed: false }`. A stale caller always receives `conflict`, never a silent
  success.
- Rollout (D10): `PROJECT_ASSIGNMENT_ENABLED` / `PROJECT_ASSIGNMENT_CANARY_UIDS`, a new
  `lib/workspaces/projectAssignmentRollout.ts` structural clone of the existing rollout modules,
  checked inside both primitives after `resolveTeamWorkspaceTargetAdmission` and before any
  Firestore access. Non-admission is concealed identically to unauthorized.
- Rate limit: UID-scoped, 20/60s, matching the association route.
- No `checkAndIncrementUsageForRun`, no seat read, no model call.

### 2.4 Audit events (D5, in the same transaction)

Two new `workspaceMembershipEvents` types with a new identity shape carrying both subject and
members:

- `workspace_project_assignees_changed`: `actorUid, workspaceId, projectId: string,
  projectName: string, addedUids[], removedUids[], at` (the Project is the transaction-read,
  validated subject; both fields are always present).
- `workspace_research_assignee_changed`: `actorUid, workspaceId, projectId: string | null,
  projectName: string | null, runId, runQuestion, previousAssigneeUid | null, assigneeUid | null,
  at`. Canonical Team runs may be Unfiled (`projectId: null`), so both Project fields are nullable
  — identical to the §6.5 shape.

**How the run event's Project snapshot is obtained (frozen):**
- If the validated run's `projectId` is `null`, both `projectId` and `projectName` are written as
  `null`.
- If `projectId` is non-null and this is a real change, the Project document is read through the
  **same transaction, before the first write** (all reads still precede all writes), and
  `projectName` is taken from that transaction-read document. **Never a post-commit lookup** to
  construct the authoritative audit event.
- A referenced Project that is missing, malformed, or bound to another Workspace does **not** fail
  the assignment and is **not** a distinguishable response (assignment must not become a Project
  existence oracle): the event is written with the run's `projectId` as stored and
  `projectName: null`, and an integrity warning is logged server-side. Tested explicitly.
- `runQuestion` comes from the transaction-read run document via the repository's established
  sanitized, fail-safe string posture (a non-string or empty question yields the fixed fallback
  label, never a crash); a request-body copy is never trusted.
- The assignment write and the audit event remain all-or-nothing.

DTOs expose display names only (actor, added/removed/previous/new), `project.name` (or the
Unfiled label when null), `research.question`; never any id. Reader validator gets a fourth branch
**before** the member fall-through; UI gets branches **before** the final `else`. No new index:
the existing `{workspaceId, at}` serves the log.

### 2.5 Reads and views (D4, D7)

- `TeamProjectSummaryDto` gains `assignees: {uid, displayName, state}[]` with names resolved
  through `resolveWorkspaceReviewerDisplayNames` (membership-evidenced only, removed members still
  resolve by name) and `state: "active" | "stale"` derived per assignee from current membership at
  read time under the D2 Project rule. `TeamRunSummaryDto` and the Team run detail gain
  `assignee: {uid, displayName, state} | null`, with `state` derived under the D2 run rule.
- v1 views (D7): assignees shown on Team Project rows and on the Project detail header (read-only
  there); assignee shown on research rows in Project detail and on the run detail; a
  `?assignee=me` filter on the Team Project list and on the Project research list as a **view
  filter** layered over the `workspaceId == W` boundary, matching only `state: "active"`
  assignments. "Needs My Review" already exists as the review queue's `assigned_to_me`. Deferred:
  a cross-Workspace "My Projects" landing and any standalone "My Research" surface.

### 2.6 Orphan policy (D4)

**Lazy invalidation, no cascade write.** Removal and role change stay single-document mutations.
Every read derives `state` from current membership; a removed or otherwise ineligible assignee
stays in the stored list (history preserved), renders by name with `state: "stale"`, grants
nothing, and is excluded from assignee-specific active views; every write re-validates every
target, including same-value repeats.

### 2.7 Client (D2, D8, D9)

- **Project list row:** "Assignees" chips + a "Manage assignees" sibling action gated on
  `canManageProjects && project.updateTime !== null`, opening a member-picker dialog that offers the
  member list (`members.read` surfaces), never filters Project assignees by capability, and renders
  server denials honestly (the `AddToTeamProjectDialog` posture). **This is the only Project-assignee
  editor in v1 (D9).**
- **Project detail:** shows assignees read-only in the header. **No** assignee editor there and
  **no** `documentUpdateTime` plumbing for that purpose (D9). Research rows gain a sibling action
  slot beside the row link (the `WorkspaceRunCard` pattern, never inside the link) with an
  **"Assign"** control gated on `research.organize`; that mutation uses the run's own expected-state
  contract, not Project OCC, so it needs no Project token. The run-assignee picker mirrors the D2
  run rule client-side (active member holding `research.create`), labelled as a UX mirror of the
  server predicate.
- **Reviewer overlap (D8):** when the chosen run assignee is also the run's assigned reviewer or a
  panel member, the picker shows a non-blocking warning; the server does not refuse and review
  eligibility is unchanged.
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
KILLED (`docs/operations/security-test-falsifiability.md`).

**False-green harness lessons that bind the implementation phase** (all observed on the
Add-to-Team-Project workstream and recorded there):
- A Jest path containing `[workspaceId]` is read as a regex character class; the runner must use
  `--runTestsByPath`, and "No tests found" is INVALID, never a kill.
- `if (x && false)` / `if (false)` mutations make TypeScript narrow the block to `never` and fail
  `tsc`; express mutations so they typecheck (for example `Math.random() < 0`).
- The security preflight scans only git-tracked specs; stage new specs before trusting "clean".
- "Moved to post-commit" mutations are only killable by inspecting the transaction's own buffered
  `create`/`set` payloads; a store inspected after commit cannot tell atomic from post-commit.
- When a writer promises to support a stored format, walk every reader of that collection and
  test that it consumes the format end to end; a writer-side test proves the copy, not the render.

---

## 4. Decisions — FROZEN by the product owner on 2026-09-14

- **D1.** Use top-level `assigneeUids` on Team Project documents and top-level `assigneeUid` on
  Team-bound run documents. No assignment subcollections. Never write these assignment fields for
  Personal Projects.
- **D2.** Project assignees may be any active same-Workspace member role. Research-run assignees
  must be active same-Workspace members who hold `research.create` under the current capability
  matrix, currently Owner/Admin/Member. Assignment itself grants no capability or authorization.
  The run-assignee client picker may mirror this eligibility for UX, but the server transaction
  remains authoritative.
- **D3.** Project `assigneeUids` has a maximum of 20 entries, deduplicated and canonically sorted.
  The cap is validation/storage bounding, not a seat rule.
- **D4.** Use lazy invalidation, not cascade writes. Removed or otherwise ineligible assignees
  remain in historical assignment state, read as `stale`, grant nothing, are excluded from
  assignee-specific active views, and every mutation must revalidate the target membership even
  for same-value/repeat writes.
- **D5.** Use two Workspace Audit Log event types. Project assignment changes carry bounded full
  `addedUids[]` and `removedUids[]`. Research assignment changes carry previous and new assignee.
  The assignment mutation and its audit event must commit in the same Firestore transaction.
- **D6.** Semantic no-op returns HTTP 200 with `{changed:false}`. It performs no document write,
  no timestamp change, and no audit event.
- **D7.** v1 shows assignees and supports assignee filtering on the Team Project list and the
  Project research list. Cross-Workspace "My Projects" and standalone "My Research" surfaces are
  deferred.
- **D8.** Do not change review eligibility, self-review guards, `humanReviewAssignment/current`,
  `humanReviewPanel/current`, or the review state machine. When the research assignee is also a
  reviewer, surface a non-blocking UI warning only.
- **D9.** Project assignee editing is list-row-only in v1. Do not add the duplicate
  Project-detail-header editor and do not pass `documentUpdateTime` through solely for that
  purpose. Research rows inside Project detail still receive the sibling `Assign` action for the
  run-assignee mutation because that uses the run assignment contract rather than Project OCC.
- **D10.** Use a dedicated Project Assignment rollout gate, separate from Team Workspace admission:
  `PROJECT_ASSIGNMENT_ENABLED` with dedicated canary admission following the repository's existing
  rollout-module convention. Non-admission must be concealed identically to unauthorized access.

These decisions preserve the contract this audit established: assignment is responsibility, never
authorization; reviewers keep the existing review machinery; Workspace membership and capabilities
remain authoritative; and billing, quota, seats, legacy governance, Personal peer review, the
review state machine, export, middleware, rules, and verification execution stay untouched.

---

## 5. Explicitly out of scope for the implementation phase

Any new capability or Project-level role; any change to reviewer assignment, panels, votes, or
`workspaceReviewEligibility.ts` unless D8 chooses it; Personal Workspaces; the `/workspace/reviews`
migration; assignment inside the Add-to-Team-Project dialog; notifications; due dates for
assignees; changes to `firestore.rules`; touching any protected system in F12.

---

## 6. Implementation brief (frozen contract for a later, separately authorized phase)

Everything below follows from §1–§5 and D1–D10. It is written so the implementation phase never
reopens a product decision. Baseline for that phase: `main` at or after `6c89bdb0`, re-verified
fresh; branch created before the first edit; no commit on local main.

### 6.1 Data-model changes

| Document | Field | Type | Rules |
|---|---|---|---|
| `projects/{projectId}` (Team only) | `assigneeUids` | `string[]` | absent ≡ `[]`; ≤ 20; deduplicated; sorted with a fixed comparator (code-unit order); written only by the Team assignee mutation; never written by any Personal path; `isWellFormedProjectV1` is **not** tightened (shared with Personal); a Team read helper validates the field opportunistically (non-array or non-string entries ⇒ treated as `[]` and logged, never fail the page) |
| `runs/{runId}` (Team-bound only) | `assigneeUid` | `string \| null` | absent ≡ `null`; `validateTeamRunRowShape` stays tolerant (absent is **not** a row failure, unlike `projectId`); no backfill |

No new collections. No change to `humanReviewAssignment/current`, `humanReviewPanel/current`,
`workspaceMemberships`, `users`, `firestore.rules`.

### 6.2 Server primitives and routes

- `setTeamProjectAssignees({uid, workspaceId, projectId, assigneeUids, expectedUpdateTime})` —
  a fourth `TeamProjectMutation` member `{kind: "set_assignees", assigneeUids}` in
  `lib/firestore/teamProjects.ts`, executed through `updateTeamProjectFields()`'s frozen order.
  Result union adds `unchanged` (no-op), `assignee_not_eligible` (concealed per-uid reason), and
  `too_many_assignees`. The write `Pick` widens to include `assigneeUids`.
  **Normalization and transaction bounding (primitive-owned, so it holds for any server caller,
  not only the HTTP route):** a pure function `canonicalizeAssigneeUids(input)` validates the shape
  (array of non-empty trimmed strings, each passing the repository's uid-shape check) with no
  Firestore I/O, deduplicates, sorts canonically, and returns `too_many_assignees` when the
  **unique** count exceeds 20 — all **before** the transaction opens and therefore before any
  membership read. The transaction then reads at most 20 membership documents (one `getAll`, or
  individual `tx.get`s bounded by the canonical set) and revalidates every unique target. An
  oversized or duplicate-heavy request can never trigger more than 20 target reads. The route may
  additionally reject an obviously oversized raw array (for example > 200 elements) as 400 before
  calling the primitive, but correctness never depends on the route.
  Route: `POST /api/workspaces/[workspaceId]/projects/[projectId]/assignees`, body allow-list
  exactly `{assigneeUids, expectedUpdateTime}` (unknown key ⇒ 400 `unexpected_field`;
  `assigneeUids` must be an array of non-empty strings, else 400 `invalid_request_body`).
- `setTeamRunAssignee({uid, workspaceId, runId, assigneeUid, expectedAssigneeUid})` — a new
  sibling of `lib/projects/associateTeamRunWithProject.ts` (same file layout, same callback purity),
  in `lib/projects/setTeamRunAssignee.ts`. Result union: `assigned | unchanged | conflict |
  team_workspaces_disabled | project_assignment_disabled | firestore_unavailable | unauthorized
  | run_not_found | assignee_not_eligible | transaction_failed`.
  Route: `PATCH /api/workspaces/[workspaceId]/runs/[runId]/assignee`, body allow-list exactly
  `{assigneeUid, expectedAssigneeUid}` (both keys required, `null` allowed; bad run-id syntax ⇒ the
  concealed `run_not_found`, never a 400).
- Both routes: identity → run-id syntax where applicable → body → UID-scoped rate limit → primitive
  → exhaustive response switch. No non-transactional authorization read in the route.
- Both primitives: `resolveTeamWorkspaceTargetAdmission` then `resolveProjectAssignmentAdmission`
  (D10) before any Firestore access; `adminDb` null ⇒ `firestore_unavailable`.

**HTTP / result mapping (frozen; reuse the existing helpers named):**

| Result | HTTP | `errorCode` / body | Helper |
|---|---|---|---|
| unauthenticated (`missing_credentials`) | 401 | `unauthorized` | route `getUid()` pattern |
| other identity failure | 401 | `auth_error` | route `getUid()` pattern |
| unparseable JSON / wrong shape / missing required key | 400 | `invalid_request_body` | `invalidRequestBodyResponse()` |
| unknown body key | 400 | `unexpected_field` | `unexpectedFieldResponse()` |
| invalid `expectedUpdateTime` token | 400 | `invalid_update_time` | `invalidUpdateTimeResponse()` |
| rate limited | 429 | `rate_limited` | inline, as the association route |
| Team Workspace non-admission, Project Assignment non-admission, every non-capability authorization denial | 404 | `team_workspace_not_found` | `teamProjectAuthorizationDeniedResponse(reason)` — one concealed branch, no rollout oracle |
| `insufficient_capability` | 403 | `insufficient_capability` | `teamProjectAuthorizationDeniedResponse("insufficient_capability")` |
| Project missing / malformed / foreign Workspace | 404 | `project_not_found` | `teamProjectNotFoundConcealedResponse()` |
| run missing / not Team-bound / foreign / bad id syntax | 404 | `run_not_found` | `runNotFoundConcealedResponse()` |
| archived Project | 409 | `project_archived` | `projectArchivedTargetResponse()` |
| stale Project token (early compare or native precondition) | 409 | `conflict` | `staleUpdateTimeConflictResponse()` |
| run-assignee expected-state mismatch | 409 | `assignee_conflict` | new helper, never echoes the current value |
| assignee not eligible (any per-uid reason, either mutation) | 400 | `assignee_not_eligible` | new helper, one shape, reason never surfaced |
| too many assignees (> 20 unique) | 400 | `too_many_assignees` | new helper |
| unchanged (semantic no-op) | 200 | `{ok: true, changed: false}` | inline |
| changed | 200 | `{ok: true, changed: true, ...}` (+ fresh `updateTime` or `null` for Projects) | inline |
| Firestore unavailable / transaction failed / integrity failure | 500 | `internal_error` | `internalErrorResponse()` |

No response distinguishes a foreign Workspace, a non-admitted rollout cohort, or a specific
ineligibility reason.

### 6.3 Authorization and target eligibility (in the transaction)

- Project assignees, in the order frozen in §2.3 and §6.4:
  `authorizeTeamWorkspaceMutationInTransaction(tx, {requiredCapability: "projects.manage"})`;
  Project read through `tx`, well-formed, `id`/`workspaceId` match, `status === "active"`
  (archived ⇒ 409 `project_archived`); **`expectedUpdateTime` compared before any target read**
  (stale ⇒ `conflict`); then, for **every** uid of the already canonicalized and capped set (≤ 20),
  `tx.get` the deterministic membership document, `validateMembershipBinding`, `status ===
  "active"`. Any failure ⇒ `assignee_not_eligible` with the per-uid reason never surfaced (400
  `assignee_not_eligible`, one shape).
- Run assignee, in the order frozen in §2.3 and §6.4:
  `authorizeTeamWorkspaceMutationInTransaction(tx, {requiredCapability: "research.organize"})`;
  run read through `tx` and `validateTeamRunRowShape(run, W)` (legacy/Personal/foreign ⇒ concealed
  `run_not_found`); `expectedAssigneeUid` compared with the normalized current value (mismatch ⇒
  `conflict`); then, when `assigneeUid !== null`, `tx.get` the membership, bind, `status ===
  "active"`, and `roleHasCapability(role, "research.create")` — **even when the requested value
  equals the current value**.
- Re-validation happens on **every** write; the no-op decision (D6) is taken only after OCC and
  validation have both succeeded.
- Assignment fields are never read by any authorization function, resolver, or capability check.
  A structural test asserts `assigneeUid`/`assigneeUids` do not appear in
  `lib/workspaces/{resolveWorkspaceAccess,authorizeTeamWorkspaceMutationInTransaction,
  capabilities,workspaceReviewEligibility}.ts`.

### 6.4 OCC and no-op — the authoritative orderings

**Project assignees:**
normalization/canonicalization/cap (pure) → Team + Project Assignment admission → transaction →
`projects.manage` → Project read/binding/well-formed/status → **`expectedUpdateTime` compared
against the transaction-read `updateTime`; stale ⇒ `conflict` immediately** → validate every
canonical target membership (≤ 20) → semantic no-op determination → no-op ⇒ `{changed:false}`,
no write, no timestamp change, no audit event → real change ⇒ `tx.update` with the same native
`{lastUpdateTime: expectedUpdateTime}` precondition → audit event `tx.set` in the same transaction.
A stale token can never receive a successful no-op response.

**Run assignee:**
Team + Project Assignment admission → transaction → `research.organize` → canonical Team run
read and binding validation → **`expectedAssigneeUid` compared with the normalized current assignee;
mismatch ⇒ `conflict`** → when the requested assignee is non-null, transaction-read and validate
that membership (same Workspace, active, role currently holds `research.create`) — **required even
when the requested assignee equals the current assignee** → only after successful validation,
semantic no-op determination → no-op ⇒ `{changed:false}`, zero writes, zero audit events → real
change ⇒ one-field run update → audit event `tx.set` in the same transaction.

- Project OCC: caller-supplied `expectedUpdateTime` (`validateUpdateTimeToken`), early compare,
  then the same token as the native precondition. Stale ⇒ 409 `conflict` via
  `staleUpdateTimeConflictResponse()`.
- Run OCC: value comparison against the **normalized** current assignee (§6.6) ⇒ 409
  `assignee_conflict`, never echoing the current value.
- Success ⇒ 200 `{ok: true, changed: true, ...}` carrying the fresh `updateTime` token for the
  Project case (`null` if the post-commit read fails, per the existing `projectionUnavailable`
  convention).

### 6.5 Audit-event schemas and atomicity (D5)

New identity shape in `lib/workspaces/workspaceMembershipEvents.ts`:

```ts
interface WorkspaceProjectAssignmentEventIdentity {
  actorUid: string; workspaceId: string; projectId: string; projectName: string;
  addedUids: string[]; removedUids: string[];          // bounded by the cap; may be empty on one side
}
interface WorkspaceResearchAssignmentEventIdentity {
  actorUid: string; workspaceId: string; projectId: string | null; projectName: string | null;
  runId: string; runQuestion: string;
  previousAssigneeUid: string | null; assigneeUid: string | null;
}
```

Event types `workspace_project_assignees_changed` and `workspace_research_assignee_changed`,
written via `tx.set()` on a locally allocated `workspaceMembershipEvents` reference **inside the
mutation's transaction**, `at` reusing the mutation's own `now`. For the run event, `projectId`
and `projectName` follow the frozen rule in §2.4: `null`/`null` for an Unfiled run; otherwise the
Project is read through the same transaction before the first write and `projectName` is taken from
it; a missing/malformed/foreign referenced Project yields `projectName: null` with the stored
`projectId`, a server-side integrity warning, and **no** distinguishable response; `runQuestion`
comes from the transaction-read run with the established sanitized fail-safe posture. Reader (`listWorkspaceAuditEvents.ts`)
gains a fourth validation branch placed **before** the member fall-through; DTOs expose
`actor.displayName`, `added[].displayName`, `removed[].displayName`, `previousAssignee?.displayName`,
`assignee?.displayName`, `project.name`, `research.question`, and **no id of any kind**. Names
resolve through the existing two batched calls. Client parser `isValidAuditEvent` and
`WorkspaceAuditLogShell` gain matching branches **before** the final `else`. No new index.

### 6.6 Read DTOs and stale-state derivation (D4)

- `TeamProjectSummaryDto.assignees: {uid, displayName, state: "active" | "stale"}[]`;
  `TeamRunSummaryDto.assignee` and the run detail result `assignee: {uid, displayName, state} |
  null`.
- `state` is derived at read time from a batched membership read (`getAll` on the deterministic
  ids, one call per page): `active` iff the membership exists, binds, is `status === "active"`,
  and (run assignee only) holds `research.create`; else `stale`. Display names come from
  `resolveWorkspaceReviewerDisplayNames` (removed members still resolve; a non-evidenced uid gets
  the fixed fallback, never a raw uid).
- `state` is presentation metadata: no route branches on it for authorization.

**Malformed stored-assignment normalization (frozen; one shared pure module used by every reader
AND by the mutations' OCC comparisons):**

- Project `assigneeUids`: absent ⇒ `[]`; a valid array of non-empty strings ⇒ the canonical
  deduplicated, sorted values; any other stored shape (non-array, or containing non-string/empty
  entries) ⇒ **`[]`**, with a server-side integrity warning that never includes the raw value. A
  malformed field never crashes a page, never fails a list window, and is never authorization
  input. `isWellFormedProjectV1` is **not** tightened (shared with Personal).
- Run `assigneeUid`: absent or `null` ⇒ `null`; a valid non-empty string ⇒ that value; any other
  stored value ⇒ **`null`**, with a server-side integrity warning. This single deterministic
  representation is used by every reader **and** by the `expectedAssigneeUid` comparison, so a
  malformed stored value compares equal to `null`: an authorized caller sending
  `expectedAssigneeUid: null` with a real assignee repairs the field on the next write, and there
  is no OCC loop a client cannot escape.
- Project repair path is the same: a malformed list normalizes to `[]`, the caller's fresh
  `expectedUpdateTime` still governs, and a real change overwrites the field with a canonical list.
- Clients only ever receive normalized values; raw malformed data never leaves the server.
- Tests: reader and mutation specs proving malformed persisted values cannot crash, cannot widen
  authorization, cannot leak raw malformed data, and cannot create an unrecoverable conflict loop,
  each with a positive control on the same fixture (a valid value round-trips unchanged).

### 6.7 UI surfaces (D7, D9)

- Team Project list (`TeamProjectLifecycleRow`): assignee chips; "Manage assignees" sibling action
  when `canManageProjects && project.updateTime !== null`; `useTeamProjectLifecycle` gains a
  `setAssignees` operation and the per-Project busy lock covers it; stale token ⇒ refetch.
- Assignee picker dialog (`ProjectDialogFrame`): lists `useWorkspaceMembers()` (extracted from the
  two inline `fetchWorkspaceMembers` callers), multi-select for Projects, single-select for runs;
  Project picker offers every active member; run picker mirrors the D2 run rule and labels the
  mirror; reviewer-overlap warning for runs (D8); server denials rendered honestly.
- Team Project detail: assignee chips read-only in the header; research rows gain a sibling action
  slot with "Assign" gated on `research.organize` (`useTeamRunAssignee` hook, per-run busy lock);
  `?assignee=me` filter control on both lists; empty and stale states copy-tested.
- Team run detail: "Assigned to" line with stale marker.
- Audit Log: two new cards ("Project assignees changed", "Research assignee changed").

### 6.8 Required indexes (deploy separately with `firebase deploy --only firestore:indexes`)

- `projects`: `workspaceId ASC, status ASC, assigneeUids CONTAINS, createdAt DESC`.
- `runs`: `workspaceId ASC, assigneeUid ASC, createdAt DESC` and
  `workspaceId ASC, projectId ASC, assigneeUid ASC, createdAt DESC`.
- The filter queries keep `.orderBy(documentId(), "desc")` as tiebreak. `array-contains` is used
  once per query. No membership index is needed.

### 6.9 Rollout (D10)

`lib/env.ts`: `PROJECT_ASSIGNMENT_ENABLED` (boolean, default off) and
`PROJECT_ASSIGNMENT_CANARY_UIDS` (raw string). `lib/workspaces/projectAssignmentRollout.ts`:
structural clone of `approvalWorkflowRollout.ts` (max 10 uids, exact match, global wins over a
malformed list, malformed list with global off admits nobody). Checked inside both primitives after
Team target admission. Non-admission returns the same concealed 404 as unauthorized. The UI offers
the controls only when a `projectAssignmentUiEnabled` signal on `/api/user/usage` is true (same
pattern as `teamWorkspacesUiEnabled`); read DTO fields are always emitted (they are data, not a
control).

### 6.10 Rate limiting

`team-project-assignees:${uid}` and `team-run-assignee:${uid}`, 20 per 60 s each, UID-scoped,
checked after identity and before the primitive. No per-Workspace key.

### 6.11 Security invariants and mutation tests

The twenty invariants in §3, each with its named mutation, run from a committed candidate with
`--runTestsByPath`, `tsc` per mutation, exact reset after each, results recorded. Additional
mandatory tests: a third seat-independence spec (fake store without the seat collections plus a
positive control on an invitation path) and a structural ban on seat/quota imports in every new
module; an audit-UI test proving both new cards render **and** an unknown type would not have
rendered as them; a D2 test showing a Viewer can be a Project assignee but not a run assignee on the
same fixture; a D4 test showing a stale assignee is excluded from `?assignee=me` while still
rendered by name on the row; a D6 test showing a repeat write leaves `updateTime` unchanged and
writes no event, with a positive control that a real change does both.

Contract-correction tests (added 2026-09-14, each with its positive control and a named killing
mutation):
- **Stale token never no-ops:** a stale `expectedUpdateTime` with an already-current list returns
  `conflict`, not `changed:false` — mutation: move the no-op check ahead of the token compare.
- **Same-assignee repeat still validates:** a repeat write naming the current assignee whose
  membership was removed returns `assignee_not_eligible` — mutation: skip validation when the
  requested value equals the current value (the reviewer defect, reproduced and killed).
- **Bounded reads:** a request with 1,000 entries (many duplicates, > 20 unique) performs **zero**
  membership reads and returns `too_many_assignees`; a request with 1,000 entries collapsing to
  ≤ 20 unique performs at most 20 reads — positive control: a valid ≤ 20 canonical set performs
  exactly one validation read per unique target — mutation: validate before canonicalizing.
- **Audit nullability and Project snapshot:** an Unfiled run's event carries `null`/`null`; a filed
  run's event carries the transaction-read name; a filed run whose Project is missing yields
  `projectName: null`, the same success response, and a logged warning — mutations: post-commit
  Project lookup (killed by inspecting the transaction's buffered `set`); distinguishable response
  on missing Project.
- **Malformed stored values:** a run with `assigneeUid: 42` reads as `null`, accepts
  `expectedAssigneeUid: null`, and is repaired by a real write; a Project with `assigneeUids:
  "x"` lists as `[]` without failing the page — mutations: pass raw values through; fail the page.

### 6.12 Unit, integration and UI verification

Route specs (mocked primitives), primitive specs (real authorization helper, in-memory buffered
transaction fake with `txCreateLog`/`txSetLog`), reader specs, audit reader/parser/UI specs, hook
specs (request shape, lock, DTO validation), dialog and row specs (react-test-renderer, source
pins for eligibility mirrors). Full gate: `jest --runInBand`, `tsc --noEmit`, `npm run lint`,
`npm run build`, preflight self-test and full scan after `git add`. No Production contact of any
kind; no live fixture is manufactured.

### 6.13 Protected and out-of-scope systems

Untouched: `lib/governance/teamGovernancePipeline.ts`, `lib/firestore/teamRuns.ts` and the
`teamRuns`/`teams` collections, `lib/teams/*`, `app/api/teams/**`,
`lib/governance/personalReviewerAssignment.ts`, `lib/governance/reviewerFields.ts` and the
`users/{uid}.governanceReviewer*` fields, `app/api/governance/**`, `app/api/user/reviews/**`,
`humanReviewAssignment/current`, `humanReviewPanel/current` and their history subcollections,
`lib/workspaces/workspaceReviewEligibility.ts` and every review route, `lib/stripe/*`,
`middleware.ts`, `firestore.rules`, the export system, claim and video verification execution,
`isWellFormedProjectV1`, `validateTeamRunRowShape`'s strict field set. Out of scope: new
capabilities or roles, subcollections, Personal Workspaces, Project-detail-header assignee editing,
cross-Workspace "My Projects", standalone "My Research", notifications, due dates for assignees,
assignment inside the Add-to-Team-Project dialog, the `/workspace/reviews` migration.

## 7. Source material

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
