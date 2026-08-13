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

Phase 1 (COMPLETE, in production) → Phase 2 (COMPLETE, in production — provisions Personal Workspaces one-at-a-time on self-service demand only) → **Phase 2B (this document's latest section) bulk-provisions Personal Workspaces for the existing user population — explicitly NOT run backfill** → Phase 3 makes writes workspace-aware for new runs → Phase 4 makes reads/history workspace-aware and backfills historical runs → Phase 5 ships Workspace UI → Phase 6 introduces Projects → Phase 7 ships Projects UI → Phase 8 adds shared/collaborative workspaces.

The Phase 2B → Phase 3 ordering is a deliberate strategic choice: existing users are made Workspace-ready (provisioned) before any run gains workspace-aware writes. This keeps Phase 3 simple — new-run creation never needs to provision a Workspace and create a run in the same hot-path operation, because by the time Phase 3 starts, provisioning coverage should already be at or near 100%.

Phase 1, Phase 2, and Phase 2B are each independently releasable and reversible without any dependency on a later phase ever shipping.

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

There is no hardcoded exclusion list in the codebase. Exclusion is entirely operator-driven at invocation time, via repeatable `--exclude-uid=<uid>` CLI flags and/or a `--exclude-file=<path>` newline-delimited file (`#`-prefixed comment lines ignored, matching `lib/workspaces/provisioningEligibility.ts`'s `parseExclusionList()`). This keeps the decision of "which accounts are service/test/canary accounts" a reviewable, per-run operator input rather than a silently-encoded assumption baked into shipped code.

### Dry-run default; execution requires `--execute`

`npm run workspaces:provision-existing -- --dry-run` (or no flag at all — dry-run is the default) is **structurally** read-only: `discoverUserWorkspaceStatus()` — the function dry-run mode calls — only ever calls `getWorkspace()`, and a dedicated regression test (`lib/workspaces/__tests__/existingUserProvisioning.spec.ts`, "Structural: dry-run is incapable of writing") asserts by source inspection that its function body contains no reference to `createPersonalWorkspace(` or `ensurePersonalWorkspace(` at all — not merely that it happens not to call them today. `--execute` is the sole way to opt into mutation (`lib/workspaces/provisioningSafety.ts`'s `parseProvisioningCliArgs()` — a dedicated test proves no misspelled or malformed flag variant accidentally enables it).

Executing also requires passing `checkProvisioningGuard()` (mirrors the established `adaptiveGovernanceSeedSafety.ts` pattern): `ALLOW_WORKSPACE_PROVISIONING=true` (exact literal) env var, plus `--confirm-project=<id>` matching the actually-resolved Firebase project, plus `NODE_ENV !== "production"` and no `VERCEL_ENV` set as defense-in-depth (this repo has no separate dev/staging Firebase project, so these are secondary checks, not the primary gate — same disclosed constraint as the governance seed script). An interactive "type yes" confirmation prompt is also required unless `--yes` is passed.

### Pagination

`adminAuth.listUsers(pageSize, pageToken)` is paged via a `do…while` loop over `runExistingUserProvisioning()` (`lib/workspaces/existingUserProvisioningRun.ts`), continuing until a page returns no `pageToken`. The loop is dependency-injected (`listUsersPage: ListUsersPageFn`) specifically so it's unit-testable against fake, controlled, multi-page fixtures without mocking the Firebase Admin SDK — the real CLI script's only job is supplying the real `adminAuth.listUsers` binding.

### Bounded concurrency

Each page's users are processed through a hand-rolled worker-pool (`mapWithConcurrency()` in `lib/workspaces/existingUserProvisioning.ts`, default concurrency 5, `--concurrency=<n>` to override) rather than sequentially or fully in parallel. Verified via an instrumented test tracking real-time in-flight count, asserting it never exceeds the configured limit while still proving genuine concurrency occurred (not accidental serialization).

### Failure isolation

One user's failure never aborts the batch. `provisionUserWorkspace()` returns a typed `{ status: "failed" }` (or `lookup_failed`/`invalid_uid`) per-user result rather than throwing; `runExistingUserProvisioning()` aggregates these into a `failures[]` array in the final report and continues processing every remaining user and page regardless.

### No automatic conflict repair

`conflict` results (`wrong_owner`, `wrong_type`, `malformed`) are reported, never auto-repaired — this mirrors `ensurePersonalWorkspace()`'s own fail-closed, never-overwrite behavior from Phase 2. A conflict means a document already exists at the deterministic `personal-{uid}` id that doesn't match the expected shape/owner; resolving that is an explicit, separate, human-reviewed operation, never something the bulk provisioner decides on its own.

### Resumability

No Firestore checkpoint document is used. Because `ensurePersonalWorkspace()` is fully idempotent, a complete full re-run is always safe — already-provisioned users simply report `existing` again (one extra read each, no write, no mutation). For very large populations where re-scanning from the start is undesirable, the script also prints the current Auth `pageToken` after every completed page; an operator can pass that back via `--start-page-token=<token>` to resume from exactly that point. Both strategies are safe; which one to use is an operator cost/convenience choice, not a correctness requirement.

### Result artifact

Every run (dry-run or execute) writes a JSON result file (`workspace-provisioning-<timestamp>.json` by default, or `--output=<path>`) containing: `project`, `dryRun`, `startedAt`/`completedAt`, `pageSize`, `concurrency`, `totals` (scanned/eligible/excluded), `counts` (per-status breakdown), `conflicts[]`, `failures[]`, `excludedRecords[]` — each per-user record carries only `uid` and `status`/`reason`, deliberately excluding email, display name, or any other PII. A human-readable summary is also printed to stdout. These artifact files are gitignored and not meant to be committed — they contain real user ids from whichever project they were run against.

### Production rollout plan (Phase 2B) — prepared, not executed

- **Stage A** — `--dry-run` against production. Confirm scanned/eligible/excluded totals match the known Auth population size, zero unexpected conflicts, zero writes (verified by re-querying the `workspaces` collection before/after).
- **Stage B** — `--execute` against a small (~5-user) controlled batch (`--exclude-file` covering everyone else, or a narrow test cohort). Confirm exactly the expected number of new documents, correct owner/schema on each, zero mutation to any pre-existing document.
- **Stage C** — `--execute` against a 20-50 user batch. Re-run immediately after; confirm zero new duplicates, all previously-created users report `existing`.
- **Stage D** — `--execute` against the remaining population, in operator-controlled page-sized batches (using `--start-page-token` between batches if desired).
- **Stage E** — coverage audit: a final `--dry-run` pass requiring `missing: 0` and `conflicts: 0` across the entire eligible population. This is the explicit **Phase 3 entry gate** — Phase 3 (workspace-aware writes for new runs) should not begin until Stage E's audit is clean, per the strategic ordering decided at the top of this section.

This plan is prepared and documented only. No production bulk provisioning (`--execute` against real production data) has been run as part of this phase — every production interaction so far has been read-only `--dry-run` verification.
