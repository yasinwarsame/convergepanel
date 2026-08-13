# Workspace & Projects Program — Architecture

**Status: Phase 1 implemented, merged, in production. Phase 2 implemented, PR open, not yet merged. No workspace-aware route wiring. No production data mutated by Phase 2 (no bulk provisioning has been run). Not user-visible.**

This document describes what each phase actually built, why, and the invariants later phases must preserve. It is implementation-specific, not aspirational product prose. For the pre-existing data-model/authorization audit this design is built on, see `docs/team-workspaces-architecture-audit.md`.

## Program context

This is an 8-phase program:

1. **Workspace Compatibility Foundation** — COMPLETE, in production (merge commit `4ee808c3d041192fc276002fe24f284c17ffc91f`)
2. **Personal Workspace Provisioning** — implemented, this document's newest section, PR open
3. Workspace-Aware Writes — not started
4. Workspace-Aware Reads + History — not started
5. Workspace UI — not started
6. Projects Foundation — not started
7. Projects UI — not started
8. Shared Workspace / Collaboration — not started

Phase 1's job: introduce the minimum architecture required for ConvergePanel to *understand* the concept of a Workspace, additive, backward-compatible, dark by default, independently releasable — zero effect on any existing user or route.

Phase 2's job: prove that exactly one Personal Workspace document can be safely, idempotently, concurrency-safely created for a uid — and nothing more. Phase 2 explicitly does NOT bind any existing resource to a workspace, does not backfill, does not wire authorization, and does not change what any user sees. Provisioning a Personal Workspace and binding a run to that workspace are deliberately separate operations; only the former exists after Phase 2.

## Domain model

```ts
type WorkspaceType = "personal" | "team";

interface WorkspaceV1 {
  schemaVersion: 1;
  id: string;
  type: WorkspaceType;
  name: string;
  ownerUserId: string;
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}
```

`lib/workspaces/types.ts`. `WorkspaceType` includes `"team"` as a documented future value so the document shape never needs a breaking change later — but Phase 1's resolver can only *authorize* `"personal"` (see Error Semantics below). No memberships, invitations, roles, project permissions, billing ownership, or team seats are introduced in this phase.

**`WorkspaceType: "team"` does not imply integration with this codebase's existing `teams/{teamId}` governance system.** They are unrelated so far: `type: "team"` is a placeholder value in a domain vocabulary nothing can create yet, while `teams/{teamId}` (§1a of `docs/team-workspaces-architecture-audit.md`) is a real, narrow, review-only system with its own membership/role model, one-team-per-user constraint, and Full-plan gate. Whether a future "team workspace" ever wraps, replaces, or stays entirely separate from the existing `teams` system is an explicit open question for a later phase (see the resource classification table's `teams/{teamId}` row) — not something this phase decides, implies, or should be read as implying.

No `Workspace` document was created, updated, or deleted by Phase 1 code — `lib/firestore/workspaces.ts` exported exactly one function, `getWorkspace()`, a read. **Phase 2 adds exactly one narrow write capability** — see "Phase 2 — Personal Workspace Provisioning" below. There is still no generic `createWorkspace(data)`, no update function, no delete function, and still no way to create anything other than a `type: "personal"` workspace for the caller's own authenticated uid.

## Personal Workspace concept

The architectural concept established now: each user may eventually have one Personal Workspace, `type: "personal"`, `ownerUserId === uid`. Phase 1 does **not** create these documents for any existing user — that is Phase 2's explicit scope. Phase 1 only defines the shape and the resolution/authorization behavior a future Personal Workspace would participate in.

## Legacy compatibility model

Every existing resource (`runs`, `verifications`, `videoVerifications`, exports, etc.) is owned today by a single scalar field — `userId` or `ownerUid` — and none of them carry a `workspaceId`. That does not change in Phase 1. The compatibility rule:

```
record.workspaceId exists      → resolve workspace authorization
record.workspaceId absent      → use existing legacy authorization (unchanged)
```

`workspaceId` is defined as `workspaceId?: string` wherever it is eventually added (Phase 3+) — always optional. **Missing `workspaceId` is never treated as an invalid record.** No Phase 1 code derives, persists, or mutates a `workspaceId` on any existing document as a side effect of a read. No workspace document is ever created as a side effect of an authorization check.

## Central resolver

One canonical, server-side resolution layer, deliberately never scattered as `if (workspaceId)` checks across route handlers — the same anti-pattern already visible in this codebase's five *existing*, un-unified ownership idioms (`docs/team-workspaces-architecture-audit.md` §4).

- `lib/workspaces/workspaceResolver.ts` — `resolveWorkspaceContext()` (pure, given already-fetched data) and `resolveWorkspaceContextForResource()` (the only function that performs the Firestore read, then delegates to the pure resolver).
- `lib/workspaces/workspaceAccess.ts` — `checkWorkspaceAccess()` (pure access verdict) and `authorizeWorkspaceResourceAccess()` (the single route-facing entry point: resolve, then check, collapsed into one outcome).

This mirrors an existing, established pattern in this codebase — `lib/governance/adaptiveRunAccess.ts`'s pure resolver taking already-fetched data, and `lib/adaptiveSchema/exportAuthorization.ts`'s pure-verdict-function-plus-async-wrapper split. `exportAuthorization.ts`'s own doc comments already forward-reference folding future capability logic into "the Workspace-era central capability model" — this is that foundation.

**No route calls either module in Phase 1.** They exist, are fully unit- and threat-tested, and are ready for Phase 3/4 to wire in.

## Workspace context — explicit, never nullable

```ts
type WorkspaceContext =
  | { mode: "legacy"; ownerUserId: string }
  | { mode: "workspace"; workspaceId: string; workspaceType: "personal"; ownerUserId: string };
```

A `WorkspaceContext` value only ever exists once resolution has *succeeded*. Resolution failure is a separate, exhaustive type:

```ts
type WorkspaceContextResolution =
  | { kind: "legacy"; context: ... }
  | { kind: "resolved"; context: ... }
  | { kind: "not_found" }
  | { kind: "malformed" }
  | { kind: "unsupported_workspace_type" }
  | { kind: "lookup_failed" };
```

## Error semantics — the critical invariant

```
workspaceId truly absent (undefined)   → legacy compatibility
workspaceId present in ANY other form  → explicit failure, never legacy
```

**"Present in any other form" is deliberately broad.** Only `undefined` — the key was never written to the document at all — counts as absent. `null`, `""`, a whitespace-only string, and a wrong-typed value (number/object/array, defensively, in case a caller bug ever produces one) are all treated as "a workspace reference was written, and it's unusable" — never folded back into "absent." A document holding `workspaceId: ""` is not the same as one that never had the field at all, and must not be treated as if it were.

Once `workspaceId` is anything other than `undefined`, resolution can only return `resolved` or a named failure kind. It can **never** return to `legacy`. This is enforced structurally, not just by convention: `resolveWorkspaceContext()`'s workspaceId-present branch has no code path back to a `legacy` result. Six distinct outcomes are always kept separate and never conflated:

| Outcome | Meaning |
|---|---|
| `legacy` | `workspaceId === undefined` — today's existing behavior, unchanged |
| `resolved` | workspaceId present, workspace found, well-formed, `type: "personal"` |
| `not_found` | workspaceId present, no such workspace document exists |
| `malformed` | workspace document exists but fails shape validation, its own `id` doesn't match the requested id, or the supplied `workspaceId` itself is structurally unusable (`null`/`""`/whitespace/wrong type) |
| `unsupported_workspace_type` | workspace is well-formed but `type: "team"` — real future data, not yet authorizable |
| `lookup_failed` | internal Firestore read failure (distinct from "not found") |
| `workspaces_disabled` | workspaceId present, but `WORKSPACES_ENABLED` is off — see Feature Flag Safety below |

`authorizeWorkspaceResourceAccess()` denies on every one of `not_found` / `malformed` / `unsupported_workspace_type` / `lookup_failed` / `workspaces_disabled` — **it never falls back to checking the legacy owner field once a workspaceId was present.** This is proven by the "legacy downgrade" and "flag-safety downgrade" test suites in `lib/workspaces/__tests__/workspaceAccess.spec.ts` and `workspaceResolver.spec.ts`: even when the calling `uid` genuinely equals the resource's `legacyOwnerUserId` (and is even the resource's real workspace owner), an invalid or flag-disabled workspace reference still denies.

## Authorization principles

- Workspace access is always server-derived, from the persisted `workspaces/{id}` document's own `ownerUserId` field — never from a client-supplied `workspaceId`, a UI-selected workspace, or a claimed membership.
- Phase 1's entire access model, for both `legacy` and `workspace` (personal) modes, is exact `uid === ownerUserId` string equality — no case-insensitivity, no prefix/substring matching, no whitespace trimming. Tested explicitly (`lib/workspaces/__tests__/workspaceAccess.spec.ts`).
- Workspace does not weaken existing authorization: for legacy records, current authorization behavior remains fully authoritative, unchanged, because no route calls any Phase 1 code yet.

## Feature flag

`WORKSPACES_ENABLED` (`lib/env.ts`), server-side only, `process.env.WORKSPACES_ENABLED === "true"` — same fail-closed convention as every other flag in this file (`ADAPTIVE_SCHEMAS_ENABLED`, `MULTI_REVIEWER_GOVERNANCE_ENABLED`, etc.). Default **off**.

### Feature flag safety — the resolver's single most important invariant

