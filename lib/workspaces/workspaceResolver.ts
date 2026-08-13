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
  /** The resource's own optional `workspaceId` field. `null`, `undefined`, and `""` are all treated identically as "absent". */
  workspaceId: string | null | undefined;
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
 * `WorkspaceContextResolution`'s own doc comment): once a non-empty
 * `workspaceId` is present AND the flag is enabled, resolution can ONLY
 * return `resolved` or an explicit failure kind — it can never return to
 * `legacy`. A present-but-invalid workspace reference must fail closed,
 * not silently regain the record's legacy ownership semantics.
 */
export function resolveWorkspaceContext(input: ResolveWorkspaceContextInput): WorkspaceContextResolution {
  if (!input.workspacesEnabled) {
    // Global kill switch: not a per-record fallback decision. See
    // WORKSPACES_ENABLED's doc comment in lib/env.ts.
    return { kind: "legacy", context: { mode: "legacy", ownerUserId: input.legacyOwnerUserId } };
  }

  const workspaceId = input.workspaceId;
  if (workspaceId === null || workspaceId === undefined || workspaceId === "") {
    return { kind: "legacy", context: { mode: "legacy", ownerUserId: input.legacyOwnerUserId } };
  }

  const lookup = input.workspaceLookup;
  if (!lookup) {
    // Caller had a non-empty workspaceId but didn't supply a lookup result.
    // Never interpret missing information as permission to fall back to
    // legacy — fail closed and let the caller fix its call site.
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
 * exactly when one is needed (flag enabled AND a non-empty workspaceId was
 * supplied), then delegates to the pure resolver above. Not called by any
 * route in Phase 1.
 */
export async function resolveWorkspaceContextForResource(args: {
  workspaceId: string | null | undefined;
  legacyOwnerUserId: string;
}): Promise<WorkspaceContextResolution> {
  const workspacesEnabled = WORKSPACES_ENABLED;
  const hasWorkspaceId = typeof args.workspaceId === "string" && args.workspaceId.length > 0;

  const workspaceLookup = workspacesEnabled && hasWorkspaceId ? await getWorkspace(args.workspaceId as string) : undefined;

  return resolveWorkspaceContext({
    workspacesEnabled,
    workspaceId: args.workspaceId,
    legacyOwnerUserId: args.legacyOwnerUserId,
    workspaceLookup,
  });
}
