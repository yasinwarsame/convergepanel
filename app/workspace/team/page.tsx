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
 *
 * ZCA L-6: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie, rollout
 * admission or workspace data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in the bearer-authorized endpoint named in
 * `components/workspace/PersonalWorkspacePage.tsx` — every closed gate or denial the same 404.
 */

import PersonalWorkspacePage from "@/components/workspace/PersonalWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamWorkspacesPage() {
  return <PersonalWorkspacePage kind="teamLanding" />;
}
