# Phase 8 — Enterprise Team Workspaces: Frozen Architecture (8A–8A.2) & Core Foundation (8B)

**Status: Phase 8A / 8A.1 / 8A.2 architecture reviewed and frozen (2026-08-20). Phase 8B implemented the foundation — creation, ownership transfer, membership storage, capability model, access resolution, and account-lifecycle protection. Phase 8B.1 corrected three review findings (fail-closed account-lifecycle guard, no environment-contract change, corrected `/api/workspaces` namespace). Phase 8B.2 is a further reconciliation pass on the SAME branch (not a restart) correcting two architecture-drift findings — the review capability matrix and the membership-id domain separator — and reinstating a canary rollout gate (`TEAM_WORKSPACES_ENABLED`/`TEAM_WORKSPACES_CANARY_UIDS`, mirroring the existing Projects backend-canary precedent) now that the architecture explicitly calls for one. Invitations, member-management UI, Team Projects, Team research-run creation, Team report sharing, Team review integration, Team Workspace UI, and the four planned composite indexes are all explicitly deferred to later Phase 8 subphases. No Team Workspace has been created in production; the rollout flag defaults off.**

This is an architectural record of what was decided and why — not a claim about what has shipped where. See `docs/workspaces/architecture.md` for Phases 1–3D (Personal Workspace foundation, provisioning, and workspace-aware writes) and `docs/team-workspaces-architecture-audit.md` for the original pre-Phase-8 data-model audit this design builds on.

## Program context

