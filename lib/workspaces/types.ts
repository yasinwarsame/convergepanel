/**
 * Workspace Compatibility Foundation, Phase 1 — domain types only. No I/O,
 * no route wiring. See docs/workspaces/architecture.md for the full design
 * rationale and docs/team-workspaces-architecture-audit.md for the
 * pre-existing data-model audit this design is built on.
 *
 * Phase 1 defines the shape a Workspace and a workspace-aware resource
 * reference WILL have, and the pure logic to resolve/authorize against
 * them. It does not provision any workspace document, does not add
 * `workspaceId` to any production record, and is not called from any route.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";

/**
 * Both values are part of the domain vocabulary from Phase 1 onward so the
 * `Workspace` document shape never needs a breaking change later. Phase 1
 * through Phase 7's resolvers only ever authorize `"personal"` (see
 * `WorkspaceContext`, still pinned to `"personal"` — Phase 8B's new
 * membership-based resolver, `resolveWorkspaceAccess()`, is the first code
 * to actually authorize `"team"`; see `resolveWorkspaceAccess.ts`).
 */
export type WorkspaceType = "personal" | "team";

/**
 * The Personal Workspace variant — byte-identical shape to every Personal
 * Workspace document written by Phase 1 through Phase 7 (no migration, no
 * new required field). `createdByUserId` deliberately does not exist on
 * this variant: a Personal Workspace has exactly one person associated
 * with it, already fully captured by `ownerUserId`, so a second
 * "who created it" field would be redundant, never additive.
 */
export interface PersonalWorkspaceV1 {
  schemaVersion: 1;
  id: string;
  type: "personal";
  name: string;
  ownerUserId: string;
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}

/**
 * The Team Workspace variant, introduced in Phase 8B. `ownerUserId` is
 * CURRENT administrative ownership — it moves on a successful ownership
 * transfer (see `transferTeamWorkspaceOwnership()`). `createdByUserId` is
 * immutable historical provenance, set once at creation and never mutated
 * by any Phase 8B write path (transfer included) — see
 * `docs/workspaces/phase8-team-workspace-foundation.md`'s "createdByUserId
 * immutability" section for the full invariant and where it's enforced/
 * tested. Both are non-empty uids; `createdByUserId` is required (never
 * optional) specifically for `"team"` — unlike `"personal"`, where the
 * concept doesn't apply.
 */
export interface TeamWorkspaceV1 {
  schemaVersion: 1;
  id: string;
  type: "team";
  name: string;
  ownerUserId: string;
  createdByUserId: string;
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}

/**
 * The Workspace document itself, at `workspaces/{id}`. A discriminated
 * union on `type` — additive over the pre-Phase-8B flat shape: every
 * existing Personal Workspace document in production already satisfies
 * `PersonalWorkspaceV1` byte-for-byte (same required fields, same
 * optional-absent `createdByUserId`), so no migration/backfill is
 * triggered by this change. `type: "team"` is the first variant to
 * require `createdByUserId`.
 */
export type WorkspaceV1 = PersonalWorkspaceV1 | TeamWorkspaceV1;

/**
 * Structural guard for data read back from Firestore — never a blind cast,
 * since resolution security depends on this. Additive over the pre-Phase-8B
 * version: every check that previously applied still applies identically to
 * a Personal document; a Team document additionally requires a non-empty
 * `createdByUserId`.
 *
 * Deliberate runtime-validation compatibility policy:
 * - Strictly validated because they are authorization-relevant:
 *   `schemaVersion` (must be the literal `1`), `id` (non-empty string —
 *   its match against the actual Firestore document id is enforced
 *   separately, in `lib/firestore/workspaces.ts`, at the point of read),
 *   `type` (must be a recognized `WorkspaceType` value), `ownerUserId`
 *   (non-empty string — this is the entire Personal-mode access model, and
 *   the necessary-but-not-sufficient half of the Team Owner invariant — see
 *   `resolveWorkspaceAccess.ts`). For `type: "team"`, `createdByUserId` is
 *   additionally required (non-empty string).
 * - Validated for type only, not further constrained: `name` (must be a
 *   string; emptiness is a display-quality concern, not a security one).
 * - NOT validated at all, deliberately: `createdAt`/`updatedAt`. Neither
 *   field is ever read by the resolver or the access check — only
 *   `id`/`type`/`ownerUserId`/(`createdByUserId` for Team) participate in
 *   any authorization decision — so a malformed timestamp cannot produce an
 *   authorization bug, and rejecting a document over a cosmetic field would
 *   be over-validation for a security boundary.
 * - Unknown/unexpected additional fields on the document are ACCEPTED, not
 *   rejected — an open/forward-compatible schema, matching this
 *   codebase's own convention (`TeamDocument`'s additive-optional-block
 *   pattern) of adding new optional fields without breaking old readers.
 *   This guard only requires that the fields it DOES check are present and
 *   well-typed; it never fails a document merely for having extra keys.
 */
