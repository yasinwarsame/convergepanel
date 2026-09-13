# Add to Team Project from Personal — R0 Design & Security Audit

**Status:** read-only audit, no implementation. Audited at `main @ 67802ff2` on 2026-09-13.
Every claim below was checked against source at that commit; file:line references are to that tree.

**Owner review 2026-09-13: `ADD_TO_TEAM_PROJECT_R0_ACCEPTED_WITH_AMENDMENTS`.** Decisions D1–D8 are
now decided (§4) and four amendments to the proposed shape are folded into §2, §3 and §6. This
document remains a design record; **implementation is not authorized by it.**

**What R0 is for.** The Personal research addressability prerequisite closed on 2026-09-11
(`/workspace/research/[runId]`, PR #160). "Add to Team Project from Personal" was explicitly
blocked on it and is now unblocked. This document fixes the facts the implementation phase must
design against, names the decisions only the product owner can make, and proposes a shape — it does
not authorize building anything. Sequencing context: `docs/team-workspaces-architecture-audit.md`
§6 question 4 ("is ownership of a run ever transferred to a workspace, or does sharing stay
indirect?") is the one open question from that audit that this feature answers.

**The core invariant (frozen before this audit, re-affirmed by it):** promotion is a
**COPY / SNAPSHOT, never a MOVE.** The Personal source stays Personal, its address
`/workspace/research/{runId}` does not change, no field on the source document is written, and the
Team destination gets its own Team-owned run id with an independently authorized boundary.

---

## 1. Findings — what exists today

### F1. No run-copy path exists anywhere; there are exactly two run creators

- `runs/{runId}` is created by exactly two functions:
  - Personal: `createRun()` — `lib/firestore/runs.ts:155-179`, plain `.set()`, sole caller
    `app/api/run-panel/route.ts:476`.
  - Team: `createTeamWorkspaceRun()` — `lib/firestore/teamWorkspaceRuns.ts:82-190`, `tx.create()`
    inside `runTransaction`, sole caller `app/api/workspaces/[workspaceId]/runs/route.ts:368`.
- Nothing duplicates, clones, or re-homes an existing run. Greps for `clone`, `duplicate`,
  `copyRun`, `sourceRunId`, `originRunId`, `copiedFrom`, `derivedFrom`, `promoted` find no
  persisted field or function.
- **Accidental-creation hazard to design around:** `persistAdaptiveOutput`,
  `persistLegacyAdaptiveOutput`, `persistGovernanceRecord` (`runs.ts:453/487/544`),
  `evaluateAndStoreGovernance` and `teamGovernancePipeline` all use `.set(..., {merge:true})`, which
  silently *creates* a run document if the id does not exist. The snapshot writer must write the
  complete document in one `tx.create()` and must never call these merge writers against a
  not-yet-created id.

### F2. What makes a run "Team-owned" is structural, and `projectId` must be present

- There is no `runType`, `workspaceKind`, `isTeam` or `createdBy` discriminator on a run. A run is
  Team iff `workspaceId` is a `type:"team"` workspace id (i.e. not `personal-{userId}`), classified by
  `classifyRunWorkspaceBindingShape()` (`lib/workspaces/classifyRunWorkspaceBindingShape.ts:26-35`):
  `personal | non_personal_bound | legacy | invalid`.
- The Team row validator `validateTeamRunRowShape()` (`lib/workspaces/teamRunRowValidation.ts:31-53`)
  requires: non-empty `userId`, `workspaceId` exactly equal to the expected workspace,
  `createdAt instanceof Timestamp`, and `projectId` **present** (`null` or a valid string).
  An absent `projectId` fails the row closed, and `listTeamWorkspaceRuns()` fails the **whole page**
  on any invalid row (`lib/workspaces/listTeamWorkspaceRuns.ts:89-104`). The validator is not an
  allowlist: extra fields (a provenance block) are harmless.
- The exact document `createTeamWorkspaceRun()` writes (`teamWorkspaceRuns.ts:150-159`):
  `userId, workspaceId, projectId (always), question, selectedModels, status:"running", createdAt`.
  It writes no results: `executeOrdinaryRun()` completes it later. **A no-AI snapshot must write
  `status:"complete"`, `completedAt` and the result payload in the same `tx.create()`**, otherwise
  `getTeamWorkspaceRun()` reports it as `pending` forever (`teamWorkspaceRuns.ts:242-244`).

### F3. An Unfiled Team run is unreachable in the Team UI — the feature must require a Project

- The only Team run-detail route is
  `app/workspace/team/[workspaceId]/projects/[projectId]/research/[runId]/page.tsx`, and
  `getTeamWorkspaceRun()` conceals any run whose `projectId !== args.projectId` as `not_found`
  (`teamWorkspaceRuns.ts:231`). A snapshot with `projectId: null` would exist but have no page.
- Consequence: the dialog is Workspace → **Project (required)**, never "Unfiled".

### F4. The Team detail read model is raw per-model text only — a fidelity gap Team members will see

- `getTeamWorkspaceRun()` returns `{runId, question, governanceStatus?, results}` where `results`
  is `runDocumentToPublicResults(data.runDocument)` (`teamWorkspaceRuns.ts:236-249`). It does not
  read `adaptiveOutput`, `legacyAdaptiveOutput`, `synthesizedStructuredReport`, or
  `governanceRecord`.
- `components/workspace/projects/TeamResearchResultView.tsx` renders each model's `rawTextFull`
  (parsing JSON into `StructuredResearchResult` when it happens to be JSON) plus a `GovernanceChip`.
  Its header comment states this is deliberate: it is not `ResultsDisplay.tsx` and does not consume
  the `adaptive` field.
- Meanwhile `runDocumentToPublicResults()` sets `rawTextFull = perModel.rawTextTruncated`
  (`lib/user/runDocumentToPublicResults.ts:11-36`): the stored copy is already the storage-truncated
  text (20,000 chars per model, `lib/panel/sanitizeText.ts:8`).
- **What this means for the product:** a Personal Deep Research run whose owner saw a synthesized,
  schema-rendered report will appear to Team members as five blocks of per-model text. Nothing in
  this feature can fix that without widening the Team read surface, which is a separate phase. The
  design must copy the rich fields anyway (so a later Team surface can render them) but must set
  expectations honestly in the dialog copy. See Decision D4.

### F5. The Team mutation authorization pattern is fixed, and it is transactional

- Canonical gate: `authorizeTeamWorkspaceMutationInTransaction(tx, {uid, workspaceId,
  requiredCapability})` (`lib/workspaces/authorizeTeamWorkspaceMutationInTransaction.ts:93-170`).
  Order: workspace exists/well-formed/`type:"team"` → caller membership at the deterministic id,
  bound, `status:"active"` → caller owner-integrity → the true owner's membership is canonical →
  `roleHasCapability`. Denials: `workspace_not_found | workspace_malformed | membership_not_found |
  membership_removed | membership_malformed | owner_integrity_violation | insufficient_capability`.
- Capabilities that apply (`lib/workspaces/capabilities.ts:47-137`): creating research is
  `research.create`; filing into a Project additionally needs `research.organize` **from the same
  already-returned membership** (`teamWorkspaceRuns.ts:127-130`). Owner, Admin and Member hold both;
  Reviewer and Viewer hold neither.
- The target Project is read **through the same `tx`** and must satisfy `isWellFormedProjectV1`,
  `id === projectId`, `workspaceId === W`, `status === "active"`; malformed / foreign / missing
  conceal identically as `project_not_found`, archived is the distinct `project_archived`
  (`teamWorkspaceRuns.ts:132-146`, `lib/projects/associateTeamRunWithProject.ts:208-225`).
- Rollout: `resolveTeamWorkspaceTargetAdmission(...)` is called **inside the Firestore primitive
  before any read**, and `team_workspaces_disabled` maps to the same concealed 404 as `unauthorized`
  (`lib/projects/teamProjectErrorResponse.ts:34`). Only `insufficient_capability` is a 403, because
  the caller is already a proven member. "A rollout flag is not an authorization boundary"
  (`app/api/workspaces/route.ts:49`).
- `resolveWorkspaceAccess()` is read-only authority; a write must re-derive inside its own
  transaction (`app/api/workspaces/[workspaceId]/projects/route.ts:8-12`).

### F6. Source authorization has no precedent as a *write-side* check — it must be designed

- Personal ownership today is `run.userId === uid` **after** the binding is proven Personal:
  `GET /api/user/runs/[runId]` classifies the shape first and enters the Team branch before any
  owner shortcut (`app/api/user/runs/[runId]/route.ts:158-236`); the Personal branch then requires
  `validateRunWorkspaceAssociation()` to be `legacy` or `valid`.
- For the snapshot source, the required predicate is therefore: run exists, `status === "complete"`,
  `classifyRunWorkspaceBindingShape(run)` is `legacy` or `personal`, and `run.userId === uid`.
  `non_personal_bound` (a Team run) and `invalid` must be refused **before** any owner comparison,
  exactly as `resolvePersonalSourceResearchLink()` does
  (`lib/verification/resolvePersonalSourceResearchLink.ts:84-96`). A Team run must not be
  re-promoted through this path: Team→Team is a different feature with different authorization.
- Artifact-type separation is structural: a verification or video id is simply not in `runs`. No
  type check is needed beyond "the document at `runs/{id}` exists and passes the predicate".
- Whether the source read happens inside the same transaction as the create is a design choice; it
  should (one `tx.get` on the source, so a source deleted between check and write cannot be copied).

### F7. Quota must not be charged; the rate-limit precedent is UID-scoped

- Both existing creators call `checkAndIncrementUsageForRun(uid, modelCount)` because they spend
  model tokens (`app/api/run-panel/route.ts:417`, `app/api/workspaces/[workspaceId]/runs/route.ts:330`).
  A snapshot performs no model call. The metadata-only Team mutation precedent,
  `associateTeamRunWithProject`, calls no quota writer and uses only
  `checkRateLimit({identifier: "team-run-project-assign:${uid}", 20/60s})`
  (`app/api/workspaces/[workspaceId]/runs/[runId]/project/route.ts:92-97`).
- There is no workspace run quota; seats count people only (`TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT
  = 5`, `lib/workspaces/teamWorkspaceSeatLimit.ts:23`). No plan gate for Team Workspaces exists in
  `lib/plans.ts`; admission is rollout only.
- A free snapshot avoids the documented "quota consumed then transaction denied" tradeoff
  (`runs/route.ts:27-30`), and reviewers will look for that statement.

### F8. No idempotency mechanism exists in the codebase

- No route accepts an idempotency key (`Idempotency-Key`, `clientRequestId` appear only in the
  Stripe webhook). Substitutes in use: OCC tokens (`expectedUpdateTime`), expected-state tokens
  (`expectedProjectId`), server-allocated ids outside the transaction with `tx.create()`, and
  deterministic ids where "ALREADY_EXISTS is idempotent success" (`lib/firestore/runs.ts:1971`,
  `lib/workspaces/membershipId.ts`).
- Run ids are `run-${randomUUID()}` by convention but `validateRunIdSyntax()` does not require that
  format (`lib/projects/runIdSyntax.ts:23-33`). A deterministic snapshot id would pass syntax but
  would be a novel id scheme for `runs`; the safer precedent is a deterministic **lock document** in a
  side collection created in the same transaction. See Decision D3.

### F9. Provenance has no field yet; the precedent is `origin` written in the same transaction

- The only cross-artifact pointer in the schema is `origin: {type:"deep_research_claim", runId,
  claimId}` on verifications, write-once, absent-not-null, with the explicit rule that
  `workspaceId`, `projectId`, creator uid, creation time are **not** duplicated inside it because each
  has a canonical home (`lib/verification/claimVerificationOrigin.ts:37-49`). The coupled type
  `TeamOriginSnapshot = {origin, evidenceSources} | null` makes "half a provenance" unrepresentable
  (`lib/firestore/teamClaimVerifications.ts:202-204`).
- Phase 4C's permanent lesson applies directly: *absence of best-effort secondary state is not
  evidence* (`docs/workspaces/phase4c-historical-provenance-audit.md`). If provenance were a second
  write, nobody could later prove a Team run was a snapshot. **Provenance goes inside the same
  `tx.create()` as the run document.**
- `RunDocument` embeds its own `runId` and `userId` (`lib/panel/schemas.ts:110-112`). Copying it
  verbatim leaves the source id inside the payload. No reader uses those embedded fields today, but
  the snapshot should rewrite `runDocument.runId` to the new id so the payload is self-consistent.

### F10. Governance and review state must not be copied; what a fresh Team run gets is defined

- Review authority is `runs/{runId}.governanceRecord.humanReview.status`
  (`lib/workspaces/reviewQueue.ts:6-8`), plus discovery projections
  `humanReviewAssignment/current`, `humanReviewPanel/current`, `humanReviewVotes/*`, and immutable
  `humanReviewHistory/*`, `governanceEvents/*`, `exports/*` subcollections. All are strategy **B**
  (inherit from parent run) per `docs/workspaces/architecture.md:149-157`.
- Copying `governanceRecord` verbatim would carry a Personal reviewer's decision, `reviewerId` and
  `reviewedAt` into a Team workspace where that reviewer may not be a member, and would surface the
  run in `recently_approved`/`changes_requested` queues immediately. **Do not copy it, and do not copy
  any subcollection.**
- A native Team adaptive run does get a fresh `governanceRecord` from the execution engine via
  `initializeAdaptiveGovernanceRecord({runId, adaptiveOutput})`
  (`lib/runPanelExecution.ts:823-860`, `lib/adaptiveSchema/governanceInitialization.ts:73`), with
  `humanReview.status = "unreviewed"`. For parity, a snapshot of an adaptive source gets the same
  record, built for the **copied** `adaptiveOutput` and the **new** run id. Because the initializer
  persists with a merge write (F1) and a second write would be best-effort state (F9), the record
  must be built **before** the transaction by a pure builder and embedded in the same `tx.create()`
  (amendment, §6). A snapshot with no adaptive output gets no record, matching a native
  non-adaptive Team run. See Decision D5.
- `run.userId` on the copy is the promoter's uid, which is necessarily also the Personal owner's uid
  (F6), so there is no attribution dilemma. It does mean the self-review guard
  (`lib/workspaces/workspaceReviewEligibility.ts:53-63`) bars the promoter from reviewing the copy,
  which is the correct outcome.
- `governanceStatus` (`approved|needs_review|blocked`) is a separate denormalized field written by
  `evaluateAndStoreGovernance()` from the synthesize path. Copying it is harmless for display (it is
  what the `GovernanceChip` shows) but it is a Personal-policy verdict. See Decision D5.

### F11. Claim-verification links and exports behave differently on the copy

- "Verify this claim" from a Team run goes through `resolveClaimVerificationOrigin()` with
  `expectedWorkspaceId = W`, which requires the origin run to be `non_personal_bound` **to that same
  workspace** (`claimVerificationOrigin.ts:405-423`). Claim ids are fingerprinted over `runId +
  section + index + rawId + summary` and attached at response time, never persisted
  (`lib/verification/attachDeepResearchClaimIds.ts`; `app/api/user/runs/[runId]/route.ts:487`). A
  copied `adaptiveOutput` under a new run id therefore yields new, valid claim ids for the copy.
  Nothing breaks, but only once a Team surface renders Deep Research findings (F4).
- Existing verifications whose `origin.runId` points at the Personal source keep resolving against
  the source for its owner (`resolvePersonalSourceResearchLink`). They are not re-linked to the copy,
  and must not be.
- Export (`app/api/user/runs/[runId]/export/route.ts:107-117`) is owner-only (`data.userId === uid`)
  and knows nothing of workspaces. Team runs cannot be exported today; a snapshot inherits that.
  `exports.create` is in the capability matrix but enforced nowhere. Out of scope.

### F12. There is no aggregate document-size guard; a full copy needs one

- Per-field guards exist (`MAX_CHARS_STORAGE_PER_MODEL = 20000`, `MAX_TOTAL_DOC_SIZE = 850000`,
  `lib/panel/sanitizeText.ts:8-11`) but each persister measures only its own payload and the known
  limitation is documented at `lib/firestore/runs.ts:511-524`: a document already near the limit can
  be pushed past 1 MiB. A snapshot that writes `runDocument + adaptiveOutput + legacyAdaptiveOutput +
  synthesis fields + origin` in one create has no guard at all.
- Required: `estimateDocumentSize(payload) <= MAX_TOTAL_DOC_SIZE` before `tx.create()`, refusing
  with a distinct, non-retryable `snapshot_too_large` rather than silently truncating a report the
  owner already saw in full. Expected to be rare (the source itself passed the same budget).

### F13. The Workspace Audit vocabulary is closed; `projectEvents` is not read by the audit log

- Audit source is the `workspaceMembershipEvents` collection with a five-member union
  (`lib/workspaces/workspaceMembershipEvents.ts:87-92`); reader allowlists at
  `lib/workspaces/listWorkspaceAuditEvents.ts:87-93`; UI is a literal ternary chain in
  `components/workspace/WorkspaceAuditLogShell.tsx:121-185` whose final `else` would mislabel an
  unknown type as "Role changed". Project archive/restore events are written **inside** the
  mutation's transaction ("committed iff audit event committed", `lib/firestore/teamProjects.ts:41-45`).
- `projectEvents` (`project_run_association_changed` etc.) is a reader-less stream, written
  post-commit best-effort (`lib/projects/projectEvents.ts:67-82`).
- A user-visible "research added from Personal" audit row needs a new event type with all four edits
  (write union + identity shape, writer in-transaction, reader allowlist + DTO + validator branch, UI
  branch). See Decision D6.

### F14. Client surfaces: the shell has never mutated anything; the pickers exist

- `components/workspace/PersonalResearchDetailShell.tsx` takes exactly `{runId}` (`:99`), fetches
  `GET /api/user/runs/{runId}` with one forced-refresh retry, and has three navigation-only actions
  (Back, Verify this claim, follow-up). Adding "Add to Team Project" makes it the **first mutating
  affordance** on that surface.
- Team workspace list: `useWorkspaceList()` (`hooks/useWorkspaceList.ts`) pages to completion over
  `GET /api/workspaces` (`{workspaceId, name}` only, not rollout-gated). Team projects:
  `useTeamProjects({workspaceId, status:"active"})` fails closed if any row is not the requested
  status. Dialog precedent: `components/projects/AddToProjectDialog.tsx` (active-only listbox) with
  the per-run lock pattern in `hooks/useRunProjectAssociation.ts`.
- Neither picker is a security boundary (`components/WorkspaceSwitcher.tsx:7-11`,
  `lib/workspaces/listViewerTeamWorkspaces.ts` header). The dialog offers; the server decides.
- The Personal detail page is deliberately not gated on `workspaceUiEnabled`/`projectsUiEnabled`
  (`app/workspace/research/[runId]/page.tsx:13-19`). The new action needs its own offering signal;
  the existing `teamWorkspacesUiEnabled` (`app/api/user/usage/route.ts:127`, `hooks/useUserPlan.ts`)
  is the natural one and already gates TopNav's Team entry.

### F15. Firestore rules need no change

- `firestore.rules` has three match blocks and a catch-all `allow read, write: if false;`
  (`firestore.rules:159-162`). The browser cannot touch `runs`, `workspaces`, `projects` or any event
  collection; every write is Admin SDK. Adding a rule would be a posture regression.

### F16. Side effects on the destination Workspace

- `deriveWorkspaceActivationState()` (`lib/workspaces/activationState.ts`) treats `hasResearch` as
  the final activation step; the first snapshot into an otherwise empty Team workspace flips it to
  fully active. Acceptable and worth a test.
- `MAX_PROJECTS_PER_WORKSPACE = 200` exists for projects; no run count cap exists for workspaces.

### F17. The source is never written

- "No historical run is ever mutated" (`docs/workspaces/architecture.md:485`). The source gets no
  `promotedTo` pointer, no `updatedAt`, nothing. Reverse lookup ("where has this been promoted?")
  would need a query on `origin.runId` with a composite index and is deferred (Decision D7).

---

## 2. Proposed shape (decided 2026-09-13 with the §6 amendments folded in)

**Endpoint.** `POST /api/workspaces/[workspaceId]/projects/[projectId]/research/snapshots`
(the target Project is required, F3, so it belongs in the path; `workspaceId`/`projectId` are never
read from the body). Body allow-list: `{ source: { sourceType: "personal_research", runId } }` —
the typed source identity fixed in the R0 brief, so the destination refuses a Team or verification id
without guessing. Any other key → `unexpected_field`.

**Route skeleton** (mirrors `runs/[runId]/project/route.ts`): `runtime = "nodejs"` →
`resolveRequestIdentity` → `validateRunIdSyntax(source.runId)` (bad id = concealed 404, never a 400)
→ `checkRateLimit("team-run-snapshot:${uid}", 10/60s)` → body parse → one lib call → exhaustive
response switch → post-commit awaited `writeTeamProjectEventSafely`.

**Lib primitive** `createTeamRunSnapshotFromPersonal({uid, workspaceId, projectId, sourceRunId})`
in `lib/firestore/teamWorkspaceRuns.ts` or a sibling, structured like `createTeamWorkspaceRun()`:

1. `resolveTeamWorkspaceTargetAdmission(...)` before any Firestore access.
2. Allocate `newRunId = run-${randomUUID()}` **outside** `runTransaction`.
3. Inside one transaction, reads first, all writes last:
   1. `authorizeTeamWorkspaceMutationInTransaction(tx, {requiredCapability: "research.create"})`,
      then `roleHasCapability(membership.role, "research.organize")` from the same membership.
   2. `tx.get(projects/{projectId})` → well-formed, `id` match, `workspaceId === W`,
      `status === "active"` (else `project_not_found` / `project_archived`).
   3. `tx.get(runs/{sourceRunId})` → exists, `status === "complete"`, shape `legacy|personal`
      **first**, and only then `userId === uid` (any failure → concealed `source_not_found`; never
      distinguish "not yours" from "does not exist").
   4. **Idempotency lock, read first** (Decision D3, amended): compute
      `lockId = sha256(JSON.stringify({version: 1, sourceRunId, workspaceId, projectId}))` — a
      canonical tuple encoding, never `a|b|c` concatenation — and `tx.get(runSnapshotLocks/{lockId})`
      while still in the read phase. If it exists: validate its shape, require the stored tuple to
      equal the request, require a valid `createdBy`, then `tx.get(runs/{lock.snapshotRunId})` and
      require `workspaceId === W`, `projectId === projectId`, `origin.type === "personal_research"`,
      `origin.runId === sourceRunId`. Valid → return `already_exists` with no further write of any
      kind. Malformed lock or missing/mismatched destination → internal integrity failure, fail
      closed, no repair in v1. Never "create the lock and recover from ALREADY_EXISTS after commit".
   5. Build the **entire** snapshot payload (below), including `origin` and, for an adaptive source,
      the fresh `governanceRecord` from the pure builder; `estimateDocumentSize` ≤
      `MAX_TOTAL_DOC_SIZE` else `snapshot_too_large` with nothing written.
   6. Writes, all three or none: `tx.create(runs/{newRunId}, payload)`;
      `tx.create(runSnapshotLocks/{lockId}, {version:1, sourceRunId, workspaceId, projectId,
      snapshotRunId: newRunId, createdBy: uid, createdAt})`; `tx.set(workspaceMembershipEvents/{auto},
      workspace_research_snapshot_created)` (Decision D6, decided yes).
4. After commit only the non-authoritative `writeTeamProjectEventSafely` remains; its failure never
   makes the committed snapshot look rolled back. No governance write happens after commit.

**Snapshot payload** (every field either copied verbatim from the source or set fresh):

| Field | Value |
|---|---|
| `userId` | promoter uid (= source owner, F6/F10) |
| `workspaceId`, `projectId` | target W, target Project id (always present) |
| `question`, `selectedModels` | copied |
| `status` | `"complete"` (source must be complete) |
| `createdAt`, `completedAt` | **now** (fresh Team identity; source times live in `origin`) |
| `runDocument` | copied, with `runDocument.runId = newRunId` |
| `tokenUsage`, `totalTokens`, `tokensByModel`, `tokensByProvider` | copied (attribution of past spend, not a new charge) |
| `adaptiveOutput`, `legacyAdaptiveOutput` | copied if present |
| `synthesizedStructuredReport` + its six sibling fields | copied if present |
| `governanceStatus` | **absent** (D5: a Personal policy verdict never crosses the Workspace boundary) |
| `governanceRecord` | **never copied**; for an adaptive source a **fresh** record (`humanReview.status = "unreviewed"`, new run id) from the pure builder, embedded in this same create (D5, §6) |
| `teamGovernance`, all subcollections, `adaptiveExportCounter` | **never copied** |
| `origin` | `{ type: "personal_research", runId: sourceRunId, sourceCreatedAt, sourceCompletedAt }` |

`origin` follows the verification precedent: it records the pointer and the point-in-time facts that
have no other canonical home (the source's timestamps, since the copy's own timestamps are fresh) and
nothing that does (creator uid, workspace, project).

**Response.** 201 `{ok:true, runId, workspaceId, projectId, href}` with `href` the Team detail
route. Error mapping: `insufficient_capability` → 403; `team_workspaces_disabled`, every other
authorization reason, `project_not_found`, `source_not_found` → concealed 404s using the existing
helpers; `project_archived` → 409 `project_archived`; `snapshot_too_large` → 413 (non-retryable);
`already_exists` → 200 with the existing id; infra → 500/503.

**Client.** A button on `PersonalResearchDetailShell` offered only when the report is loaded,
**`viewerRole === "owner"`** and `teamWorkspacesUiEnabled` (a `personal_reviewer` can read the page
but must never see the action: the server would reject them on source ownership, and a visible
affordance that always fails is a defect, §6), opening a two-step dialog (Workspace via `useWorkspaceList`, then active Projects via
`useTeamProjects`), per-run busy lock, success state linking to the Team run page. Copy must say what
Team members will see (F4, Decision D4). The Personal page itself is unchanged after success.

---

## 3. Security invariants the implementation must prove (with the mutation that kills each)

1. Source must be the caller's own Personal run — mutation: drop the `userId === uid` check.
2. Source must be Personal-shaped — mutation: accept `non_personal_bound` (a Team run of another
   workspace the caller can read).
3. Target Project must belong to the path workspace — mutation: drop `project.workspaceId === W`.
4. Target Project must be active — mutation: drop the status check.
5. Capability is `research.create` **and** `research.organize` — mutations: Reviewer role passes;
   Viewer role passes.
6. Authorization is re-derived inside the write transaction — mutation: authorize via
   `resolveWorkspaceAccess()` before the transaction and skip the in-tx gate.
7. `workspaceId`/`projectId` never come from the body — mutation: read them from the body.
8. `projectId` is always present on the written document — mutation: omit it (row validator and
   list page must fail; the test must show the list page succeeds in the positive case first).
9. No source field is written — mutation: add a `promotedTo` update to the source.
10. No subcollection or `governanceRecord` is copied — mutation: copy `governanceRecord`.
11. Provenance is in the same `tx.create` — mutation: move `origin` to a post-commit update, then
    inject a post-commit failure.
12. Rollout denial is concealed identically to not-found — mutation: return 503 on disabled.
13. Quota is not charged — mutation: call `checkAndIncrementUsageForRun` (assert `users/{uid}`
    unchanged, with a positive control showing the native Team creator does change it).
14. Duplicate submission yields the same snapshot id, not two runs — mutation: remove the lock.
15. Size guard refuses rather than truncates — mutation: remove the estimate.
16. The action renders only for `viewerRole === "owner"` — mutation: render it for
    `personal_reviewer` (the test must first show it renders for the owner on the same fixture).
17. An existing lock is validated against its destination run before being trusted — mutation:
    return `lock.snapshotRunId` without reading and checking the destination.
18. The fresh adaptive `governanceRecord` is inside the same create — mutation: initialize it after
    commit, then inject a post-commit failure.
19. The audit event is atomic with the snapshot — mutation: write it post-commit, then inject a
    post-commit failure; also, an idempotent repeat must not add a second event.
20. The lock key is a canonical tuple — mutation: hash `sourceRunId + "|" + workspaceId + "|" +
    projectId` and show two distinct tuples can collide or that the contract test fails.

Test-evidence rules from `docs/operations/security-test-falsifiability.md` apply in full: every
denial needs a positive control on the same fixture, every mutation is run and recorded KILLED, and
`npm run security:preflight` must pass.

---

## 4. Decisions — DECIDED by the product owner 2026-09-13

- **D1. Scope of "Personal" source — DECIDED: yes.** `legacy` runs (no `workspaceId`, pre-Phase-3)
  and `personal`-bound runs both qualify, provided the run is proven Personal-shaped **before** the
  `userId === uid` check. Ownership is `userId` either way and the Personal detail route already
  serves both.
- **D2. Source status — DECIDED: `complete` only.** Running, queued, failed or partial artifacts are
  never snapshotted.
- **D3. Idempotency — DECIDED: at most one snapshot per (source, workspace, project) via a
  deterministic lock, AMENDED:** the lock is **read inside the transaction before any write** and
  validated together with the destination run it names; the key hashes a canonical tuple encoding
  (`JSON.stringify({version:1, sourceRunId, workspaceId, projectId})`), never naive concatenation.
  Promoting into two different Projects stays allowed.
- **D4. Fidelity disclosure — DECIDED: ship with disclosure.** Copy the rich persisted fields now;
  tell the owner that Team members may currently see the underlying model responses rather than the
  full Deep Research layout; widen the Team read surface separately.
- **D5. Governance on the copy — DECIDED: fresh yes, Personal verdict no, AMENDED:** the fresh
  adaptive `governanceRecord` is built by a pure builder extracted narrowly from
  `initializeAdaptiveGovernanceRecord` and embedded in the same `tx.create()`, not merged in after
  commit; parity tests prove the refactor changes no existing initializer output. `governanceStatus`
  is never copied.
- **D6. Audit visibility — DECIDED: yes.** `workspace_research_snapshot_created`, written in the same
  transaction as the run and the lock. The user-facing audit DTO should not expose the Personal
  source run id unless explicitly required; provenance lives on the run's `origin`.
- **D7. Reverse lookup — DECIDED: defer.** Zero writes to the source, no `promotedTo`, nothing.
- **D8. Rate limit — DECIDED: 10/60s per uid, no per-workspace cap.** The operation uses no models
  and consumes no inference quota.
- **Added requirement — owner-only action.** The action requires `viewerRole === "owner"` and the
  Team offering signal; it is never shown to a `personal_reviewer`.

The full implementation brief (sections A–AF, 40-item security matrix, mutations M16–M26, completion
report format) was supplied by the owner on 2026-09-13 and is the contract for the implementation
phase once it is explicitly authorized.

---

## 5. Explicitly out of scope for the implementation phase

- Team→Team or Team→Personal copies; moving (re-homing) a run; any write to the source.
- Rendering adaptive/synthesis output on the Team detail page (F4).
- Team export (`exports.create` is unenforced everywhere today).
- Assignment/reviewer selection inside the dialog (Project/Research assignment is its own frozen
  roadmap item; "assignment is not authorization").
- Re-linking existing verifications to the copy.
- Firestore rules changes (F15) and any new index unless D6/D7 require one.

---

## 6. Amendments after owner review (2026-09-13)

Four changes to the R0 proposal, each strengthening an invariant the audit itself identified:

1. **Lock read before write (D3).** The first draft relied on `tx.create(lock)` failing at commit and
   recovering the existing id afterwards. That makes "already exists" a commit-time exception path
   and trusts whatever id the stored lock names. Amended: read the lock in the read phase, validate
   its tuple and `createdBy`, read the destination run it names and validate that run structurally
   (workspace, project, `origin.type`, `origin.runId`). A corrupt lock is an internal integrity
   failure that fails closed; it is not repaired and its stored id is never returned blindly.
2. **Canonical lock key (D3).** `sha256(a|b|c)` is only safe if none of the three ids can contain
   the separator. Run and project ids are validated only syntactically (`validateRunIdSyntax` forbids only
   `/`, control characters and `.`/`..`). Amended: hash a versioned canonical JSON tuple.
3. **Fresh governance record in the same create (D5).** The first draft called the existing
   initializer after commit, which is a merge write and therefore best-effort secondary state — the
   exact pattern F9 and the Phase 4C lesson forbid for anything that must be provably present.
   Amended: extract the record-building step of `initializeAdaptiveGovernanceRecord` as a pure
   function, keep the initializer's behaviour for existing callers byte-identical (parity tests), and
   embed the built record in the snapshot payload before the size estimate and the create.
4. **Owner-only client action.** `GET /api/user/runs/[runId]` serves the canonical page to a
   `personal_reviewer` as well as the owner. The server rejects a reviewer on source ownership, but
   rendering the action for them is a dead affordance of the kind URL-1/C1 already had to remove once.
   Amended: `viewerRole === "owner"` is a rendering precondition alongside the Team offering signal.

Invariants 16–20 in §3 pin these amendments to mutations.

## 7. Source material

Three parallel source-reading passes (run data model and writers; Team authorization, Project and
audit model; rules, client surfaces, precedents and test conventions), each cited by file:line at
`67802ff2`, followed by direct re-verification of the load-bearing claims: the Team create payload
and reader (`lib/firestore/teamWorkspaceRuns.ts`), the row validator, the Team detail page and
`TeamResearchResultView`, the binding-shape classifier, the Personal source-link resolver, the
governance initializer, run-id syntax, and the rules catch-all. Design docs consulted:
`docs/workspaces/architecture.md` (resource classification, export-freeze decision, security
invariants), `docs/workspaces/phase8-team-workspace-foundation.md` (capability matrix, owner
invariant, OCC), `docs/workspaces/phase4c-historical-provenance-audit.md`,
`docs/team-workspaces-architecture-audit.md` §6, `docs/operations/security-test-falsifiability.md`.
