/**
 * Phase 3 — Workspace-Aware Writes for New Personal Adaptive Runs.
 *
 * The configuration-safety invariant for `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED`
 * (see lib/env.ts): writing a `workspaceId` onto a new run is unsafe unless
 * `WORKSPACES_ENABLED` (Phase 1's authorization gate) is ALSO true. If writes
 * were enabled while the resolver is disabled, a freshly created
 * Workspace-bound run would immediately become inaccessible to its own
 * owner — `resolveWorkspaceContext()` treats a present `workspaceId` with
 * `WORKSPACES_ENABLED=false` as `workspaces_disabled` (a deny, never a
 * legacy fallback; see workspaceResolver.ts's own doc comment). This
 * function is the single place that invariant is checked — never
 * re-derived inline at the call site.
 */

export type PersonalRunWorkspaceWriteConfigResult = { ok: true } | { ok: false; reason: "workspaces_disabled_but_writes_enabled" };

/**
 * Pure. The full flag matrix:
 *   W=false / RW=false -> ok (writes are off; the mismatch can't occur)
 *   W=false / RW=true  -> INVALID (would create runs the owner can't access)
 *   W=true  / RW=false -> ok (writes are off; safe no matter what W is)
 *   W=true  / RW=true  -> ok (the only combination that safely binds new runs)
 */
export function checkPersonalRunWorkspaceWriteConfiguration(args: {
  workspacesEnabled: boolean;
  writesEnabled: boolean;
}): PersonalRunWorkspaceWriteConfigResult {
  if (args.writesEnabled && !args.workspacesEnabled) {
    return { ok: false, reason: "workspaces_disabled_but_writes_enabled" };
  }
  return { ok: true };
}
