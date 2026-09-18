/**
 * TEAM-VERIFICATION-PARITY-R5-I2 — the ONE client-side builder for a Team Video
 * DETAIL address, and for the R5-I1 read endpoint that backs it.
 *
 * Deliberately parallel to `lib/workspaces/teamClaimDetailHref.ts`, so the three
 * Team artifact types address identically:
 *
 *   - Project-filed Video → `/workspace/team/{workspaceId}/projects/{projectId}/videos/{verificationId}`
 *   - Unfiled Video (`projectId === null`) → `/workspace/team/{workspaceId}/videos/{verificationId}`
 *
 * "Videos" is the frozen Team user-facing term for this collection, so the route
 * segment is `videos`, never `videoVerifications` — the API path keeps the
 * storage name, the browser path keeps the product name.
 *
 * Every dynamic segment is percent-encoded exactly once. A Team-bound Video is
 * never addressed through a Personal verification URL, and this module accepts
 * no uid, role, capability or caller-supplied return URL: the only inputs are
 * the three identifiers that make up the address.
 *
 * Pure: no React, no network, no storage, no Firestore, no authorization.
 */

export function teamVideoDetailHref(args: { workspaceId: string; projectId: string | null; verificationId: string }): string {
  const workspaceBase = `/workspace/team/${encodeURIComponent(args.workspaceId)}`;
  if (args.projectId === null) {
    return `${workspaceBase}/videos/${encodeURIComponent(args.verificationId)}`;
  }
  return `${workspaceBase}/projects/${encodeURIComponent(args.projectId)}/videos/${encodeURIComponent(args.verificationId)}`;
}

/**
 * The matching R5-I1 read endpoint for a detail address. Project-filed addresses
 * ALWAYS send `?projectId=` so the server enforces Video-level Project
 * containment (and conceals a mismatch as absent); the Unfiled address sends
 * none, exactly as `teamClaimDetailApiUrl()` does for Claims.
 */
export function teamVideoDetailApiUrl(args: { workspaceId: string; projectId: string | null; verificationId: string }): string {
  const base = `/api/workspaces/${encodeURIComponent(args.workspaceId)}/video-verifications/${encodeURIComponent(args.verificationId)}`;
  return args.projectId === null ? base : `${base}?projectId=${encodeURIComponent(args.projectId)}`;
}
