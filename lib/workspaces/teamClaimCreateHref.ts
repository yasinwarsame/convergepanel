/**
 * TEAM-VERIFICATION-PARITY-R4-I3 — the ONE builder for a Team Claim CREATION
 * address.
 *
 * The route IS the creation scope. There is no Workspace or Project picker
 * inside the form, so the address a user arrives at fully determines what will
 * be created:
 *
 *   - `projectId === null` → `/workspace/team/{W}/claims/new` (Unfiled only)
 *   - Project id string    → `/workspace/team/{W}/projects/{P}/claims/new`
 *
 * Deliberately parallel to `teamClaimDetailHref`, so creation and detail share
 * one addressing grammar. Every dynamic segment is percent-encoded exactly
 * once, and no uid, role, capability or caller-supplied return URL is ever
 * accepted — a creation surface must not be steerable by its own link.
 *
 * Pure: no React, no network, no storage, no authorization.
 */

export function teamClaimCreateHref(args: { workspaceId: string; projectId: string | null }): string {
  const workspaceBase = `/workspace/team/${encodeURIComponent(args.workspaceId)}`;
  if (args.projectId === null) {
    return `${workspaceBase}/claims/new`;
  }
  return `${workspaceBase}/projects/${encodeURIComponent(args.projectId)}/claims/new`;
}