Earlier drafts of this design checked the flag *first*, before checking whether `workspaceId` was even present, and returned `legacy` unconditionally when the flag was off. **This was a latent security defect, caught and fixed during independent review before merge, and never shipped.** The failure mode it would have created: once a future phase writes a real `workspaceId` onto a resource (making it genuinely workspace-bound), disabling `WORKSPACES_ENABLED` — e.g. as an incident-response kill switch — would have silently re-derived access from the resource's `legacyOwnerUserId` field instead. If that field ever diverges from the workspace's true current authorization state (ownership transfer, team membership changes, a member removed from a workspace — none of which exist yet, but all of which are plausible by Phase 8), flipping the flag off would have been able to **grant** access inconsistent with the resource's real, current-state intent — the opposite of what a safety kill switch should ever do.

The corrected, shipped invariant:

```
workspaceId === undefined                          → flag is irrelevant; always legacy
workspaceId present (any form) + flag disabled      → workspaces_disabled (deny)
workspaceId present (any form) + flag enabled       → resolve for real (resolved/not_found/malformed/unsupported_workspace_type/lookup_failed)
```

`resolveWorkspaceContext()` checks `workspaceId` presence **before** the flag, not after. The flag can only ever **narrow** access for an already workspace-bound resource (deny via `workspaces_disabled`) — it can never widen it or redirect it back to a different authorization model. This mirrors an existing, established precedent already in this codebase: `MULTI_REVIEWER_GOVERNANCE_ENABLED`'s own doc comment (`lib/env.ts`) states its kill switch is checked "ONLY at panel creation/reconfiguration... NEVER checked by vote submission, finalization, owner override, or panel cancellation — an already-open panel must always remain completable or cancellable regardless of this flag's value, so no panel can ever become stranded." The same shape applies here: a flag may gate whether the system *begins* new workspace-aware behavior; it must never gate whether the system *honors* a binding that already exists.

Practical consequence for Phase 1 specifically: harmless either way today, since no production record has ever had `workspaceId` written to it. The fix matters entirely for phases 3+, and is deliberately settled now, before any real workspace-bound record can exist, per the explicit design principle: fixing a security-boundary decision is cheap before millions of records depend on it, and expensive after.

No public/client flag exists or is needed — Phase 1 has no client-facing behavior.

## Resource classification

Validated against the actual codebase (`docs/team-workspaces-architecture-audit.md` §2), not assumed from the hypothesis in the program brief.

| Resource | Where | Strategy | Notes |
|---|---|---|---|
| Adaptive/legacy research run (`runs/{runId}`) | `lib/firestore/runs.ts` | **A** — direct `workspaceId` eventually | Single scalar `userId` today; canonical ownership boundary |
| `governanceRecord` | embedded field on `runs/{runId}` | **B** — inherit from run | Not a separate document; a field |
| `humanReviewAssignment/current` | `runs/{runId}/humanReviewAssignment/current` | **B** — inherit from run | Subcollection of the run |
| `humanReviewHistory/{decisionId}` | `runs/{runId}/humanReviewHistory/*` | **B** — inherit from run | Immutable decision records, subcollection of the run |
| `humanReviewPanel` / `humanReviewVotes` | `runs/{runId}/humanReviewPanel/*`, `.../humanReviewVotes/*` | **B** — inherit from run | Same subcollection family |
| Export (`AdaptiveResearchExportV1`) | `runs/{runId}/exports/{exportId}` | **B** — inherit/freeze from run | Frozen snapshot; export invariants (provenance, historical regeneration) are explicitly protected — **not touched in Phase 1** |
| Claim Verification (`verifications/{id}`) | `lib/firestore/verifications.ts` | **D** — deferred, audited separately | Same single-`userId`-owner shape as runs architecturally, but `lib/verification/` and `app/api/verify-claim/` are explicitly protected systems this program forbids touching; workspace-awareness needs its own dedicated pass later, not folded into Phase 1 |
| Video Verification (`videoVerifications/{id}`) | inline in `app/api/verify-video/route.ts` | **D** — deferred, audited separately | Same reasoning as Claim Verification; also has no dedicated `lib/firestore/*.ts` helper today (writes are inline) |
| `teamRuns/{id}` (legacy `TeamRunDocument` + `AdaptiveTeamRunProjection`) | `lib/governance/teamTypes.ts`, `lib/governance/adaptiveTeamReview.ts` | **C** — legacy subsystem; do not repurpose | A projection/queue, not canonical ownership; two ID schemes coexist in one collection today. Explicitly not reinterpreted as workspace storage |
| `teams/{teamId}` governance system | `lib/governance/teamTypes.ts` | **C** — outside Workspace | Narrow, review-only purpose; one-team-per-user hard constraint; relationship to Workspace is an open question for a *future* phase, not decided here |
| `governanceReviewerUid`/`governanceReviewerFor` peer-review | `lib/governance/reviewerFields.ts` | **C** — outside Workspace | A second, separate one-to-one sharing mechanism, untouched |
| User panel/verification history (aggregated view) | `app/api/user/panel-history/route.ts` | **B** — derived, inherits from underlying A/D resources | No separate document; a query view |
| Admin audit records (`admin_audit_logs`) | — | **C** — outside Workspace | Operational/admin infrastructure, not user-facing |
| Billing/usage (`users/{uid}.runsThisMonth`, Stripe fields) | `lib/stripe/usageCheck.ts` | **C** — outside Workspace, deliberately | Program brief explicitly forbids introducing billing ownership in Phase 1; "who pays" stays per-individual-uid until a future phase makes an explicit pooled-billing decision |
| The `workspaces/{id}` collection itself | `lib/firestore/workspaces.ts` | *(not classified — this is the Workspace domain root, not a workspace-aware resource)* | New in Phase 1; read-only |

**A** = should eventually own `workspaceId` directly. **B** = should inherit workspace through its parent resource (never denormalize `workspaceId` onto child docs without a proven query/authorization need — none exists yet for any B-classified resource). **C** = must remain outside Workspace. **D** = protected system; deferred to a dedicated future audit, not "architecturally unclear."

No resource's `userId`/`ownerUid` field is removed, renamed, or reinterpreted by Phase 1. No `userId → workspaceId` migration exists or is permitted in this phase.

### Export inheritance — resolved decision, not an open question

Exports must **freeze `workspaceId` at export creation time**, exactly like `AdaptiveResearchExportV1` already freezes `governanceStatusAtExport` and generator/provenance identity. This isn't a new design question — it's a direct application of the export system's own existing, already-established philosophy: an export is a point-in-time, immutable snapshot, and it must never re-derive authorization-relevant facts dynamically from the live parent run at render/regeneration time (the entire reason `governanceStatusAtExport` exists is to prevent exactly that class of drift). Dynamically inheriting workspace authorization from the live run would let a workspace transfer *after* export creation silently change who could access an already-generated document — inconsistent with every other frozen field the export already carries. **Decided now; not implemented — exports are untouched in Phase 1 and remain so until whichever future phase adds export/workspace integration.**

### History inheritance — no new design question

`humanReviewHistory` is a genuine Firestore subcollection of its run (`runs/{runId}/humanReviewHistory/*`), always queried in the context of an already-known, already-authorized `runId` — never queried standalone across all users by `workspaceId`. Inheriting authorization from the parent run costs nothing extra (one resolution already happened to reach the run). The one place an aggregate, cross-run history view exists (`app/api/user/panel-history/route.ts`, querying `runs`/`verifications`/`videoVerifications` by `userId`) is already covered by those resources' own **A** classification: if a future phase needs `.where("workspaceId","==", ...)` instead of `.where("userId","==", ...)`, that's the same direct-`workspaceId`-on-the-parent-resource need already documented above, not a new inheritance problem for history specifically.

### Governance inheritance — mostly resolved, one flagged open question

`governanceRecord`, `humanReviewAssignment/current`, `humanReviewPanel`, and `humanReviewVotes` are all reached only after the parent run's own access has already been resolved (a user views governance for one specific run they're already authorized to view) — inheriting through the run is safe and costs no extra query.

**One genuine open question, not resolved here:** `firestore.indexes.json` already has a `collectionGroup: "humanReviewAssignment"` index keyed on `(assignedReviewerUserId, teamId, assignedAt)` — the query behind the personal-reviewer inbox ("show me everything assigned to me across all runs"). If a future phase wants to scope that to "show me everything assigned to me *within workspace X*," the assignment subcollection docs would need their own denormalized `workspaceId` — an explicit, narrow exception to the general "inherit from run, never denormalize" rule for **B**-classified resources, needed only because this one query already crosses run boundaries by design. **Flagged as an explicit Phase-4 design question. Not decided, not implemented, here.**

## Personal Workspace identity strategy — decided in Phase 1, implemented in Phase 2

Phase 1 states each user may eventually have one Personal Workspace, but a naive `workspaces/{randomId}` + `ownerUserId` shape does not, by itself, enforce "exactly one." This was a load-bearing decision for Phase 2's provisioning design, made during Phase 1's review — while it was cheap — rather than after real records existed. Phase 2 implements exactly this decision, unchanged:

**Decision: deterministic Personal Workspace document IDs, of the form `personal-{uid}`.**

Provisioning (Phase 2, not implemented here) creates via `.collection("workspaces").doc(\`personal-${uid}\`).create({...})` — Firestore's `.create()` (used elsewhere in this codebase, e.g. `createAdaptiveHumanReviewHistory`) fails with `ALREADY_EXISTS` on a second attempt at the same doc id, which gives idempotent, race-safe, exactly-once provisioning **for free**, with no transaction, no pre-check query, and no separate uniqueness index needed. A concurrent double-provisioning attempt (e.g. two simultaneous requests during signup) resolves itself: exactly one `.create()` succeeds, the other observes `ALREADY_EXISTS` and simply reads the existing doc instead.