export function isWellFormedWorkspaceV1(data: unknown): data is WorkspaceV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  const baseValid =
    d.schemaVersion === 1 &&
    typeof d.id === "string" &&
    d.id.length > 0 &&
    (d.type === "personal" || d.type === "team") &&
    typeof d.name === "string" &&
    typeof d.ownerUserId === "string" &&
    d.ownerUserId.length > 0;
  if (!baseValid) return false;

  if (d.type === "team") {
    return typeof d.createdByUserId === "string" && d.createdByUserId.length > 0;
  }
  // type === "personal" — createdByUserId is not part of this variant's
  // shape; its presence/absence is never checked either way (forward-
  // compatible with the open-extra-fields policy above).
  return true;
}

/**
 * The resolved identity/ownership context for a single resource — never
 * nullable, never ambiguous. This is NOT an authorization verdict (see
 * `workspaceAccess.ts` for that); it only answers "which ownership model
 * does this resource live under, and who is the owner under that model."
 *
 * Deliberately has no "unauthorized" or "not_found" variant — those are
 * resolution *failures* (`WorkspaceContextResolution` below), not contexts.
 * A `WorkspaceContext` value only ever exists once resolution succeeded.
 */
export type WorkspaceContext =
  | { mode: "legacy"; ownerUserId: string }
  | { mode: "workspace"; workspaceId: string; workspaceType: "personal"; ownerUserId: string };

/**
 * Every way resolution can conclude. Kept as a flat, exhaustive union
 * (never a single generic "failed") so callers — and tests — must handle
 * each case by name. Critical invariant this type exists to enforce:
 * `not_found` / `malformed` / `unsupported_workspace_type` / `lookup_failed`
 * / `workspaces_disabled` are ALL distinct from `legacy` — none of them may
 * ever be treated as "fall back to legacy," because that would let an
 * attacker who forges or corrupts a `workspaceId` reference (or an operator
 * who flips a kill switch) silently regain legacy-style access to a
 * resource that has already committed to workspace-scoped authorization.
 * See docs/workspaces/architecture.md's Error Semantics and Feature Flag
 * Safety sections.
 */
export type WorkspaceContextResolution =
  | { kind: "legacy"; context: Extract<WorkspaceContext, { mode: "legacy" }> }
  | { kind: "resolved"; context: Extract<WorkspaceContext, { mode: "workspace" }> }
  | { kind: "not_found" }
  | { kind: "malformed" }
  | { kind: "unsupported_workspace_type" }
  | { kind: "lookup_failed" }
  | { kind: "workspaces_disabled" };

/** Access verdict for an already-resolved `WorkspaceContext`. Phase 1 has exactly one access rule for both modes: owner-equality. No membership model exists yet for either legacy or personal-workspace resources. */
export type WorkspaceAccessVerdict = { granted: true } | { granted: false; reason: "not_owner" };

/**
 * The combined, route-facing outcome: resolution + access collapsed into
 * one verdict. `reason` covers every way access can be denied, whether the
 * cause was resolution failing or an authenticated-but-wrong-owner request.
 */
export type WorkspaceResourceAccessOutcome =
  | { granted: true; context: WorkspaceContext }
  | {
      granted: false;
      reason: "not_owner" | "workspace_not_found" | "workspace_malformed" | "unsupported_workspace_type" | "lookup_failed" | "workspaces_disabled";
    };

/**
 * Personal Workspace Provisioning, Phase 2 — every way an existing
 * document found at the deterministic `personal-{uid}` id can conflict
 * with what provisioning for THIS uid expects. `malformed` deliberately
 * covers three distinct underlying causes (a structurally invalid
 * document, a document/request id mismatch, and an unsupported
 * `schemaVersion`) because `getWorkspace()` — reused as-is, not
 * re-implemented — already collapses all three into its own single
 * `malformed` status; Phase 2 does not invent a finer split the data
 * layer has no way to actually distinguish. Each underlying cause is
 * still tested individually (see `ensurePersonalWorkspace.spec.ts`), just
 * not surfaced as separate top-level reasons.
 */
export type EnsurePersonalWorkspaceConflictReason = "wrong_owner" | "wrong_type" | "malformed";

/**
 * Never a bare `null`/boolean — every outcome is a named, distinguishable
 * status, per the explicit "do not collapse meaningful failure states"
 * requirement. `created` and `existing` are BOTH success — provisioning
 * is idempotent by design; callers that only care "do I have a workspace
 * now" should treat both as success and read `.workspace`.
 */
export type EnsurePersonalWorkspaceResult =
  | { status: "created"; workspace: WorkspaceV1 }
  | { status: "existing"; workspace: WorkspaceV1 }
  | { status: "disabled" }
  | { status: "invalid_uid" }
  | { status: "conflict"; reason: EnsurePersonalWorkspaceConflictReason }
  | { status: "lookup_failed" }
  | { status: "create_failed" };
