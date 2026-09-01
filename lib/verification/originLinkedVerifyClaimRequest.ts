/**
 * Evidence Workspace, Phase 11A.4 — the single, auditable choke point for
 * an origin-linked "Verify this claim" request body. Client-safe (no
 * "server-only" — called from app/page.tsx).
 *
 * Deliberately returns EXACTLY the three keys the 11A.3 server contract
 * accepts for origin-linked mode (`{runId, claimId, models}`) — no
 * `claim`, `projectId`, or `origin` key may ever appear here. The
 * authoritative claim text, project lineage, and origin are resolved
 * server-side from `runId`/`claimId` alone; this function exists so that
 * boundary can never be violated by accident at a call site, and so a
 * single test can prove it.
 */

export interface OriginLinkedVerifyClaimRequestBody {
  runId: string;
  claimId: string;
  models: string[];
}

export function buildOriginLinkedVerifyClaimRequestBody(args: {
  runId: string;
  claimId: string;
  models: string[];
}): OriginLinkedVerifyClaimRequestBody {
  return { runId: args.runId, claimId: args.claimId, models: args.models };
}