This also means **no `users/{uid}.personalWorkspaceId` mapping field is needed** — a user's Personal Workspace id is always mechanically derivable from their uid alone (`personal-${uid}`), never a second, separately-maintained pointer that could drift from the truth. This is a deliberate rejection of exactly the failure pattern `docs/team-workspaces-architecture-audit.md` already identified as this codebase's own recurring smell: `teams/{teamId}` + `users/{uid}.teamId` and `governanceReviewerUid`/`governanceReviewerFor` are both two-sided relationships that can (and, per that audit, already do) drift out of sync with each other. A deterministic id sidesteps that entire class of bug for Personal Workspaces specifically.

Considered and rejected: random workspace IDs + a `.where("ownerUserId","==",uid).where("type","==","personal")` existence query before creation. Rejected because that query is not race-safe against concurrent provisioning without wrapping it in a transaction, and even transactionally, it is strictly more complex than `.create()`'s built-in exactly-once guarantee for no benefit — Personal Workspaces have no legitimate reason to ever be enumerated by anything other than direct uid-derived lookup.

Enumeration/privacy: not a practical concern given the existing Firestore rules posture (see Firestore Rules below) — `workspaces/*` is already unreadable by any client SDK regardless of whether ids are predictable, and the id never appears in any URL (see Domain model / No user-visible change).

**This decision governs Phase 2's implementation; Phase 1 implements no provisioning. `WorkspaceV1`'s shape and `getWorkspace()`'s behavior are already id-scheme-agnostic and require no change for this decision to take effect later.**

## Phase 2 — Personal Workspace Provisioning

### Architecture

```
getPersonalWorkspaceId(uid)              lib/workspaces/personalWorkspaceId.ts
  -> createPersonalWorkspace(uid)        lib/firestore/workspaces.ts (Firestore .create() primitive)
  -> getWorkspace(id)                    lib/firestore/workspaces.ts (Phase 1, reused as-is)
    -> ensurePersonalWorkspace(uid)      lib/workspaces/ensurePersonalWorkspace.ts (the service — all business logic lives here)
      -> POST /api/user/workspace        app/api/user/workspace/route.ts (the only caller)
```

`getPersonalWorkspaceId(uid)` is the single canonical id-construction function — no route or module builds the `personal-{uid}` string itself. It validates `uid` before constructing anything: rejects non-string, empty/whitespace-only, incidental leading/trailing whitespace, values containing `/`, the reserved `.`/`..` segments, and anything that would exceed Firestore's document-id byte limit. A uid this guard rejects can never have come from a genuinely verified Firebase Auth token — this is defense in depth, not an expected runtime path.

### Exactly-one guarantee

Deterministic id (`personal-{uid}`) + Firestore `.create()` — never query-then-create. `createPersonalWorkspace()` calls `.collection("workspaces").doc(id).create(workspace)`, exactly the `ALREADY_EXISTS`-is-idempotent-success pattern already established by `createAdaptiveHumanReviewHistory()`/`createAdaptiveHumanReviewAssignmentHistory()` (`lib/firestore/runs.ts`) — never `.set()`, which would silently overwrite. Firestore's own atomicity for `.create()` at a fixed document id is the entire uniqueness mechanism; no transaction, no pre-check query, no lock.

### ALREADY_EXISTS / conflict handling — fail closed, never repair

When `.create()` throws `ALREADY_EXISTS`, `ensurePersonalWorkspace()` reads the existing document back via `getWorkspace()` (Phase 1's function, reused unmodified) and validates it strictly before treating provisioning as successful:

| Existing document state | Result | Existing document mutated? |
|---|---|---|
| Valid: `id` matches, `schemaVersion: 1`, `type: "personal"`, `ownerUserId === uid` | `{status: "existing", workspace}` — success | No |
| `ownerUserId` is a different uid | `{status: "conflict", reason: "wrong_owner"}` | No |
| `type` is `"team"` | `{status: "conflict", reason: "wrong_type"}` | No |
| Structurally malformed, embedded `id` mismatched, or unsupported `schemaVersion` | `{status: "conflict", reason: "malformed"}` | No |

The three "malformed" sub-cases collapse into one reason deliberately: `getWorkspace()`'s own `isWellFormedWorkspaceV1()` guard and document-id-match check (both Phase 1, unmodified) already collapse them into a single `malformed` lookup status — Phase 2 does not invent a finer split the data layer has no way to actually distinguish. Each underlying cause is still individually tested (`lib/workspaces/__tests__/ensurePersonalWorkspace.spec.ts`).

**No conflict case ever overwrites, repairs, or deletes the existing document.** Repair tooling, if ever needed, is an explicitly separate, controlled workflow — not something provisioning does as a side effect.

### Idempotency

Sequential calls to `ensurePersonalWorkspace(uid)` — 1st, 2nd, 3rd, ... — always converge on exactly one Firestore document: the first call creates it; every subsequent call observes `ALREADY_EXISTS`, reads it back, validates it, and returns the identical `WorkspaceV1` (same id, owner, `createdAt`, `updatedAt`). No `.set()` or `.update()` call exists anywhere in the provisioning path (confirmed both by test and by direct source inspection — `createPersonalWorkspace` and `ensurePersonalWorkspace` between them contain exactly one Firestore write call, the initial `.create()`). Provisioning never rewrites the document merely because it already exists.

### Concurrency

Tested: 10 simultaneous `ensurePersonalWorkspace(uid)` calls for the same uid, dispatched via a single `Promise.all`, against a realistic in-memory Firestore mock that reproduces `.create()`'s real atomicity contract (synchronous check-and-set at a fixed document id — never yielded mid-check, exactly matching what real Firestore's server-side atomicity guarantees). Result: exactly 1 `created`, 9 `existing`, 0 failures, exactly 1 document, and — critically — every one of the 10 callers, winner and losers alike, observes byte-for-byte the same `WorkspaceV1`. A separate cross-user test dispatches 5 concurrent calls for user A interleaved with 5 for user B: exactly 2 documents, `personal-{A}` and `personal-{B}`, zero ownership crossover.

