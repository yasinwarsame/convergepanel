/**
 * TEAM-VERIFICATION-PARITY-R4-I4 — the ONE durable address for handing a Team
 * Research finding to Team Claim verification.
 *
 *   /workspace/team/{W}/claims/new?originRunId={runId}&originClaimId={claimId}
 *
 * ALWAYS the Workspace-level creation route, even when the source research is
 * currently filed in a Project. The browser is not authoritative for that
 * binding: a run can be reorganized after a link is created or shared, so the
 * handoff carries only the two LOCATORS the server needs, and the POST resolves
 * the authoritative claim text, the current Project and the origin snapshot
 * from `runId` + `claimId` alone. The server-returned `projectId` is what
 * decides the canonical result address.
 *
 * WHAT MAY NOT TRAVEL HERE: claim text (the finding's summary or title),
 * `projectId`, an origin object, uid, role, capability, or any return URL. The
 * whole point of the locator pair is that a forged or stale link cannot assert
 * content, lineage or authority — it can only name something the server will
 * independently re-derive and re-authorize.
 *
 * Pure: no React, no network, no storage, no authorization.
 */

/** The only two values a research→claim handoff may carry. */
export type TeamClaimOriginTarget = {
  runId: string;
  claimId: string;
};

export const ORIGIN_RUN_ID_PARAM = "originRunId";
export const ORIGIN_CLAIM_ID_PARAM = "originClaimId";

export function teamClaimOriginHandoffHref(args: { workspaceId: string; runId: string; claimId: string }): string {
  const params = new URLSearchParams();
  params.set(ORIGIN_RUN_ID_PARAM, args.runId);
  params.set(ORIGIN_CLAIM_ID_PARAM, args.claimId);
  return `/workspace/team/${encodeURIComponent(args.workspaceId)}/claims/new?${params.toString()}`;
}

export type TeamClaimOriginQueryResult =
  /** Neither locator present — ordinary I3 creation. */
  | { kind: "ordinary" }
  /** Exactly one non-empty value for each locator. */
  | { kind: "origin"; target: TeamClaimOriginTarget }
  /**
   * A partial, empty or repeated locator. NEVER silently downgraded to
   * ordinary creation: a broken research handoff must not quietly become an
   * unrelated free-text claim form the user did not ask for.
   */
  | { kind: "invalid" };

type RawParam = string | string[] | undefined;

function single(value: RawParam): string | null | undefined {
  if (value === undefined) return undefined;
  // A repeated query key arrives as an array and is never a valid locator.
  if (Array.isArray(value)) return null;
  return value.length > 0 ? value : null;
}

/** Classifies a creation page's query into exactly one of the three modes. */
export function parseTeamClaimOriginQuery(searchParams: Record<string, RawParam> | undefined): TeamClaimOriginQueryResult {
  const rawRun = searchParams?.[ORIGIN_RUN_ID_PARAM];
  const rawClaim = searchParams?.[ORIGIN_CLAIM_ID_PARAM];

  if (rawRun === undefined && rawClaim === undefined) return { kind: "ordinary" };

  const runId = single(rawRun);
  const claimId = single(rawClaim);
  if (typeof runId !== "string" || typeof claimId !== "string") return { kind: "invalid" };

  return { kind: "origin", target: { runId, claimId } };
}