Phase 8 is the 8th phase of the Workspace & Projects program (see `docs/workspaces/architecture.md`'s "Program context"): shared/collaborative Team Workspaces, layered additively on top of the Personal Workspace foundation Phases 1–7 already shipped. Nothing about Personal Workspace behavior changes as part of Phase 8.

Phase 8 itself is internally staged:

- **8A** — initial Team Workspace architecture proposal (schema, membership, roles).
- **8A.1** — revision addressing initial review feedback.
- **8A.2** — final revision; reviewed and accepted with one correction (see "OCC requirements" below) — **frozen as of 2026-08-20**.
- **8B** — Team Workspace Core Foundation, Ownership & Access Control. Implements the frozen architecture's foundation only.
- **8B.1** — corrective pass following senior review of 8B: the account-lifecycle guard now fails closed on an ownership-lookup failure, the `TEAM_WORKSPACES_ENABLED` environment variable Phase 8B had introduced (in violation of the "no environment change" requirement) was removed, and the Team API namespace was corrected from `/api/user/team-workspaces` to the frozen `/api/workspaces` root.
- **8B.2** (this document's latest revision) — a further hardening/reconciliation pass on the same implementation, not a restart: (1) the review-capability matrix corrected so `reviews.submit` is single-role eligibility granted to every role except Viewer, never requiring a Workspace role change to become reviewer-eligible; (2) the membership-id algorithm now hashes a fixed domain separator (`convergepanel.workspace-membership.v1`) as part of its input, not merely as a display prefix on the output; (3) a canary rollout gate (`TEAM_WORKSPACES_ENABLED`/`TEAM_WORKSPACES_CANARY_UIDS`) was reinstated, mirroring the existing `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS` precedent, since the architecture now explicitly calls for one (superseding 8B.1's "no environment flag" stance, which was correct for that review cycle's stated constraint but not for this one).
- 8C+ (not started) — member management, invitations (8D), Team Projects, Team research runs, Team review integration, Team Workspace UI.

## Personal versus Team Workspace schema

`WorkspaceV1` (`lib/workspaces/types.ts`) is a `type`-discriminated union, additive over the pre-8B flat shape:

```ts
type WorkspaceType = "personal" | "team";

interface PersonalWorkspaceV1 {
  schemaVersion: 1;
  id: string;
  type: "personal";
  name: string;
  ownerUserId: string;
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}

interface TeamWorkspaceV1 {
  schemaVersion: 1;
  id: string;
  type: "team";
  name: string;
  ownerUserId: string;
  createdByUserId: string;
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}

type WorkspaceV1 = PersonalWorkspaceV1 | TeamWorkspaceV1;
```

Every Personal Workspace document written by Phases 1–7 already satisfies `PersonalWorkspaceV1` byte-for-byte — no migration, no backfill, no new required field on Personal. `createdByUserId` exists only on the Team variant; `isWellFormedWorkspaceV1()` requires it (non-empty string) exactly when `type === "team"` and never checks for it on `type === "personal"`.

## `createdByUserId` vs `ownerUserId` semantics

- **`ownerUserId`** — CURRENT administrative ownership. Mutable exactly once per ownership-transfer transaction (see below); never mutated any other way. Drives every Owner-capability decision (`resolveWorkspaceAccess()`'s Team path, `isCanonicalTeamOwnerMembership()`).
- **`createdByUserId`** — immutable historical provenance, set once at Team Workspace creation, set to the founder's uid, and never written again by any Phase 8B code path — not by transfer, not by any account-lifecycle guard, not by any future member-management mutation this phase structurally prevents from touching it (no write path in `lib/firestore/workspaceMemberships.ts` includes `createdByUserId` in any `tx.update()` call). Tested explicitly in `lib/firestore/__tests__/workspaceMemberships.spec.ts`'s transfer suite.

A Personal Workspace has no `createdByUserId` — one person is both creator and owner, already fully captured by `ownerUserId`.

## `workspaceMemberships` storage model

Canonical, top-level collection at `workspaceMemberships/{membershipId}` — never a `members[]` array embedded on the Workspace document, never a Workspace subcollection. This mirrors the codebase's existing preference for flat, independently-queryable collections (`runs`, `projects`) over embedding.

```ts
interface WorkspaceMembershipV1 {
  schemaVersion: 1;
  id: string;               // === computeMembershipId(workspaceId, uid)
  workspaceId: string;
  uid: string;
  role: "owner" | "admin" | "member" | "reviewer" | "viewer";
  status: "active" | "removed";
  createdAt: Timestamp;
  updatedAt: Timestamp;
  invitedByUserId: string | null;   // null for the founder membership
  removedAt: Timestamp | null;
  removedByUserId: string | null;
}
```

Defined in `lib/workspaces/membershipTypes.ts`. Removal is a soft-delete (`status: "removed"`) — a removed membership document is never deleted, matching the codebase's general audit-trail-over-hard-delete posture. `removedAt`/`removedByUserId` must agree (`null` together or populated together) and must cohere with `status` — a document claiming `removed` with a `null` `removedAt`, or `active` with a populated one, fails validation outright.

## Deterministic membership ID construction

`computeMembershipId(workspaceId, uid)` in `lib/workspaces/membershipId.ts`:

```
canonicalBytes =
    utf8(DOMAIN_SEPARATOR)
  || u32be(byteLength(utf8(workspaceId))) || utf8(workspaceId)
  || u32be(byteLength(utf8(uid)))         || utf8(uid)

membershipId = "wm_" + lowercaseHex(SHA256(canonicalBytes))
```

where `DOMAIN_SEPARATOR = "convergepanel.workspace-membership.v1"`.

**The domain separator is hashed as the first bytes of the digest input (Phase 8B.2) — it is not merely the `wm_` display prefix on the output.** The `wm_` string prepended to the hex digest is a readability convention only; it plays no role in the hash computation and provides no domain separation by itself — two different hash-input domains that happened to compute over the identical `(workspaceId, uid)`-shaped bytes would still collide at the digest level even if their displayed ids used different string prefixes. Hashing `DOMAIN_SEPARATOR` as the first segment of `canonicalBytes` is what makes this id space cryptographically distinct from any other hash this application (or a future one) might compute over a similarly-shaped tuple. Proven with fixed, hardcoded test vectors (`__tests__/membershipId.spec.ts`) — a property-based/relative test suite alone (determinism, tuple-distinctness) cannot catch a regression that silently drops or changes the separator, since those properties would still hold either way.

Length prefixes are UTF-8 **byte** lengths (`Buffer.byteLength(str, "utf8")`), never JS `string.length` (which counts UTF-16 code units and diverges for any multibyte character) — using `string.length` would make the serialization non-injective for multibyte input. This is also proven with a fixed vector, not just a relative one: a naive `string.length`-based implementation and the correct `Buffer.byteLength`-based one produce the SAME digest for pure-ASCII inputs (byte length and UTF-16 length coincide there) — only a multibyte fixed vector (`"ws-😀"`, byte length 7 vs. `string.length` 5) can actually distinguish the two, and only a hardcoded expected digest for that exact input can prove which one the implementation actually uses.

The length-prefixed serialization is injective: no delimiter-looking byte sequence inside either value can be misread as a segment boundary, so two distinct `(workspaceId, uid)` tuples can never produce the same `canonicalBytes`. SHA-256 is then applied only for fixed-length, practically collision-resistant output — the injective serialization, not the hash function, is what guarantees different inputs are never hashed from the same bytes. (SHA-256 itself is practically collision-resistant, never described as "mathematically collision-free.") Output is always `wm_` + 64 lowercase hex characters = 67 characters total. Uses Node's built-in `crypto` module — no new dependency.

## Membership validation requirements

Two layers, matching the split already established for `WorkspaceV1`/`getWorkspace()`:

1. **Structural** (`isWellFormedWorkspaceMembershipV1()`, `lib/workspaces/membershipTypes.ts`) — pure shape check: `schemaVersion === 1`, non-empty `id`/`workspaceId`/`uid`, `role`/`status` in their frozen enums, `createdAt`/`updatedAt` genuine `Timestamp` instances, `invitedByUserId` a non-empty string or exactly `null`, `removedAt`/`removedByUserId` internally coherent with each other and with `status`. Unknown/extra fields accepted (open, forward-compatible schema).
2. **Resource-binding** (`validateMembershipBinding()`, `lib/workspaces/membershipBinding.ts`) — given already-fetched data and an expected `(workspaceId, uid)`, additionally requires `doc.id === computeMembershipId(doc.workspaceId, doc.uid)` (self-consistency) and `doc.workspaceId === expected.workspaceId` / `doc.uid === expected.uid` (binding to the caller's actual request). A deterministic document path is never trusted by itself — this is the check that catches a document whose own embedded fields disagree with what its id implies.

`getWorkspaceMembershipForBinding()` (`lib/firestore/workspaceMemberships.ts`) is the one canonical (workspaceId, uid) → membership load path: a direct `.get()` at `workspaceMemberships/{computeMembershipId(workspaceId, uid)}`, no query, delegating to `validateMembershipBinding()`. Any mismatch fails closed (`malformed`) — never silently repaired.

## Role / capability matrix — review model corrected in Phase 8B.2

Centralized in `lib/workspaces/capabilities.ts` (`ROLE_CAPABILITIES`, frozen at module load via `Object.freeze`). Foundation only in Phase 8B — no route yet enforces most of these capabilities (e.g. `research.create`); per-run reviewer assignment remains an independent Phase 8F requirement.

**Phase 8B.2 correction — `reviews.submit` is single-role eligibility, not a second membership role.** A `workspaceMemberships` document carries exactly ONE `role`. Phase 8B's original matrix denied `reviews.submit` to Member, which would have forced an enterprise analyst to give up their `projects.create`/`research.organize` collaboration capabilities merely to become review-eligible (there is no "Member AND Reviewer" simultaneous state). The corrected model grants `reviews.submit` to every role except Viewer — Owner, Admin, Member, and Reviewer can all be assigned as a reviewer without a Workspace role change. `reviews.submit` alone is never sufficient to cast an actual vote: Phase 8F must additionally require the existing, unchanged canonical per-run/panel reviewer assignment (the `reviewer_not_assigned` gate already present in `app/api/teams/adaptive-runs/[runId]/votes/route.ts`, whose own doc comment already states this exact two-dimensional principle — "voting authorization is panel membership + current eligibility, NOT a standalone admin gate"). Workspace capability answers "is this uid ALLOWED to be a reviewer"; per-run assignment answers "IS this uid the reviewer for THIS run" — both must hold.

| Capability | Owner | Admin | Member | Reviewer | Viewer |
|---|---|---|---|---|---|
| `workspace.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `members.read` | ✓ | ✓ | ✓ | | |
| `members.invite` | ✓ | ✓ | | | |
| `members.manage` (Member/Reviewer/Viewer only, not Admin/Owner grant/revoke) | ✓ | ✓ | | | |
| `audit.read` | ✓ | ✓ | | | |
| `projects.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `projects.create` / `.manage` | ✓ | ✓ | ✓ | | |
| `research.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `research.create` / `.organize` | ✓ | ✓ | ✓ | | |
| `reviews.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reviews.submit` | ✓ | ✓ | ✓ | ✓ | |
| `reviews.manage` | ✓ | ✓ | | | |
| `reviews.override` | ✓ | | | | |
| `exports.create` (Reviewer/Viewer conservative-V1 exclusion — export is an exfiltration-adjacent capability, not just another read) | ✓ | ✓ | ✓ | | |
| `ownership.transfer` | ✓ | | | | |
| `admins.manage` | ✓ | | | | |

Reviewer additionally has NO `projects.create`, `projects.manage`, or `research.organize` — read-only on Projects, matching Viewer's read-only posture on the same axis.

`ORDINARY_SETTABLE_ROLES` (`["admin", "member", "reviewer", "viewer"]`) structurally excludes `"owner"` — the one set any future generic role-mutation endpoint must intersect against, so ownership can never be granted or demoted through an ordinary role change.

## Owner invariant

`isCanonicalTeamOwnerMembership()` (`lib/workspaces/ownerInvariant.ts`) — the ONE canonical definition of "is this membership row a genuine, currently-valid Owner," shared by the read path (`resolveWorkspaceAccess()`) and the write path (`transferTeamWorkspaceOwnership()`):

```
workspace.type === "team"
membership.status === "active"
membership.workspaceId === workspace.id
membership.role === "owner"
workspace.ownerUserId === membership.uid
```

A membership row with `role: "owner"` while `workspace.ownerUserId` disagrees is an **integrity violation**, not a lower-privilege grant: `resolveWorkspaceAccess()` denies the ENTIRE authorization result for that membership (never reinterpreted as Admin, never granted any lower capability set) and logs a structured integrity event via `logger.error()`. No standing "exactly one Owner" query exists or is needed — the invariant is checked from the two documents (`workspace`, `membership`) already read for any normal access resolution; no N+1 pattern.

## Backend rollout — canary gate (Phase 8B.2)

`TEAM_WORKSPACES_ENABLED` (boolean, default off) + `TEAM_WORKSPACES_CANARY_UIDS` (comma-separated uid allowlist, max 10 entries) — structural mirror of the existing `PROJECTS_ENABLED`/`PROJECTS_CANARY_UIDS` precedent (Phase 6B), resolved by `resolveTeamWorkspacesMode()` (`lib/workspaces/teamWorkspacesRollout.ts`). Same precedence as every other canary in this codebase: global `true` always wins (even over a malformed canary list — a deliberate global rollout must never be silently disabled by an unrelated allowlist typo); otherwise an exact uid match against a VALID canary list; otherwise off. A malformed or oversized (>10) canary list fails closed to off for everyone when global is false — never "enable everyone," never "guess which entries were valid."

Gates the entire Team Workspace backend surface — checked, against the acting uid, before any Firestore access in `createTeamWorkspace()`, `transferTeamWorkspaceOwnership()` (both by `callerUid`), and `resolveWorkspaceAccess()`'s Team path (by the resolving uid). Unrelated to and with no effect on `WORKSPACES_ENABLED` (the pre-existing resource-to-workspace binding resolver, a different axis) or on Personal Workspace behavior, which never reads this flag at all.

Superseded 8B.1's "no environment flag" position: that correction was right for the constraint stated at the time (Phase 8B, as originally scoped, explicitly prohibited any environment-contract change, and nothing was deployed to protect against anyway). This checkpoint's frozen architecture explicitly calls for a canary gate as the intended rollout mechanism for the *next* phase of work, so reinstating it — using the codebase's own established two-variable canary pattern rather than inventing a new one — is implementing the (now-updated) architecture, not re-violating the prior instruction.

## Team Workspace creation transaction

`createTeamWorkspace()` (`lib/firestore/workspaceMemberships.ts`) — one `adminDb.runTransaction()`, `tx.create()` on both the Workspace and founder-membership refs. A Team Workspace is never observable without its Owner membership: either both documents commit or neither does. Every identity-derived field (`ownerUserId`, `createdByUserId`, founder `uid`/`role`) is derived server-side from the authenticated caller alone; the request body is parsed only for `name` (`POST /api/workspaces`). Founder `invitedByUserId` is always `null` — the founder was not invited by anyone, and this is never falsified to the owner's own uid (or any other value) merely to avoid a `null`; a later invitation-created membership carries the real inviter's uid instead. Tested explicitly, including a negative assertion that `invitedByUserId !== ownerUid`.

## Ownership-transfer transaction

`transferTeamWorkspaceOwnership()` (`lib/firestore/workspaceMemberships.ts`), exposed via `POST /api/workspaces/[workspaceId]/transfer-ownership`. One transaction, three documents read together (`tx.get()` via `Promise.all`): the Workspace, the caller's own membership (at `computeMembershipId(workspaceId, callerUid)`), and the proposed new Owner's membership (at `computeMembershipId(workspaceId, newOwnerUid)`).

Validation order inside the transaction: Workspace well-formed + `type === "team"` → caller passes `isCanonicalTeamOwnerMembership()` → reject self-transfer → new Owner's membership exists, is bound to this exact workspace/uid, `status === "active"`, `role !== "owner"` → OCC token comparison (see below) → three writes, each with its own precondition:

```
workspace.ownerUserId := newOwnerUid   (createdByUserId untouched)
old-Owner membership.role := "admin"   (status unchanged, still "active")
new-Owner membership.role := "owner"
```

Never exposed as a generic role-mutation path — this is the ONLY way `ownerUserId` can change.

## OCC requirements — the corrected Phase 8A.2 ambiguity

**This is the one substantive correction to the Phase 8A.2 report, made during review, and it is the actual implemented behavior — not merely a stated intention.**

The route (`POST /api/workspaces/[workspaceId]/transfer-ownership`) requires three caller-supplied tokens: `expectedWorkspaceUpdateTime`, `expectedOldOwnerMembershipUpdateTime`, `expectedNewOwnerMembershipUpdateTime`. Parsed via the EXISTING shared `validateUpdateTimeToken()` (`lib/projects/updateTimeToken.ts`) — never a reimplemented parser.

**What would have been wrong, and is NOT what this implementation does:** reading each document's current `snapshot.updateTime` inside the transaction and feeding that freshly-read value back as the `lastUpdateTime` precondition. That only protects the transaction's own read version against a write landing between its read and its commit (a guarantee Firestore's read-set conflict detection already provides for free) — it does **not** enforce that the CALLER's belief about the document, from whenever they last fetched it, was itself still current.

**What this implementation actually does:** the caller-supplied, already-parsed `Timestamp` values are used two ways —

1. An early comparison against the transaction's own freshly-read `snapshot.updateTime`, for a fast, clear rejection in the common case (mirrors `PATCH /api/user/projects/[projectId]`'s identical pattern).
2. The AUTHORITATIVE guarantee: every `tx.update()` call passes the CALLER-SUPPLIED token itself — never a value re-read inside this transaction — as the native Firestore `{lastUpdateTime}` precondition. Firestore evaluates this precondition against the document's actual state at commit time, not at read time. If Firestore internally retries the transaction callback after a concurrent write invalidates its read set, the retried callback re-runs against the SAME caller-supplied tokens (function arguments, never mutated across a retry) — so a stale client belief keeps failing on every retry, not just the first attempt; it can never slip through via a retry re-reading a "fresher" value and using that instead.

Verified by an explicit adversarial test (`lib/firestore/__tests__/workspaceMemberships.spec.ts`, "uses the CALLER-SUPPLIED token as the authoritative precondition, not a freshly-read snapshot value"): a concurrent mutation is injected between the transaction's own read and its write (via a store-level hook, not through the transaction under test); the transaction's own fast-path snapshot comparison would have passed (it still held the caller's original, now-stale value), but the transaction still fails, because the native Firestore precondition is checked against the live store state, which had moved on. Ownership does not move.

## Account lifecycle protections

`checkTeamWorkspaceOwnershipForUid()` (`lib/workspaces/teamOwnerGuard.ts`) — a single-field-equality query (`workspaces.where("ownerUserId","==",uid)`, covered by Firestore's automatic index) followed by an in-memory `type === "team"` filter, deliberately avoiding a new composite index for a low-frequency admin operation. Returns a three-way discriminated result — `{kind: "clear"}`, `{kind: "owns_team_workspace"; workspaceIds}`, or `{kind: "lookup_failed"}` — never a boolean, because "the lookup failed" and "the uid owns nothing" are different facts that must never collapse into the same outcome.

`DELETE`/`PATCH /api/admin/users/[uid]` (existing pre-Phase-8 routes) now consult this guard: permanently deleting, or disabling (`isDisabled: true`), a uid that owns any Team Workspace returns `409 team_workspace_owner` with zero mutation. Re-enabling (`isDisabled: false`) is never blocked — the guard is never even called in that direction.

**FAILS CLOSED on a lookup failure (Phase 8B.1 correction).** A failed Firestore ownership lookup means ownership status is UNKNOWN, and UNKNOWN must never be treated as "clear." Phase 8B's original implementation proceeded with the destructive/disabling action when the lookup failed — a transient Firestore failure could then delete or disable a Team Workspace's sole Owner and leave it administratively ownerless, the exact condition this guard exists to prevent. Phase 8B.1 corrects this: `{kind: "lookup_failed"}` returns `503 team_workspace_ownership_check_failed` and performs zero mutation — neither `adminAuth.deleteUser()`/`adminAuth.updateUser(...disabled:true)` nor the corresponding `users/{uid}` Firestore write is ever reached. The infrastructure failure is logged via `logger.error()`, never exposed to the client as a raw Firestore error.

Ownership is never auto-transferred, no replacement Owner is ever chosen, and no Team resource is ever cascaded — the guard only blocks the destructive/disabling action outright, deferring to a human running the dedicated transfer operation first.

## Invitation architecture — deferred to Phase 8D

`workspaceInvitations`, `workspaceInvitationKeys`, invite creation/revocation/resend/token rotation, acceptance, verified-email enforcement, transactional email integration, and member-invitation UI are all explicitly Phase 8D's scope, not Phase 8B's. No such collection, email provider selection, or email environment variable exists as of Phase 8B. `invitedByUserId` on `WorkspaceMembershipV1` already anticipates this (non-null once real invitations exist) without requiring a schema change later.

## Team API namespace — corrected in Phase 8B.1

**Canonical, frozen (Phase 8A):** `/api/workspaces/{workspaceId}/...` — the Team-Workspace-qualified API root. `POST /api/workspaces` (at the collection root) creates a Team Workspace; `POST /api/workspaces/[workspaceId]/transfer-ownership` performs the dedicated ownership transfer. No `GET`/list endpoint exists yet (deferred — Phase 8B has no UI to serve).

Phase 8B's initial implementation placed these routes under `/api/user/team-workspaces` instead — architecture drift from the frozen namespace, caught in senior review. Because neither route had been deployed, Phase 8B.1 corrected the paths directly rather than preserving an alias, redirect, or compatibility wrapper: the old route tree was deleted outright, with no remaining reference to it anywhere in the codebase. The underlying service/domain logic (`createTeamWorkspace()`, `transferTeamWorkspaceOwnership()`) was unchanged by this correction — only the route file locations and their own path literals moved.

## Review-system integration decision

None made or implied in Phase 8B. `reviews.*` capabilities exist in the frozen matrix above as FUTURE hooks only — no route in this phase reads or enforces them, and the existing human-review/governance pipeline (`lib/governance/`, `runs/{id}/humanReview*`) is entirely untouched. Integrating Team-role-aware review authorization is explicitly Phase 8F's scope.

## Planned indexes — not created in Phase 8B

Per the frozen architecture, four composite indexes are anticipated for later phases, introduced only when the query shape that needs them actually ships:

```
workspaceMemberships:  [uid ASC, status ASC]
workspaceMemberships:  [workspaceId ASC, status ASC]
runs:                  [workspaceId ASC, createdAt DESC, __name__ DESC]
runs:                  [workspaceId ASC, projectId ASC, createdAt DESC, __name__ DESC]
```

Phase 8B introduces no query that needs any of these — every Phase 8B read is either a direct document `.get()` by a deterministic id (no index needed) or the single-field `workspaces.where("ownerUserId","==",uid)` equality query (covered by Firestore's automatic single-field index). `firestore.indexes.json` is unchanged by Phase 8B.

## Known later-phase boundaries

Explicitly NOT implemented in Phase 8B (deferred to 8C+): invitations (8D), member-management UI, Team Projects, Team research-run creation, Team report sharing, Team review integration, Team Workspace UI, the four planned composite indexes above, and a Workspace-scoped member-display-name resolver (the Phase 8A.2 audit found `resolveReviewerDisplayNames()`'s safety assumptions are run-governance-specific and unsafe to reuse for Team member listing — a real replacement is deferred until a member-list API actually exists to need it).
