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
 * `Workspace` document shape never needs a breaking change later, but only
 * "personal" is ever resolvable by this phase's logic (see
 * `WorkspaceContext` below, which pins `workspaceType` to the literal
 * `"personal"`). A `type: "team"` workspace is real future-compatible data
 * shape, not implemented authorization — see `resolveWorkspaceContext()`'s
 * `unsupported_workspace_type` outcome.
 */
export type WorkspaceType = "personal" | "team";

/**
 * The Workspace document itself, at `workspaces/{id}`. Phase 1 defines this
 * shape and reads it (when a `workspaceId` happens to be present on a
 * resource — which never happens yet, since nothing writes one) but never
 * creates, updates, or deletes it. Provisioning is Phase 2.
 */
export interface WorkspaceV1 {
  schemaVersion: 1;
  id: string;
  type: WorkspaceType;
  name: string;
  ownerUserId: string;
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;
}

/** Structural guard for data read back from Firestore — never a blind cast, since resolution security depends on this. Deliberately does NOT check `type === "personal"`; a `"team"` workspace is well-formed data, just not yet resolvable (see `unsupported_workspace_type`). */
export function isWellFormedWorkspaceV1(data: unknown): data is WorkspaceV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.schemaVersion === 1 &&
    typeof d.id === "string" &&
    d.id.length > 0 &&
    (d.type === "personal" || d.type === "team") &&
    typeof d.name === "string" &&
    typeof d.ownerUserId === "string" &&
    d.ownerUserId.length > 0
  );
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
 * are ALL distinct from `legacy` — none of them may ever be treated as
 * "fall back to legacy," because that would let an attacker who forges or
 * corrupts a `workspaceId` reference silently regain legacy-style access to
 * someone else's resource. See docs/workspaces/architecture.md's Error
 * Semantics section.
 */
export type WorkspaceContextResolution =
  | { kind: "legacy"; context: Extract<WorkspaceContext, { mode: "legacy" }> }
  | { kind: "resolved"; context: Extract<WorkspaceContext, { mode: "workspace" }> }
  | { kind: "not_found" }
  | { kind: "malformed" }
  | { kind: "unsupported_workspace_type" }
  | { kind: "lookup_failed" };

/** Access verdict for an already-resolved `WorkspaceContext`. Phase 1 has exactly one access rule for both modes: owner-equality. No membership model exists yet for either legacy or personal-workspace resources. */
export type WorkspaceAccessVerdict = { granted: true } | { granted: false; reason: "not_owner" };

/**
 * The combined, route-facing outcome: resolution + access collapsed into
 * one verdict. `reason` covers every way access can be denied, whether the
 * cause was resolution failing or an authenticated-but-wrong-owner request.
 */
export type WorkspaceResourceAccessOutcome =
  | { granted: true; context: WorkspaceContext }
  | { granted: false; reason: "not_owner" | "workspace_not_found" | "workspace_malformed" | "unsupported_workspace_type" | "lookup_failed" };
