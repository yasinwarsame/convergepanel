/**
 * TEAM-VERIFICATION-PARITY-R4-I1 — the ONE client-side builder for a Team
 * Claim DETAIL address, and for the R3 read endpoint that backs it.
 *
 * Deliberately byte-for-byte parallel to
 * `lib/workspaces/teamResearchDetailHref.ts`, so the two Team artifact types
 * address identically:
 *
 *   - Project-bound Claim → `/workspace/team/{workspaceId}/projects/{projectId}/claims/{verificationId}`
 *   - Unfiled Claim (`projectId === null`) → `/workspace/team/{workspaceId}/claims/{verificationId}`
 *
 * "Claims" is the frozen Team user-facing term for this collection (a later
 * Team Video parity slice takes "Videos"), so the route segment is `claims`,
 * never `verifications` — the API path keeps the storage name, the browser
 * path keeps the product name.
 *
 * Every dynamic segment is percent-encoded exactly once. A Team-bound Claim is
 * never addressed through a Personal verification URL, and this module accepts
 * no uid, role, capability or caller-supplied return URL: the only inputs are
 * the three identifiers that make up the address.
 *
 * Pure: no React, no network, no storage, no Firestore, no authorization.
 */

export function teamClaimDetailHref(args: { workspaceId: string; projectId: string | null; verificationId: string }): string {
  const workspaceBase = `/workspace/team/${encodeURIComponent(args.workspaceId)}`;
  if (args.projectId === null) {
    return `${workspaceBase}/claims/${encodeURIComponent(args.verificationId)}`;
  }
  return `${workspaceBase}/projects/${encodeURIComponent(args.projectId)}/claims/${encodeURIComponent(args.verificationId)}`;
}

/**
 * The matching R3 read endpoint for a detail address. Project-bound addresses
 * ALWAYS send `?projectId=` so the server enforces Claim-level Project
 * containment (and conceals a mismatch as absent); the Unfiled address sends
 * none, exactly as `teamRunDetailApiUrl()` does for research.
 */
export function teamClaimDetailApiUrl(args: { workspaceId: string; projectId: string | null; verificationId: string }): string {
  const base = `/api/workspaces/${encodeURIComponent(args.workspaceId)}/verifications/${encodeURIComponent(args.verificationId)}`;
  return args.projectId === null ? base : `${base}?projectId=${encodeURIComponent(args.projectId)}`;
}
