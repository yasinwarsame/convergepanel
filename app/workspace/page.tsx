/**
 * Phase 5C — GET /workspace, server-gated. Eligibility is settled BEFORE
 * any Workspace UI renders — never a client-side flash-then-hide. Every
 * ineligible case (unauthenticated, non-canary, global off) returns the
 * identical `notFound()` — the response gives a non-canary authenticated
 * user no signal distinguishing "logged in but not eligible" from "this
 * route doesn't exist."
 *
 * This gate has zero effect on `GET /api/user/workspace` or
 * `GET /api/user/workspace/runs` — both are independent Route Handlers
 * with their own control flow, unaffected by this page's existence.
 *
 * ZCA L-6: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie, rollout
 * admission or workspace data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in the bearer-authorized endpoint named in
 * `components/workspace/PersonalWorkspacePage.tsx` — every closed gate or denial the same 404.
 */

import PersonalWorkspacePage from "@/components/workspace/PersonalWorkspacePage";

export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  return <PersonalWorkspacePage kind="workspaceHome" />;
}
