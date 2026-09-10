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

/**
 * PERSONAL-RESEARCH-URL-1-C1 §K — THE ORIGIN-LINKED VERIFY-CLAIM HANDOFF.
 *
 * The canonical report must keep "Verify this claim", and the canonical report is
 * a read surface: it may not own a second claim-verification pipeline. So the
 * affordance hands off to the ESTABLISHED root flow — the same
 * `originLinkedTarget` state `handleVerifyClaimFromFindingClick` enters, whose
 * submission `/api/verify-claim` already resolves and authorizes.
 *
 * THE QUERY CARRIES SELECTORS, NEVER AUTHORIZATION OR CONTENT. Exactly two
 * values: the run id and the server-issued claim id. No claim text (the server
 * owns the authoritative text — a client-supplied one would be a claim the user
 * could edit into something the finding never said), no Project id, no Workspace
 * id, no owner uid, no origin object. A URL is visible, shareable and editable, so
 * anything placed in it must be something the server re-validates from scratch.
 *
 * Returns `null` rather than a partial address when either selector is missing:
 * half a selector pair must never become an origin-linked target.
 */
export function personalResearchVerifyClaimHref(args: {
  runId: unknown;
  claimId: unknown;
}): string | null {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  const claimId = typeof args.claimId === "string" ? args.claimId.trim() : "";
  if (runId.length === 0 || claimId.length === 0) return null;
  return `/?tab=verify&originRunId=${encodeURIComponent(runId)}&originClaimId=${encodeURIComponent(claimId)}`;
}

/**
 * §R — the "Run follow-up" handoff.
 *
 * The root already supports `?tab=research&q=...`, which PRE-FILLS the composer
 * and deliberately does not auto-run: the user should see and confirm a question
 * before spending a run on it. The canonical report reuses that exact contract
 * instead of gaining any execution ability of its own.
 */
export function personalResearchFollowUpHref(question: unknown): string | null {
  if (typeof question !== "string") return null;
  const trimmed = question.trim();
  if (trimmed.length === 0) return null;
  return `/?tab=research&q=${encodeURIComponent(trimmed)}`;
}
