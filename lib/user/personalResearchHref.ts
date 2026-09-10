/**
 * PERSONAL-RESEARCH-URL-1 — the single builder for a Personal research run's
 * canonical, durable address.
 *
 * WHY `/workspace/research/...` AND NOT `/research/...`: the shipped 11B.5
 * `resolveWorkspaceNavContext()` classifies Personal context as `"/"`,
 * `"/workspace"`, `startsWith("/workspace/")` or `/reviews…`. A top-level
 * `/research/{id}` would match none of those and the WorkspaceSwitcher would
 * disappear on a Personal report. Living under `/workspace/` makes the route
 * Personal by the existing classifier with zero 11B.5 change.
 *
 * That path placement is NAVIGATION CONTEXT, never product eligibility — the
 * route is deliberately not gated on the Personal Workspace or Projects UI
 * rollout. Someone who can run Personal research must not lose access to their
 * own saved report because a separate UI flag has not reached them.
 *
 * IDENTITY IS THE RUN ID, NOTHING ELSE. No `projectId`: a run moves
 * Unfiled → Project A → Project B → Unfiled, and its address must not move with
 * it — that invariance is what lets a future Add-to-Team promotion name a stable
 * Personal source. No Workspace id, no query parameter, no question/title slug,
 * no remembered selection.
 */

/** The canonical durable address for a persisted Personal research run. */
export function personalResearchHref(runId: string): string {
  return `/workspace/research/${encodeURIComponent(runId)}`;
}

/**
 * True only for a run id that a server actually persisted.
 *
 * `app/page.tsx` carries a local `r-${Date.now()}` fallback for optimistic UI.
 * That value is not an address — canonicalizing to it would mint a URL that
 * resolves to nothing, permanently, in someone's history. A canonical redirect
 * must therefore prove it holds a real server id first.
 */
export function isCanonicalPersonalRunId(runId: unknown): runId is string {
  if (typeof runId !== "string") return false;
  const trimmed = runId.trim();
  if (trimmed.length === 0) return false;
  // The optimistic client-side placeholder, never a persisted identity.
  if (/^r-\d+$/.test(trimmed)) return false;
  return true;
}
