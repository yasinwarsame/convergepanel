# Workspace Compatibility Foundation — Phase 1 Architecture

**Status: Phase 1 implemented. No route wiring. No production data touched. Not user-visible.**

This document describes what Phase 1 actually built, why, and the invariants later phases must preserve. It is implementation-specific, not aspirational product prose. For the pre-existing data-model/authorization audit this design is built on, see `docs/team-workspaces-architecture-audit.md`.

## Program context

This is Phase 1 of an 8-phase program:

1. **Workspace Compatibility Foundation** (this document)
2. Personal Workspace Provisioning + Backfill
3. Workspace-Aware Writes
4. Workspace-Aware Reads + History
5. Workspace UI
6. Projects Foundation
7. Projects UI
8. Shared Workspace / Collaboration

Phase 1's only job: introduce the minimum architecture required for ConvergePanel to *understand* the concept of a Workspace, in a way that is additive, backward-compatible, dark by default, and independently releasable — with zero effect on any existing user or route today.

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

No `Workspace` document is ever created, updated, or deleted by Phase 1 code. `lib/firestore/workspaces.ts` exports exactly one function, `getWorkspace()` — a read. There is no `createWorkspace`, no `provisionPersonalWorkspace`, nowhere in the codebase. The capability to write a workspace document does not exist yet, not merely "exists but unused."

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
workspaceId absent                → legacy compatibility
workspaceId present but invalid   → explicit failure, never legacy
```

Once a non-empty `workspaceId` is present (and the feature flag is on), resolution can only return `resolved` or a named failure kind. It can **never** return to `legacy`. This is enforced structurally, not just by convention: `resolveWorkspaceContext()`'s workspaceId-present branch has no code path back to a `legacy` result. Five distinct outcomes are always kept separate and never conflated:

| Outcome | Meaning |
|---|---|
| `legacy` | No workspaceId — today's existing behavior, unchanged |
| `resolved` | workspaceId present, workspace found, well-formed, `type: "personal"` |
| `not_found` | workspaceId present, no such workspace document exists |
| `malformed` | workspace document exists but fails shape validation, or its own `id` doesn't match the requested id |
| `unsupported_workspace_type` | workspace is well-formed but `type: "team"` — real future data, not yet authorizable |
| `lookup_failed` | internal Firestore read failure (distinct from "not found") |

`authorizeWorkspaceResourceAccess()` denies on every one of `not_found` / `malformed` / `unsupported_workspace_type` / `lookup_failed` — **it never falls back to checking the legacy owner field once a workspaceId was present.** This is proven by the "legacy downgrade" test suite in `lib/workspaces/__tests__/workspaceAccess.spec.ts`: even when the calling `uid` genuinely equals the resource's `legacyOwnerUserId`, an invalid workspace reference still denies.

## Authorization principles

- Workspace access is always server-derived, from the persisted `workspaces/{id}` document's own `ownerUserId` field — never from a client-supplied `workspaceId`, a UI-selected workspace, or a claimed membership.
- Phase 1's entire access model, for both `legacy` and `workspace` (personal) modes, is exact `uid === ownerUserId` equality. No membership, roles, or delegation exist for either mode yet.
- Workspace does not weaken existing authorization: for legacy records, current authorization behavior remains fully authoritative, unchanged, because no route calls any Phase 1 code yet.

## Feature flag

`WORKSPACES_ENABLED` (`lib/env.ts`), server-side only, `process.env.WORKSPACES_ENABLED === "true"` — same fail-closed convention as every other flag in this file (`ADAPTIVE_SCHEMAS_ENABLED`, `MULTI_REVIEWER_GOVERNANCE_ENABLED`, etc.). Default **off**.

The flag is checked *inside the resolver itself*, not only at a hypothetical future route boundary: when `false`, `resolveWorkspaceContext()` always returns `legacy`, regardless of whether a `workspaceId` is present or what it resolves to. This is a global kill switch, not a per-record fallback decision — categorically different from the forbidden "malformed → pretend legacy" downgrade above, the same way `ADAPTIVE_SCHEMAS_ENABLED=false` makes an entire feature not exist rather than degrading it per-record.

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

Phase 1 introduces no migration and has no route depending on it. **Code rollback is sufficient; no data rollback is required.** Reverting the deployment removes `lib/workspaces/*`, `lib/firestore/workspaces.ts`, and the `WORKSPACES_ENABLED` flag from the running build; since nothing ever wrote a `workspaces/{id}` document or a `workspaceId` field in production, there is nothing in the database that depends on this code existing. The only artifact left behind by a rollback would be an empty `workspaces` collection that was never populated — inert, not a compatibility concern.

## Security invariants — summary

1. **Workspace IDOR** (User A supplies User B's real workspace id) — denied. Tested.
2. **Cross-workspace access** (genuine owner of Workspace A requests a resource bound to Workspace B) — denied. Tested.
3. **Legacy downgrade** (invalid/missing/malformed workspace reference) — never falls back to legacy owner check, even when the calling uid genuinely equals the legacy owner field. Tested for `not_found`, `malformed`, `lookup_failed`, and `unsupported_workspace_type`.
4. **Forged/claimed ownership** — access is computed purely from the server-resolved `WorkspaceContext.ownerUserId`, never from any client-supplied claim. Tested.
5. **No implicit creation** — no function in `lib/firestore/workspaces.ts` or `lib/workspaces/*` writes anything. Verified structurally by test (module export enumeration), not just by inspection.

## Rollout phases (for context; not part of Phase 1's scope)

Phase 1 (this document) → Phase 2 provisions Personal Workspaces + backfill → Phase 3 makes writes workspace-aware → Phase 4 makes reads/history workspace-aware → Phase 5 ships Workspace UI → Phase 6 introduces Projects → Phase 7 ships Projects UI → Phase 8 adds shared/collaborative workspaces.

Phase 1 is independently releasable and reversible without any dependency on a later phase ever shipping.
