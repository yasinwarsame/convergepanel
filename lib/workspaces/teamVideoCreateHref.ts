/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the ONE client-side builder for a Team
 * Video CREATION address.
 *
 * Deliberately parallel to `lib/workspaces/teamClaimCreateHref.ts`, so the two
 * Team verification artifacts are created at identically shaped addresses:
 *
 *   - Unfiled Video (`projectId === null`) → `/workspace/team/{workspaceId}/videos/new`
 *   - Project-filed Video → `/workspace/team/{workspaceId}/projects/{projectId}/videos/new`
 *
 * THE ROUTE IS THE SCOPE. There is no Project picker anywhere in the Video
 * composer, so the address a user arrives at is the only thing that decides
 * whether the resulting Video is filed — and the server independently
 * re-resolves that Project before it will accept the write.
 *
 * "Videos" is the frozen Team user-facing term, so the segment is `videos`,
 * never `videoVerifications`: the API path keeps the storage name, the browser
 * path keeps the product name.
 *
 * Pure: no React, no network, no storage, no Firestore, no authorization.
 */

export function teamVideoCreateHref(args: { workspaceId: string; projectId: string | null }): string {
  const workspaceBase = `/workspace/team/${encodeURIComponent(args.workspaceId)}`;
  if (args.projectId === null) {
    return `${workspaceBase}/videos/new`;
  }
  return `${workspaceBase}/projects/${encodeURIComponent(args.projectId)}/videos/new`;
}
