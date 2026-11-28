/**
 * New Team Claim — Unfiled — `GET /workspace/team/{workspaceId}/claims/new`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I3 — the creation address for an Unfiled Team
 * Claim. The route IS the scope: this page can only ever produce a Claim with
 * no Project, and the composer it renders has no Project picker.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.create`.
 *
 * `research.create` is the capability the POST's own Gate 1 and Gate 2 both
 * require, so this page admits exactly the members the server would. It
 * deliberately does NOT require `research.organize` — that is only needed to
 * file a Claim into a Project, which this address never does — and it does not
 * add a second read-side check merely because the result will later be read:
 * every role holding `research.create` already holds `research.read`.
 *
 * Authorization is never derived from a creator, an artifact owner or a role
 * string, and the capability set itself never crosses to the client.
 *
 * ZCA L-4: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie or
 * workspace data; it names the page kind and passes only URL params (and identity-free values). The
 * gate above now runs, unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access;
 * every denial the same 404) and `TeamWorkspacePage` (the required capabilities → the same 404).
 */

import { notFound } from "next/navigation";
import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";
import { parseTeamClaimOriginQuery } from "@/lib/workspaces/teamClaimOriginHandoff";

export const dynamic = "force-dynamic";

export default function TeamUnfiledClaimCreatePage({
  params,
  searchParams,
}: {
  params: { workspaceId: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  // R4-I4 — classify the handoff BEFORE any access work, so a malformed research link can never be
  // quietly downgraded into an unrelated free-text claim form. Identity-free (the query string only),
  // so it stays in the server render (D-4 §1). The source run is deliberately NOT read here.
  const origin = parseTeamClaimOriginQuery(searchParams);
  if (origin.kind === "invalid") {
    notFound();
  }
  return (
    <TeamWorkspacePage kind="claimNew" workspaceId={params.workspaceId} originTarget={origin.kind === "origin" ? origin.target : null} />
  );
}
