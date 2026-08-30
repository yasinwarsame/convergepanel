/**
 * Team Workspace Self-Service Onboarding — `GET /workspace/team`,
 * server-gated. The self-service entry point for Team Workspaces:
 * Create Workspace when the caller has none, or a list of their existing
 * Workspaces linking into each one's Members page.
 *
 * Gate is admission-only (`resolveTeamWorkspacesMode()`), deliberately
 * NOT membership-required — unlike `/workspace/reviews`, this page must
 * remain reachable with ZERO Workspace memberships, since it is itself
 * the only path to creating a first one. Matches `/workspace`'s own
 * simple gating pattern (identity -> pure admission check -> render),
 * never a client-side flash-then-hide.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import TeamWorkspacesLanding from "@/components/workspace/TeamWorkspacesLanding";

export const dynamic = "force-dynamic";

export default async function TeamWorkspacesPage() {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const mode = resolveTeamWorkspacesMode({ uid: identity.uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!mode.enabled) {
    notFound();
  }

  return <TeamWorkspacesLanding />;
}
