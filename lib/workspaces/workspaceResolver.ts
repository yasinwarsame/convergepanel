/**
 * Workspace Compatibility Foundation, Phase 1 — the single, central
 * server-side resolution layer (per-program-rule: "Do not scatter
 * `if (workspaceId)` logic throughout route handlers"). Mirrors this
 * codebase's established pure-resolver-plus-async-wrapper shape
 * (`lib/governance/adaptiveRunAccess.ts`, whose own `canExport`/
 * `canMutateRun` doc comments explicitly forward-reference folding into
 * "the Workspace-era central capability model" — this module is that
 * model's foundation): `resolveWorkspaceContext()` is pure and takes
 * already-fetched data; `resolveWorkspaceContextForResource()` is the only
 * place that performs the Firestore read, then delegates to the pure
 * function. No route calls either function yet in Phase 1.
 *
 * Not currently called by any route. Exists so later phases (3/4) have a
 * single, already-tested place to call rather than re-deriving this logic
 * per route the way ownership checks are scattered today (five different
 * idioms — see docs/team-workspaces-architecture-audit.md §4).
 */

import "server-only";
import { WORKSPACES_ENABLED } from "@/lib/env";
import { getWorkspace } from "@/lib/firestore/workspaces";
import type { WorkspaceContextResolution } from "./types";

export interface ResolveWorkspaceContextInput {
  /**
   * Explicit, not read internally — keeps this function pure and trivially
   * unit-testable across both flag states without mocking `lib/env`. The
   * async wrapper below supplies the real value from `WORKSPACES_ENABLED`.
   */
  workspacesEnabled: boolean;
  /**
   * The resource's own optional `workspaceId` field. Only `undefined` (the
   * key was never written to the document at all) counts as "absent" and
   * triggers legacy compatibility. `null`, `""`, whitespace-only strings,
   * and non-string values are all treated as a workspace reference that IS
   * present but unusable — they resolve to `workspaces_disabled` or
   * `malformed`, never `legacy`. See `resolveWorkspaceContext()`'s own doc
   * comment for why this distinction matters.
   */
  workspaceId: unknown;
  /** The resource's existing legacy owner field (`userId`/`ownerUid`) — every resource has one today; this is never optional. */
  legacyOwnerUserId: string;
  /**
   * Required whenever `workspaceId` is non-empty AND `workspacesEnabled` is
   * true — the caller's already-fetched result of looking that id up via
   * `getWorkspace()`. This function performs no I/O itself. Omitting this
   * when it's required is a caller bug, not a legacy fallback — see the
   * `malformed` branch below.
   */
  workspaceLookup?: import("@/lib/firestore/workspaces").GetWorkspaceResult;
}

/**
 * Pure. Every input combination maps to a real, named outcome — never a
 * silent "unknown, treat as legacy" branch. Critical invariant (see
 * `WorkspaceContextResolution`'s own doc comment): once `workspaceId` is
 * anything other than `undefined`, resolution can ONLY return `resolved` or
 * an explicit failure kind (`not_found` / `malformed` /
 * `unsupported_workspace_type` / `lookup_failed` / `workspaces_disabled`) —
 * it can NEVER return to `legacy`. A present-but-invalid workspace
 * reference must fail closed, not silently regain the record's legacy
 * ownership semantics. This includes `null` and `""`: a document that
 * explicitly holds `workspaceId: ""` is NOT the same as one that never had
 * the field written at all, and must not be treated as if it were.
 *
 * This is also why presence is checked BEFORE the feature flag, not after:
 * `WORKSPACES_ENABLED` may disable the Workspace subsystem, but it must
 * never cause a resource that has ALREADY committed to workspace-scoped
 * authorization to silently fall back to a different, potentially
 * inconsistent authorization model. The flag can only ever narrow access
 * for such a resource (`workspaces_disabled`, a deny), never widen or
 * redirect it. See docs/workspaces/architecture.md's Feature Flag Safety
 * section — this is the resolver's single most important invariant.
 */
export function resolveWorkspaceContext(input: ResolveWorkspaceContextInput): WorkspaceContextResolution {
  const workspaceId = input.workspaceId;

  if (workspaceId === undefined) {
    // Truly absent — the field was never written to this document. This is
    // the ONLY condition under which legacy compatibility applies,
    // regardless of flag state (there is nothing for the flag to
    // downgrade).
    return { kind: "legacy", context: { mode: "legacy", ownerUserId: input.legacyOwnerUserId } };
  }

  // From here, workspaceId is present in some form (null, "", whitespace,
  // a wrong type, or a real string) — a workspace reference was written,
  // and this can never fold back into "absent"/legacy.
  if (!input.workspacesEnabled) {
    return { kind: "workspaces_disabled" };
  }

  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    // null, "", whitespace-only, or a non-string value — a present but
    // structurally unusable reference. Never trimmed-and-used; rejected
    // outright.
    return { kind: "malformed" };
  }

  const lookup = input.workspaceLookup;
  if (!lookup) {
    // Caller had a workspaceId but didn't supply a lookup result. Never
    // interpret missing information as permission to fall back to legacy —
    // fail closed and let the caller fix its call site.
    return { kind: "malformed" };
  }

  if (lookup.status === "read_failed" || lookup.status === "firestore_unavailable") {
    return { kind: "lookup_failed" };
  }
  if (lookup.status === "not_found") {
    return { kind: "not_found" };
  }
  if (lookup.status === "malformed") {
    return { kind: "malformed" };
  }

  // lookup.status === "found"
  const workspace = lookup.workspace;
  if (workspace.id !== workspaceId || !workspace.ownerUserId) {
    return { kind: "malformed" };
  }
  if (workspace.type !== "personal") {
    // Well-formed data, just not a mode Phase 1 knows how to authorize.
    // See WorkspaceType's doc comment in types.ts.
    return { kind: "unsupported_workspace_type" };
  }

  return {
    kind: "resolved",
    context: { mode: "workspace", workspaceId: workspace.id, workspaceType: "personal", ownerUserId: workspace.ownerUserId },
  };
}

/**
 * The only I/O-performing entry point. Reads `workspaces/{workspaceId}`
 * exactly when a lookup could actually change the outcome (flag enabled AND
 * a structurally usable, non-empty string workspaceId was supplied) — every
 * other combination is resolvable locally by the pure function without a
 * Firestore round-trip. Not called by any route in Phase 1.
 */
export async function resolveWorkspaceContextForResource(args: {
  workspaceId: unknown;
  legacyOwnerUserId: string;
}): Promise<WorkspaceContextResolution> {
  const workspacesEnabled = WORKSPACES_ENABLED;
  const isUsableWorkspaceId = typeof args.workspaceId === "string" && args.workspaceId.trim().length > 0;

  const workspaceLookup = workspacesEnabled && isUsableWorkspaceId ? await getWorkspace(args.workspaceId as string) : undefined;

  return resolveWorkspaceContext({
    workspacesEnabled,
    workspaceId: args.workspaceId,
    legacyOwnerUserId: args.legacyOwnerUserId,
    workspaceLookup,
  });
}