**Disclosed limitation, not overstated:** this repository has no Firestore emulator or `@firebase/rules-unit-testing` infrastructure (confirmed: no `emulators` block in `firebase.json`, no such dependency in `package.json` — the same finding Phase 1's review already made for rules testing). The concurrency tests above are a realistic, stateful, single-process mock exercising genuine `Promise.all` interleaving with an artificial delay on the read path only (never on the atomic create-check-set itself, which would misrepresent what real Firestore actually guarantees) — not a distributed-system test. It validates that `ensurePersonalWorkspace()`'s own logic correctly handles the two real outcomes real Firestore's atomicity produces (`.create()` succeeds / `.create()` throws `ALREADY_EXISTS`); it does not validate Firestore's server-side atomicity itself, which is Google's contract, not this codebase's to test.

### Timestamps

`createdAt`/`updatedAt` are both set to `Timestamp.now()` (`firebase-admin/firestore`) at creation time — matching the exact convention already used for creating a new top-level document elsewhere in this codebase (`TeamDocument.createdAt` in `app/api/teams/route.ts`). Both fields are set once, at creation, and never touched again by any idempotent re-provisioning call.

### Feature flag — separate from `WORKSPACES_ENABLED`, by design

`PERSONAL_WORKSPACE_PROVISIONING_ENABLED` (`lib/env.ts`), default OFF, same fail-closed convention. Deliberately a SECOND, independent flag from Phase 1's `WORKSPACES_ENABLED`:

- `WORKSPACES_ENABLED` is an **authorization/security-boundary** concern — does the resolver honor a persisted `workspaceId`?
- `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` is a **rollout** concern — is the system currently allowed to *create* new Personal Workspace documents?

They must be able to move independently. Most importantly: **disabling `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` only stops NEW workspace creation — it has zero effect on how the Phase 1 resolver treats an already-existing workspace document.** `resolveWorkspaceContext()`/`checkWorkspaceAccess()` never read `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` at all (confirmed: neither Phase 1 module imports `lib/env.ts`'s new export). The forbidden failure mode this design rules out: "provisioning flag off" being misread anywhere as "treat an existing workspace as legacy" — that would conflate a rollout switch with a security boundary, exactly the kind of confusion this two-flag split exists to prevent.

`ensurePersonalWorkspace()` checks its own flag first, before even validating `uid` — when off, zero Firestore reads or writes occur.

#### The four-combination matrix

Verified structurally, not just narratively: `ensurePersonalWorkspace.ts` never imports `WORKSPACES_ENABLED`, and `workspaceResolver.ts`/`workspaceAccess.ts` never import `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` (confirmed by grep — zero cross-references). The two flags govern completely disjoint code paths, which is what makes every combination below safe to reason about independently:

| `WORKSPACES_ENABLED` | `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` | Provisioning | Resolution of an existing `runs/{id}` (no `workspaceId` field, today's only real case) | Resolution of a hypothetical future workspace-bound resource |
|---|---|---|---|---|
| false | false | Disabled — no new workspace created | `legacy` (unaffected either way) | `workspaces_disabled` (deny) |
| false | **true** | **Active** — a real `workspaces/personal-{uid}` document CAN be created | `legacy` (unaffected — see below) | `workspaces_disabled` (deny) |
| true | false | Disabled — no new workspace created | `legacy` (unaffected either way) | resolves for real (`resolved`/`not_found`/`malformed`/etc.) |
| true | true | Active | `legacy` (unaffected either way) | resolves for real |

**Why `W=false, P=true` (the legitimate controlled-dark-provisioning state) is safe, not merely "not yet broken":** provisioning a Personal Workspace changes nothing about any existing resource, because `ensurePersonalWorkspace()` writes to exactly one place — `workspaces/{id}` — and nowhere else (verified structurally: no import path to `runs`/governance/export/history writes). A resource's resolution outcome depends entirely on its OWN `workspaceId` field, never on "does a workspace happen to exist for this owner." Since Phase 2 writes `workspaceId` onto zero existing resources, creating a workspace under `W=false` cannot make anything "immediately unusable" — there is nothing yet that references the new workspace for `W` to gate access to. The workspace document sits inert until a future phase (3+) deliberately binds a resource to it — at which point, if `W` is still false at that time, that specific bound resource fails closed (`workspaces_disabled`, a deny) exactly as designed, never a security downgrade. **Provisioning a workspace never automatically authorizes any existing run through it** — there is no code path from "workspace exists" to "run X is now workspace-governed."

### Not wired into any automatic flow

`POST /api/user/workspace` is a real, callable, fully-tested authenticated route — and, in this PR, its only caller. It is not invoked by login, signup, session refresh, auth middleware, the homepage, the research route, or the history route. Provisioning remains explicitly-callable-only until a later phase deliberately wires it in and re-validates that decision on its own merits.

### Authorization

Self-provisioning only. The route derives `uid` exclusively from `resolveRequestIdentity()` (the same hardened, shared resolver every other `/api/user/**` route uses) and passes only that string to `ensurePersonalWorkspace()` — the request body is never parsed at all, so a client-supplied `uid`, `ownerUserId`, `workspaceId`, `type`, or `schemaVersion` field has no code path to reach anywhere. Unauthenticated requests 401 before `ensurePersonalWorkspace` is ever called (tested).

### Privacy

The `WorkspaceV1` document contains exactly: `schemaVersion`, `id`, `type: "personal"`, `name: "Personal Workspace"` (a fixed, non-personalized default — provisioning requires no display name, no email-derived name, and works identically for an account with an incomplete profile), `ownerUserId` (the uid, already the same identifier every other owned resource in this codebase uses), `createdAt`, `updatedAt`. No email, phone, Firebase Auth metadata, billing/subscription data, token usage, profile bio, or reviewer configuration is ever written. `ensurePersonalWorkspace()` requires no read of `users/{uid}` at all — provisioning works even if that document is missing or incomplete.

### No user-profile or run mutation

Provisioning creates exactly one document, at `workspaces/{personal-{uid}}`. Nothing in `lib/workspaces/ensurePersonalWorkspace.ts`, `lib/firestore/workspaces.ts`'s new function, or `app/api/user/workspace/route.ts` imports from `lib/firestore/runs.ts` or any governance/export/verification module (asserted by a structural test that greps the actual source, not merely inferred). No `users/{uid}.personalWorkspaceId` field is written — deterministic ids make that mapping unnecessary, avoiding the two-sided-reference drift risk documented above. No existing `runs`/`verifications`/`videoVerifications`/export/governance/history document gains a `workspaceId` field as a result of provisioning, ever.

### The provisioned-but-unbound state (expected, tested)

After Phase 2, this is a valid, expected state:

```
User
├── Personal Workspace exists (workspaces/personal-{uid})
└── Every existing run still has no workspaceId field at all
```

Workspace *existence* does not automatically change any existing resource's authorization. A user's old runs remain governed entirely by the Phase 1 legacy path (`workspaceId === undefined -> legacy compatibility`) regardless of whether that user has a Personal Workspace — proven end-to-end, not just asserted, by `lib/workspaces/__tests__/provisionedButUnbound.spec.ts`: provision a real workspace for a uid, then resolve a workspace context for a record with no `workspaceId` and that same uid as `legacyOwnerUserId` — the resolution is `legacy`, unaffected. Binding existing runs to a workspace is explicitly out of scope until a later, separately authorized and tested phase.

### Security review questions — answered

1. **Can User A cause User B's Personal Workspace to be created?** No. `ensurePersonalWorkspace(uid)` only ever operates on the uid it's given, and the only caller (`POST /api/user/workspace`) derives that uid exclusively from the authenticated identity — never from any request parameter.
2. **Can User A control `ownerUserId`?** No. `createPersonalWorkspace()` sets `ownerUserId: uid` server-side from its own parameter; nothing reads a request body for this field.
3. **Can a duplicate Personal Workspace exist for one uid?** No. The deterministic id + `.create()` guarantee makes a second document at the same id impossible; a duplicate would require a different id entirely, which nothing in this codebase constructs for a Personal Workspace.
4. **Can concurrency create two?** No — proven by the 10-way concurrency test: exactly one document, regardless of how many simultaneous calls are made.
5. **Can an existing conflicting document be overwritten?** No. Every conflict path (`wrong_owner`, `wrong_type`, `malformed`) returns a `conflict` result and leaves the existing document byte-for-byte untouched (tested).
6. **Can provisioning mutate existing runs?** No — structurally impossible; the provisioning module has no import path to any run/history/export/governance write function (tested).
7. **Can disabling provisioning weaken access to an existing workspace?** No. `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` is read only by `ensurePersonalWorkspace()`; the Phase 1 resolver/access modules never read it and are entirely unaffected by its value.
8. **Can malformed existing data be silently repaired?** No. Every malformed/mismatched conflict case fails closed with `{status: "conflict", reason: "malformed"}` and leaves the document exactly as found. Repair is explicitly out of scope for this phase.

## Future Project relationship

```
Workspace
  └── Project
        └── Run
```

Phase 1 does not create a Project model. It only ensures the Workspace architecture can accept `projectId?: string` later without a redesign — the same optional-additive-field discipline `workspaceId` itself follows. No `projectId` is added to any production record in this phase.

## Protected systems — confirmed untouched

- `lib/verification/`, `app/api/verify-claim/` — unchanged.
- `lib/video/`, `app/api/verify-video/` — unchanged.
- `lib/verificationGate/` — unchanged.
- Governance canonical state (`governanceRecord.humanReview`, assignment/history/panel/votes, terminal immutability, optimistic concurrency, owner override, quorum, aggregation, cancellation) — unchanged; Phase 1 adds no governance mutation logic.
- `teamRuns.humanDecision` narrow legacy-authority exception — unchanged; not reinterpreted as workspace storage.
- `AdaptiveResearchExportV1` semantics, `generatedBy` provenance, frozen snapshots, historical regeneration, PDF/DOCX/JSON behavior, export authorization — unchanged.
- No existing URL or route changes. No workspace IDs appear in any URL.

## Firestore rules — no change

`firestore.rules` already ends in a default-deny catch-all (`match /{document=**} { allow read, write: if false; }`); only `users/{uid}` and `appConfig/modelKeys` have explicit allow rules. **All Phase 1 Firestore access (`getWorkspace()`) goes through the Admin SDK** (`lib/firebase/admin.ts`), which always bypasses Security Rules — rules only govern client-SDK access, and no client-SDK code path to `workspaces/*` exists anywhere in this codebase. The pre-existing catch-all already denies any hypothetical direct client read/write to `workspaces/*`. Adding a redundant explicit rule block would only introduce a chance to mis-write a rule; the safer, minimal Phase 1 choice is no change at all. When a future phase introduces genuine client-SDK access to workspace data (unlikely, given every other collection follows the same Admin-SDK-only pattern), an explicit owner-scoped rule should be added then, not speculatively now.

## Firestore indexes — no change

Phase 1's only Firestore operation is a direct `workspaces/{id}` document `.get()` by id — a direct-doc-get never requires a composite index. No query (`.where()`, `.orderBy()`) exists yet against the `workspaces` collection. Future needs to note for later phases, not built now: a `workspaces` query by `ownerUserId` (Phase 2, "list my workspaces" / provisioning lookup) and, if any A-classified resource is denormalized with `workspaceId`, a `(workspaceId, createdAt)`-shaped composite index mirroring the existing `(userId, createdAt)` index already on `runs`/`verifications`/`videoVerifications`.

## Migration strategy boundaries

- No `userId → workspaceId` migration in Phase 1 (or, per the program, in Phase 1 at all — full stop).
- No backfill of any kind executed.
- No Personal Workspace documents provisioned for any user.
- No `projectId` added to any record.

## Rollback

**Phase 1:** introduced no migration and had no route depending on it. Code rollback was sufficient; no data rollback was required. Reverting removes `lib/workspaces/*`, `lib/firestore/workspaces.ts`, and `WORKSPACES_ENABLED` from the running build; nothing wrote a `workspaces/{id}` document or a `workspaceId` field in production, so nothing in the database depended on this code existing.

**Phase 2, before any production provisioning is executed (this PR's state):** identical — code rollback is sufficient. No production Personal Workspace has been created; `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` is off in production and this PR does not flip it. Reverting removes the provisioning code path entirely with nothing left behind.

**Phase 2, after the controlled canary described below (Stage B–D) creates exactly one test Personal Workspace:** two rollback classes exist —
1. *Code rollback* — always sufficient; reverting the deployment stops any further provisioning immediately.
2. *Single test-Workspace cleanup* — safe to delete ONLY because, during Phase 2, no run/export/governance/history record can be bound to any workspace (that capability doesn't exist until Phase 3+). Deleting a Phase-2-era test `workspaces/{id}` document therefore orphans nothing. **This safety property stops being true the moment a later phase starts binding real resources to a workspace** — from that point on, deleting a Workspace document requires the migration analysis those phases must define; Phase 2 deliberately never reaches that state.

## Runtime validation policy

TypeScript types describe intent; they do not validate what Firestore actually returns. `isWellFormedWorkspaceV1()` (`lib/workspaces/types.ts`) is the runtime guard `getWorkspace()` calls on every document before it can ever be treated as "found" — a raw `data() as WorkspaceV1` cast never happens anywhere in this codebase's Workspace code. Its policy, deliberately decided rather than left implicit:

- **Strictly validated** (authorization-relevant): `schemaVersion` (must be the literal `1`), `id` (non-empty string, and — enforced separately, in `getWorkspace()` itself, at the point of read — must equal the actual Firestore document id it was fetched at, never left for callers to re-check), `type` (must be a recognized value), `ownerUserId` (non-empty string — this field alone is Phase 1's entire access model).
- **Type-checked only, not further constrained**: `name` (a display field; emptiness is not a security concern).
- **Not validated at all**: `createdAt`/`updatedAt`. Neither is ever read by the resolver or the access check, so a malformed timestamp cannot produce an authorization bug.
- **Unknown/extra fields are accepted**, not rejected — an open, forward-compatible schema matching this codebase's own `TeamDocument` additive-optional-field convention.

All of the above is asserted directly by tests, not merely described here (`lib/workspaces/__tests__/types.spec.ts`, `lib/firestore/__tests__/workspaces.spec.ts`).

## Security invariants — summary

1. **Workspace IDOR** (User A supplies User B's real workspace id) — denied. Tested.
2. **Cross-workspace access** (genuine owner of Workspace A requests a resource bound to Workspace B) — denied. Tested.
3. **Legacy downgrade** (invalid/missing/malformed workspace reference) — never falls back to legacy owner check, even when the calling uid genuinely equals the legacy owner field. Tested for `not_found`, `malformed`, `lookup_failed`, and `unsupported_workspace_type`.
4. **Flag-safety downgrade** (workspaceId present + `WORKSPACES_ENABLED` disabled) — denies (`workspaces_disabled`), never falls back to legacy owner check, even when the calling uid is genuinely both the legacy owner AND the real workspace owner. See Feature Flag Safety above. Tested.
5. **Forged/claimed ownership** — access is computed purely from the server-resolved `WorkspaceContext.ownerUserId`, never from any client-supplied claim. Tested.
6. **Uid comparison is exact** — no case-insensitivity, prefix, substring, or whitespace-tolerant matching. Tested.
7. **No implicit creation (Phase 1)** — as of Phase 1, no function in `lib/firestore/workspaces.ts` or `lib/workspaces/*` wrote anything. Phase 2 adds exactly one narrow, semantic write (`createPersonalWorkspace`, called only via `ensurePersonalWorkspace`) — see item 8.
8. **No implicit/automatic creation (Phase 2)** — `ensurePersonalWorkspace()` is never called except by `POST /api/user/workspace`, which is never called except by an explicit, authenticated client request. Nothing in login, signup, session refresh, middleware, or any existing route invokes it (verified by diff — no existing file outside the new provisioning files was touched). No Personal Workspace has been created automatically for any user. Provisioning-side guarantees (idempotency, concurrency safety, conflict fail-closed behavior, no run/user-profile mutation) are all tested — see "Phase 2 — Personal Workspace Provisioning" above.

## Rollout phases

Phase 1 (COMPLETE, in production) → Phase 2 (COMPLETE, in production — provisions Personal Workspaces one-at-a-time on self-service demand only) → Phase 2B (COMPLETE, in production — bulk-provisioned Personal Workspaces for the full existing user population; explicitly NOT run backfill) → **Phase 3 (this document's latest section) makes writes workspace-aware for newly created Personal adaptive runs only — explicitly NOT historical backfill, NOT broad reads** → Phase 4 makes reads/history workspace-aware and backfills historical runs → Phase 5 ships Workspace UI → Phase 6 introduces Projects → Phase 7 ships Projects UI → Phase 8 adds shared/collaborative workspaces.

The Phase 2B → Phase 3 ordering was a deliberate strategic choice: existing users were made Workspace-ready (provisioned) before any run gained workspace-aware writes. This kept Phase 3 simple — new-run creation never needs to provision a Workspace and create a run in the same hot-path operation, because by the time Phase 3 starts, provisioning coverage is already at 100% for the population that existed at the Phase 2B sweep (88/88 users, `missing: 0`, `conflicts: 0`, verified immediately before Phase 3 began).

Phase 1, Phase 2, Phase 2B, and Phase 3 are each independently releasable and reversible without any dependency on a later phase ever shipping.

## Phase 3 — Workspace-Aware Writes for New Personal Adaptive Runs

Phase 3 adds exactly one capability: newly created Personal (non-team) **adaptive** research runs are persisted with an optional `workspaceId` field pointing at the owner's already-existing Personal Workspace. Nothing about existing runs, team runs, Deep Research (non-adaptive) runs, Claim Verification, Video Verification, the Verification Gate, export contracts, or governance canonical semantics changes. No historical run is ever mutated. No Workspace UI or Project concept is introduced.

This section was hardened once after an independent review found three defects in the first implementation (model execution still proceeding after a Workspace prerequisite failure, a fire-and-forget new-user provisioning race, and Workspace binding leaking onto non-adaptive Deep Research runs) plus a fourth requested hardening (an invalid `W`/`RW` configuration silently downgrading to a legacy write instead of rejecting). All four are described as **resolved** below; the surrounding narrative reflects the current, hardened state — see PR history for the pre-hardening design if needed for context.

### Write-site audit

There is exactly **one** route capable of creating a `runs/{runId}` document — `POST /api/run-panel` (`app/api/run-panel/route.ts`), shared by both the Deep Research (multi-LLM) flow and the schema-classified adaptive flow. No retry/recovery/restore/import endpoint creates a run. The run document's ownership field is `userId` only — there is no `ownerUserId` field on `runs/{runId}`, and no personal-vs-team field on the document itself; "team run" is decided per-request, downstream, purely by whether `loadUserAndTeam(uid)` finds a team, via a separate `teamRuns/{...}` projection document, never a different shape of the run doc itself.

`createRun()` (`lib/firestore/runs.ts`) performs a single, non-transactional `.set()` — `governanceRecord` (a field, not a subcollection) and `humanReviewAssignment` (a real subcollection) are both written by separate, later calls, further downstream. `uid` is resolved (`resolveRequestIdentity()`) at the very top of the route.

### Actual request ordering (hardened)

1. Authenticate (`resolveRequestIdentity`)
2. Rate limiting, request body parsing/validation
3. Adaptive classification (`planAdaptiveRun`, flag-gated by `ADAPTIVE_SCHEMAS_ENABLED`, never blocks — a classification failure degrades `adaptivePlan` to `null`, handled identically to adaptive being disabled)
4. Query-routing guard — a non-`"active"` routing outcome returns early, before any run doc and before the Workspace prerequisite check
5. **Workspace prerequisite check** (new position, moved up during hardening — see below)
6. Subscription validation (best-effort, unaffected by Phase 3)
7. Plan-quota/run-count usage increment (unaffected by Phase 3 either way — this is pre-existing ordering, out of this phase's scope, and happens regardless of Workspace outcome)
8. `createRun()` — the single initial write, using the `workspaceId` already resolved at step 5
9. `runPanel()` — real model execution
10. (Adaptive-only, further downstream) adaptive output persistence, governance initialization, automated governance evaluation, a second, independent `loadUserAndTeam(uid)` call for team/personal review routing (team projection vs. personal reviewer assignment — pre-existing, unrelated to Workspace binding)

### Workspace binding logic

`lib/workspaces/personalRunWorkspaceBinding.ts`'s `resolvePersonalRunWorkspaceBinding()` is the single resolution function, reusing `getPersonalWorkspaceId()` (Phase 2) and `getWorkspace()` (Phase 1) verbatim — no reimplemented id-construction, schema validation, or conflict logic. **It never calls `ensurePersonalWorkspace()`** — a missing Workspace is a `resolution_failed` outcome, never a trigger to create one; enforced structurally (a dedicated test asserts the module never imports it). Team status (`hasTeam`) is supplied by the caller via the same canonical `loadUserAndTeam(uid)` already used elsewhere in this route for team-vs-personal routing.

Outcomes: `flag_off` (writes disabled) / `invalid_configuration` (see Flag matrix below) / `team_user` (not applicable, not a failure) / `bound` (validated: `type === "personal"`, `ownerUserId === uid`, deterministic id matches) / `resolution_failed` with reason `invalid_uid | not_found | malformed | wrong_owner | wrong_type | lookup_failed`. The client-supplied request body is never consulted for any of this — `POST /api/run-panel` only ever destructures `{question, selectedModels}` from the body; a malicious `workspaceId`/`userId`/`ownerUserId` in the request is structurally never read, let alone trusted (tested explicitly).

### Adaptive-only scope (hardened)

The independent review found the first implementation attempted Workspace binding for **every** Personal run through this route, including plain Deep Research — because the check originally sat right next to `createRun()`, a call site shared unconditionally by both request types. Fixed by gating the entire prerequisite-check block (team lookup, Workspace resolution, everything) on `adaptivePlan !== null`, evaluated at its new position (step 5 above) — the exact signal the routing guard (step 4) has already confirmed means "a genuine, actively-routed adaptive request." For a non-adaptive Deep Research request, `resolvePersonalRunWorkspaceBinding()` — and therefore `loadUserAndTeam()`, `getPersonalWorkspaceId()`, and `getWorkspace()` — is never called at all (tested explicitly: zero calls, model execution still proceeds normally under existing Deep Research semantics, `workspaceId` is absent on the created run).

### No patch-after-create; ownership consistency

`createRun()`'s signature gained one optional trailing parameter, `workspaceId`, included in the SAME initial `.set()` call — never a later `.update()`. A run is either workspace-bound from the moment it exists, or not at all; there is no intermediate, ambiguous-ownership state. `userId` is always set to the authenticated `uid`, and `workspaceId` (when bound) is always the deterministic id whose `ownerUserId` was independently validated to equal that same `uid` — so `run.userId === workspace.ownerUserId === authenticated uid` holds by construction.

### Workspace prerequisite failure: fails before model execution and before usage consumption (hardened)

The independent review found the first implementation's `resolution_failed` handling reused the pre-existing "run creation is for tracking, not critical for execution" degradation path — which let `runPanel()` (real model execution) and downstream token-usage accounting proceed anyway, spending resources on a request already known to be unable to satisfy the Phase 3 write contract. This is a genuinely different failure class from "research succeeded but the tracking record failed to save," and is now handled distinctly:

The Workspace prerequisite check (step 5) now runs **before** subscription validation, **before** `checkAndIncrementUsageForRun` (plan-quota/run-count), and **before** `runPanel()`. On `resolution_failed` or `invalid_configuration`, the route returns an HTTP error response **immediately** — no `createRun()`, no model/provider calls, no token-usage increment, no governance/review-assignment/team-projection creation. This is tested explicitly for every one of the six `resolution_failed` reasons plus `invalid_configuration`, asserting zero calls to `runPanel`, `createRun`, and `incrementUserTokenUsage` in each case.

Response contract, sanitized (never leaks an owner uid, a Firestore path, or a raw Firebase error):

| Outcome | `errorCode` | Sanitized reason | HTTP status |
|---|---|---|---|
| `resolution_failed: not_found` | `workspace_prerequisite_failed` | `workspace_missing` | 409 |
| `resolution_failed: malformed / wrong_owner / wrong_type / invalid_uid` | `workspace_prerequisite_failed` | `workspace_invalid` | 409 |
| `resolution_failed: lookup_failed` | `workspace_prerequisite_failed` | `workspace_unavailable` (transient — retry-appropriate) | 503 |
| `invalid_configuration` | `workspace_configuration_invalid` | — | 500 |

Plan-quota/run-count consumption (`checkAndIncrementUsageForRun`) is a separate, pre-existing mechanism this phase does not otherwise touch; it happens after the Workspace check in the hardened ordering, so it is correctly never charged for a rejected request either.

### Configuration invariant: `RW=true` requires `W=true` — now rejects, never downgrades (hardened)

`lib/workspaces/personalRunWorkspaceWriteConfig.ts`'s `checkPersonalRunWorkspaceWriteConfiguration()` is the single place this is enforced. Rationale: `resolveWorkspaceContext()` (Phase 1) treats a present `workspaceId` with `WORKSPACES_ENABLED=false` as `workspaces_disabled` — a deny, never a legacy fallback. If writes were enabled while the resolver itself is disabled, a freshly created Workspace-bound run would be immediately inaccessible to its own owner.

The independent review found the first implementation's response to this invalid combination — silently creating a legacy (unbound) run — was safe from an *access* perspective but unsafe from a *rollout-integrity* perspective: an operator who enabled `RW=true` would have no visible signal that production was quietly still generating legacy records. Hardened: for an eligible (adaptive, personal) request, `RW=true` with `W=false` now **rejects the request** (`workspace_configuration_invalid`, HTTP 500) before any model execution or usage consumption — no run is created at all, bound or legacy — logged as `personal_run_workspace_configuration_invalid`.

Full flag matrix (`W` = `WORKSPACES_ENABLED`, `RW` = `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED`), all four combinations test-covered:

| W | RW | Result |
|---|----|--------|
| false | false | ok — writes off, no binding attempted (today's production default) |
| false | true | **rejected** for an eligible adaptive request — `workspace_configuration_invalid`, no run created, no legacy fallback |
| true | false | ok — writes off regardless of W |
| true | true | ok — the only combination that safely binds new runs |

### New-user provisioning: mechanical, not fire-and-forget (hardened)

The most important operational risk in this phase: the Phase 2B sweep provisioned the population that existed at that moment (88/88 users). Every user who signs up *afterward* would have no Personal Workspace, and `resolvePersonalRunWorkspaceBinding()` deliberately never auto-provisions one.

**Auth-entry-path audit**: this codebase has exactly two entry points that establish a new session — email/password signup and email/password login (`app/signup/page.tsx`, `app/login/page.tsx`); there is no OAuth/social/magic-link/SSO path, and no server-side/admin account-creation route. A third case — an already-authenticated session reaching the app via direct navigation, bypassing both pages entirely — is real and is **not** addressable client-side at all; it is covered exclusively by `/api/run-panel`'s own server-side prerequisite check (above), which is why that check is described as the final safety boundary regardless of what the client does.

The independent review found the first implementation's client-side trigger (`POST /api/user/workspace`, Phase 2's existing self-provisioning endpoint) was fire-and-forget (`setTimeout`, never awaited) — meaning "provisioning was attempted" and "provisioning is guaranteed complete before the user's first research request" were conflated; a user could reach the app and submit research before the background call finished. Hardened: both signup and login now **await** this call before proceeding (redirect / onboarding). Two outcomes proceed normally, unchanged from pre-hardening behavior: a real success (`created`/`existing`), and `provisioning_disabled` (503) — what this endpoint always returns today, since `PERSONAL_WORKSPACE_PROVISIONING_ENABLED` is off in production, so **flags-off signup/login behavior is unchanged** (one extra fast round trip; no Firestore write, no expensive lookup on the disabled path). Any other outcome (a genuine failure while the flag is on) blocks the redirect and surfaces a retryable error via the pages' existing `error` state — no new UI was added. The just-created Firebase Auth account/profile is never deleted or signed out on a provisioning failure (provisioning is idempotent — retry, don't restart); a signup failure's error message directs the user to sign in, which re-attempts provisioning via login's own hardened self-heal, reusing that path as the retry mechanism rather than building a separate one.

No new flag was introduced for this trigger — the endpoint it calls is already gated by `PERSONAL_WORKSPACE_PROVISIONING_ENABLED`. Turning that flag on in production remains a separate, not-yet-authorized rollout decision (see Stage B below), not something this phase enables by itself.

**`loadUserAndTeam(uid)` called twice, evaluated, left separate**: the route now calls this function once for the Phase 3 prerequisite check (step 5) and again, independently, at its original pre-existing location deep in adaptive-only review routing (step 10). Both reads reflect the same static, per-account property (`users/{uid}.teamId`), and nothing in this route writes to it — so redundancy carries no correctness risk. Consolidating into a single call was evaluated and deliberately **not** done: it isn't required for correctness, and touching more of this already highly complex route than the hardening strictly needs was judged the wrong tradeoff for this pass.

### Minimum read integration: **none required**

This is a deliberate, audited scope decision, not an oversight. Phase 3's own mandated design — retaining `userId` unchanged alongside the new optional `workspaceId` — is exactly what makes this safe: every existing read/access/export/reviewer/history route (`app/api/user/runs/[runId]/route.ts` and its siblings) authorizes purely via `data.userId === uid`, and none of them currently reads `data.workspaceId` at all. Adding the field is therefore entirely inert to every existing route — a workspace-bound run's true owner continues to be granted access through the same, completely unmodified code path as any legacy run (verified empirically: a dedicated test asserts byte-identical `viewerRole`/`ok`/`adaptive.output` for the same owner whether or not `workspaceId` is present).

Phase 1's `authorizeWorkspaceResourceAccess()` / `resolveWorkspaceContext()` remain fully built, fully tested, and **still unwired to any route** — reserved for a future phase that actually needs Workspace-*scoped* (not merely owner-equality) reasoning, such as shared/team Workspaces or Workspace-scoped listing (Phase 4+). Wiring them in now would be premature: there is no route today whose authorization behavior would differ from what the untouched `userId` check already provides.

The corollary "never security-downgrade a workspace-bound run" invariant (a Workspace lookup failure must never fall back to a legacy `userId` check) therefore has no live risk surface yet in Phase 3 either — no route reads `workspaceId` for authorization, so there is nothing to downgrade from. This invariant becomes load-bearing the moment a future phase starts consulting `workspaceId` for access decisions; it is documented here so that phase inherits the constraint rather than rediscovering it.

### Personal reviewer flow — unaffected

`resolveAdaptiveRunAccess()` / `lib/governance/adaptiveRunAccess.ts` is untouched (zero diff). Reviewer access is granted purely via the canonical per-run `humanReviewAssignment` document matching the requester's uid — it has no concept of `workspaceId` and needs none. Since no read route was modified, this composition question (documented during design as "owner-via-workspace OR reviewer-via-assignment, never letting a workspace-lookup failure re-open the legacy-owner branch as a bypass") did not need to be built in Phase 3 — it remains a documented design for whichever future phase first wires Workspace-based authorization into a read route.

### Team runs — unaffected

A team run's document is created via the exact same `createRun()` call as a personal run (there is no separate team creation path), but `resolvePersonalRunWorkspaceBinding()` returns `team_user` (not `bound`) whenever `loadUserAndTeam(uid)` finds a team — no `workspaceId` is ever attached, tested explicitly. Team access continues through its own, fully separate route tree and authorization function (`app/api/teams/adaptive-runs/[runId]/**`, `loadUserAndTeam` + `isTeamAdmin` + team-run projection) which was not touched and does not read `workspaceId` at all.

### Data isolation

No historical run is ever mutated — the only write site is `createRun()`, called exactly once per NEW run at a freshly generated `runId`; there is no code path in Phase 3 by which an existing `runs/{runId}` document could be touched. No `governanceRecord`/`humanReviewAssignment`/`humanReviewHistory`/panel/vote document gains a `workspaceId` — these continue to inherit Workspace context from their parent run only if a future phase's read/query needs require it, not speculatively now. No export contract (`AdaptiveResearchExportV1`, PDF/DOCX/JSON, frozen-snapshot semantics) changes. No `projectId` is introduced — a Workspace-bound run has no persisted Project association; conceptually "Workspace → Unfiled." Billing remains entirely user-based — no Workspace billing concept exists.

### Rollback: write kill-switch vs. read security are different levers

Before any Workspace-bound run exists, rollback is trivial: with both new flags off, this phase's code paths are entirely inert (zero behavior change), and no `--execute`-equivalent action has occurred. **Once real Workspace-bound production runs exist, `WORKSPACES_ENABLED` can no longer be casually disabled** — per Phase 1's own invariant, doing so would make every such run's `workspaceId` resolve to `workspaces_disabled` (a deny)... except Phase 3 wires zero read routes to check it (see above), so today, disabling `WORKSPACES_ENABLED` after Phase 3 runs exist has **no live effect on read access at all** (owner access still flows through the untouched `userId` check). This safe property is temporary — it holds only as long as no route reads `workspaceId` for authorization. The moment a future phase wires that in, this document's guidance changes to: disabling `WORKSPACES_ENABLED` after bound runs exist would make them inaccessible, so the correct kill switch at that point is `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED` alone (stops creating *new* bound runs; does not touch authorization of *existing* ones) — never a single flag that conflates write-rollback with access-security.

### Safe global-rollout predicate

Global `RW=true` enablement is safe only when **all** of the following hold — the Phase 2B 88/88 baseline alone is not sufficient by itself, since signup remains open and the population drifts the moment user 89 registers:

1. `W=true` (required by the configuration invariant above).
2. `P` (`PERSONAL_WORKSPACE_PROVISIONING_ENABLED`) `=true`, and has been for long enough that new signups are reliably covered.
3. The new-user provisioning lifecycle is mechanical (awaited, not fire-and-forget) — true as of this hardening pass.
4. `/api/run-panel` fails fast (before model execution, before usage consumption) on a missing/invalid Workspace — true as of this hardening pass.
5. Existing eligible population coverage remains complete (re-run the Phase 2B dry-run/coverage-audit tooling immediately before any global enablement to reconfirm, not assumed from a stale snapshot).

### Production rollout plan (Phase 3) — prepared, not executed

- **Stage A** — deploy with `P=false`, `W=false`, `RW=false` (default). Verify zero behavior change.
- **Stage B** — enable `P` only. Prove: existing login self-heal works for the 88/88 population (all resolve `existing`); a brand-new production signup receives a Workspace; the awaited provisioning call genuinely blocks app entry until it resolves (no race); a provisioning failure leaves the account in a retryable state rather than a broken one.
- **Stage C** — enable `W` while `RW` remains `false`. Prove no existing behavior changes (Phase 3 still creates zero Workspace-bound runs; this only makes the — still entirely unwired — Phase 1 resolver capable of honoring a `workspaceId` if one existed, which none do yet).
- **Stage D** — narrow canary: `RW=true` for one internal/test account only (mirroring Phase 2's own canary technique). Create one new adaptive Personal run; verify `workspaceId` persisted in the initial write, owner can immediately render/restore it (already true by construction — see "Minimum read integration" above), old legacy runs still work, reviewer behavior intact, export behavior intact if exercised, and a deliberately-broken-Workspace test account is correctly rejected before model execution.
- **Stage E** — broader `RW` rollout only after Stage D's controlled proof, and only once the safe global-rollout predicate above is fully satisfied.

This plan is prepared and documented only. No production Workspace-bound run has been created as part of this phase — every verification so far has been code review, unit/integration tests, and static analysis; all three flags (`P`, `W`, `RW`) remain `false`/absent in production.

## Phase 2 production rollout plan — prepared, not executed

No production provisioning has been executed as part of this PR. The controlled plan for after merge:

- **Stage A** — deploy with `PERSONAL_WORKSPACE_PROVISIONING_ENABLED=false`. Verify zero behavior change (identical to how Phase 1 shipped).
- **Stage B** — enable provisioning for a controlled internal test account only (or invoke `POST /api/user/workspace` directly, authenticated as that one account). Provision exactly one Personal Workspace. Verify: deterministic id, correct owner, correct schema, zero run mutation, zero UI change.
- **Stage C** — repeat provisioning for the same test user several times. Require: `existing` result every time, same document, no timestamp mutation.
- **Stage D** — concurrent controlled calls for the same test user. Require: one document.
- **Stage E** — stop. No bulk provisioning of production users. No run backfill. Both remain explicitly out of scope until a later, separately authorized rollout step with its own plan and its own review.

## Phase 2B — Controlled Existing-User Personal Workspace Provisioning

Phase 2B adds exactly one capability: a bulk CLI that provisions Personal Workspaces for the *existing* user population, ahead of Phase 3 making any run write workspace-aware. It reuses `ensurePersonalWorkspace()` verbatim — there is no reimplemented create, conflict, or deterministic-id logic anywhere in Phase 2B's own code. Nothing about run authorization, the Phase 1 resolver, or the `WORKSPACES_ENABLED` flag changes.

### Eligibility source: Firebase Auth, not `users/{uid}`

Firebase Auth (`adminAuth.listUsers()`) is the canonical population source, not the `users/{uid}` Firestore collection. This was verified against the actual repo, not assumed: signup is **not atomic** between the two — `app/signup/page.tsx` calls `createUserWithEmailAndPassword()` and then a separate `setDoc()` for the Firestore profile, so a user can hold a real Auth account with no Firestore profile at all (a crash, a network failure, or an abandoned tab between the two calls is enough). `app/login/page.tsx` self-heals the profile via a merge `setDoc` on next login, but that doesn't help a user who never logs in again. Firestore-only "ghost" profiles with no backing Auth account are structurally impossible to provision by this pipeline — they're just never enumerated, since `listUsersPage` is Auth-only. Workspace ownership is treated purely as an identity concept, not a subscription or profile-completeness concept — there is no dependency on `runsThisMonth`, plan state, or any other `users/{uid}` field anywhere in the eligibility path.

### Disabled-user policy

A disabled Firebase Auth user (`user.disabled === true`) is excluded from provisioning (`classifyUserEligibility()` in `lib/workspaces/provisioningEligibility.ts`). Disabled accounts cannot authenticate, so a Workspace document for one would be inert — provisioning it only adds noise to the coverage audit and a theoretical future-reactivation edge case that's better handled by re-running the bulk provisioner (idempotent, cheap) than by pre-provisioning speculatively.

### Service/test/canary account exclusion

There is no hardcoded exclusion list in the codebase. Exclusion is entirely operator-driven at invocation time, via repeatable `--exclude-uid=<uid>` CLI flags and/or a `--exclude-file=<path>` newline-delimited file (`#`-prefixed comment lines ignored, CRLF- and BOM-safe, matching `lib/workspaces/provisioningEligibility.ts`'s `parseExclusionList()`). This keeps the decision of "which accounts are service/test/canary accounts" a reviewable, per-run operator input rather than a silently-encoded assumption baked into shipped code.

An exclusion is a safety mechanism, so a malformed or unloadable exclusion must never fail open. Every parsed entry (from `--exclude-uid` or `--exclude-file`) is validated with `validateExclusionUids()` — reusing the exact same uid-shape validator (`getPersonalWorkspaceId()`) used everywhere else a uid becomes a Firestore document id, rather than inventing separate rules that could disagree with it — and the run aborts before any enumeration if even one entry is malformed. Loading `--exclude-file` itself (`loadExclusionSet()`/`readExclusionFile()`) throws rather than silently proceeding with zero file-based exclusions if the file is missing or unreadable; the CLI script catches that throw only to print a clear message and abort, never to continue. Both checks apply in dry-run and execute alike — a dry-run report enumerated with the wrong exclusion set would be misleading, not just an execute run unsafe.

### Dry-run default; execution requires `--execute`

`npm run workspaces:provision-existing -- --dry-run` (or no flag at all — dry-run is the default) is **structurally** read-only: `discoverUserWorkspaceStatus()` — the function dry-run mode calls — only ever calls `getWorkspace()`, and a dedicated regression test (`lib/workspaces/__tests__/existingUserProvisioning.spec.ts`, "Structural: dry-run is incapable of writing") asserts by source inspection that its function body contains no reference to `createPersonalWorkspace(` or `ensurePersonalWorkspace(` at all — not merely that it happens not to call them today. `--execute` is the sole way to opt into mutation (`lib/workspaces/provisioningSafety.ts`'s `parseProvisioningCliArgs()` — a dedicated test proves no misspelled or malformed flag variant accidentally enables it).

**Project identity, validated before any enumeration, in both modes:** `checkProjectIdentityConsistency()` resolves the Firebase project the Admin SDK was *actually* initialized with (`getInitializedFirebaseProjectId()` in `lib/firebase/admin.ts`, reading `app.options.projectId` back from the live, already-initialized app — never re-derived from a second, independently-trusted environment variable), and requires it to (a) be resolvable at all and (b) agree with `FIREBASE_PROJECT_ID` (the env-var-driven constant used elsewhere in the codebase). Disagreement between the two — a "split-brain" misconfiguration, possible when `FIREBASE_SERVICE_ACCOUNT_BASE64`/`_JSON`'s embedded `project_id` differs from `FIREBASE_PROJECT_ID` — aborts immediately with `firebase_project_configuration_mismatch`, before enumeration, in both dry-run and execute, and is never overridable by `--yes`. This closes a gap from the earlier design, where `--confirm-project` was checked only against the same env-var constant used to initialize the SDK — under a credential mismatch, an operator could have confirmed a project the SDK wasn't actually connected to. `--confirm-project` now compares against this actual, validated identity, not the env constant.

Executing also requires passing `checkProvisioningGuard()` (mirrors the established `adaptiveGovernanceSeedSafety.ts` pattern), checked in this order: `--confirm-project=<id>` present and matching the actual initialized project (see above), then `ALLOW_WORKSPACE_PROVISIONING=true` (exact literal) env var, then `NODE_ENV !== "production"` and no `VERCEL_ENV` set as defense-in-depth (this repo has no separate dev/staging Firebase project, so these are secondary checks, not the primary gate — same disclosed constraint as the governance seed script). An interactive "type yes" confirmation prompt is also required unless `--yes` is passed — `--yes` skips only that prompt, never any of the checks before it.

### Pagination

`adminAuth.listUsers(pageSize, pageToken)` is paged via a `do…while` loop over `runExistingUserProvisioning()` (`lib/workspaces/existingUserProvisioningRun.ts`), continuing until a page returns no `pageToken`. The loop is dependency-injected (`listUsersPage: ListUsersPageFn`) specifically so it's unit-testable against fake, controlled, multi-page fixtures without mocking the Firebase Admin SDK — the real CLI script's only job is supplying the real `adminAuth.listUsers` binding.

**A fatal enumeration failure (a page's `listUsersPage` call rejecting) never throws out of `runExistingUserProvisioning()`.** It's caught internally, and the function returns normally with `status: "incomplete"` plus a sanitized `fatalError: { code: "enumeration_failed", message }` — the raw exception is deliberately never persisted (it could carry internal details unsafe to write to a result artifact) — and whatever was aggregated from pages that DID succeed is preserved, not discarded. The CLI script always writes a result artifact regardless of `status`, and exits non-zero whenever it's `"incomplete"`. This closes an earlier gap where a page-2+ failure would throw, produce no artifact at all, and silently lose every already-processed page's results (recoverable only by manually copying the last `onPageComplete` console line's page token).

### Bounded concurrency

Each page's users are processed through a hand-rolled worker-pool (`mapWithConcurrency()` in `lib/workspaces/existingUserProvisioning.ts`, default concurrency 5, `--concurrency=<n>` to override) rather than sequentially or fully in parallel. Verified via an instrumented test tracking real-time in-flight count, asserting it never exceeds the configured limit while still proving genuine concurrency occurred (not accidental serialization) — including dedicated tests at `concurrency=1` (observed max-in-flight is exactly 1) and at the operational maximum with a population larger than it.

Concurrency is bounded to an explicit operator-facing range: `MIN_PROVISIONING_CONCURRENCY = 1`, `MAX_PROVISIONING_CONCURRENCY = 20` (`lib/workspaces/provisioningSafety.ts`) — a conservative ceiling, not a Firebase/Firestore hard limit, meant to catch operator error (e.g. an extra zero) rather than let a `--concurrency` typo blow past the "5-10 concurrent" spec by orders of magnitude. `validateProvisioningConcurrency()` rejects any non-integer or out-of-range value with an explicit `invalid_concurrency` error rather than silently clamping — a bulk-mutation safety knob should fail loudly on clearly-wrong input, not quietly substitute a value the operator never asked for. Only a *missing* `--concurrency` flag falls back to the default of 5; a present-but-malformed one (non-numeric, decimal, negative, zero, or over the ceiling) is caught by this explicit validation step, run immediately after argv parsing and before any enumeration.

### Failure isolation

One user's failure never aborts the batch. `provisionUserWorkspace()` returns a typed `{ status: "failed" }` (or `lookup_failed`/`invalid_uid`) per-user result rather than throwing; `runExistingUserProvisioning()` aggregates these into a `failures[]` array in the final report and continues processing every remaining user and page regardless. This is a deliberately different failure class from Auth-enumeration failure (above): a per-user outcome never aborts anything; only a failure to list the population itself marks the whole run `"incomplete"`.

### No automatic conflict repair

`conflict` results (`wrong_owner`, `wrong_type`, `malformed`) are reported, never auto-repaired — this mirrors `ensurePersonalWorkspace()`'s own fail-closed, never-overwrite behavior from Phase 2. A conflict means a document already exists at the deterministic `personal-{uid}` id that doesn't match the expected shape/owner; resolving that is an explicit, separate, human-reviewed operation, never something the bulk provisioner decides on its own.

### Resumability

No Firestore checkpoint document is used. Because `ensurePersonalWorkspace()` is fully idempotent, a complete full re-run is always safe — already-provisioned users simply report `existing` again (one extra read each, no write, no mutation). For very large populations where re-scanning from the start is undesirable, the script also prints the current Auth `pageToken` after every completed page; an operator can pass that back via `--start-page-token=<token>` to resume from exactly that point. Both strategies are safe; which one to use is an operator cost/convenience choice, not a correctness requirement.

### Result artifact

Every run (dry-run or execute, complete or incomplete) writes a JSON result file (`workspace-provisioning-<timestamp>.json` by default, or `--output=<path>`) containing: `project` (the actual validated identity, not the env constant), `dryRun`, `status` (`"complete"` | `"incomplete"`), `startedAt`/`completedAt`, `pageSize`, `concurrency`, `totals` (scanned/eligible/excluded), `counts` (per-status breakdown), `conflicts[]`, `failures[]`, `excludedRecords[]`, `fatalError` (present only when `status: "incomplete"` — a sanitized `{code, message}`, never the raw exception) — each per-user record carries only `uid` and `status`/`reason`, deliberately excluding email, display name, or any other PII. A human-readable summary (including the `Status:` line) is also printed to stdout. If the artifact write itself fails, the script still exits non-zero and the failure is printed, rather than silently reporting success with no durable record. These artifact files are gitignored and not meant to be committed — they contain real user ids from whichever project they were run against.

### Coverage audit contract

Phase 3 readiness (or any future gate that treats a bulk-provisioning report as proof of coverage) must use `isCompleteWithFullCoverage()` (`lib/workspaces/existingUserProvisioningRun.ts`) as the sole sanctioned predicate: `status === "complete"` AND `counts.missing === 0` AND zero `conflicts` AND zero `failures`. An `"incomplete"` result can never satisfy this, no matter how clean its partial counts look, because a partial enumeration cannot prove `missing === 0` for users it never reached.

This predicate does **not** check for "unexpected Workspace documents" — a `personal-{uid}` document existing with no corresponding eligible Auth user (e.g. from a since-deleted Auth account, or a project mismatch during an earlier, differently-configured run). That's a distinct, independent reverse-audit concern requiring a separate query against the `workspaces` collection cross-referenced against a fresh `listUsers()` enumeration; it is deliberately not built into this run's own result, since it isn't a property of any single provisioning pass. Before treating a Stage E audit (below) as final, an operator should also confirm no such orphaned documents exist.

### Production rollout plan (Phase 2B) — prepared, not executed

Population is checked fresh immediately before execution at every stage — the specific counts observed during development/review (see below) are a snapshot, not something to hardcode into rollout decisions, since real users can sign up between the last dry run and the actual execute.

- **Stage A** — `--dry-run` against production. Confirm scanned/eligible/excluded totals match the known Auth population size, zero unexpected conflicts, zero writes (verified by re-querying the `workspaces` collection before/after), `status: "complete"`.
- **Stage B** — `--execute` against a small (~5-user) controlled batch (`--exclude-file` covering everyone else, or a narrow test cohort). Confirm exactly the expected number of new documents, correct owner/schema on each, zero mutation to any pre-existing document.
- **Stage C** — `--execute` against the remaining population at the default concurrency (5) — there is no operational reason to raise it just because a higher ceiling (20) is supported; the goal is safety margin, not speed, at this population size.
- **Stage D** — coverage audit: a final `--dry-run` pass requiring `isCompleteWithFullCoverage() === true` (`status: "complete"`, `missing: 0`, `conflicts: 0`, `failures: 0`) across the entire eligible population, plus a manual check for unexpected Workspace documents (see "Coverage audit contract" above). This is the explicit **Phase 3 entry gate** — Phase 3 (workspace-aware writes for new runs) should not begin until this audit is clean, per the strategic ordering decided at the top of this section.

This plan is prepared and documented only. No production bulk provisioning (`--execute` against real production data) has been run as part of this phase — every production interaction so far has been read-only `--dry-run` verification.
