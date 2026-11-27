/**
 * Phase 7B — GET /workspace/projects, server-gated. Eligibility is
 * settled BEFORE any Projects UI renders — never a client-side
 * flash-then-hide.
 *
 * Gate order (cheapest checks first): authenticated identity -> combined
 * Projects UI+backend rollout eligibility -> canonical Personal Workspace
 * prerequisite (Phase 7B.1). A Firestore Workspace lookup is only ever
 * attempted once both inexpensive rollout checks have already passed —
 * an anonymous, UI-ineligible, or backend-ineligible caller never
 * triggers it.
 *
 * Every ineligible case at any gate — unauthenticated, UI-ineligible,
 * backend-ineligible, missing/malformed/embedded-ID-mismatched/wrong-
 * owner/wrong-type Workspace, or a Workspace resolver infrastructure
 * failure — returns the IDENTICAL `notFound()`. The response gives an
 * ineligible authenticated user no signal distinguishing "logged in but
 * not eligible" from "this route doesn't exist," and no signal about
 * which specific gate (rollout cohort membership, or Workspace state)
 * they failed. `/workspace` itself does not impose this same Workspace
 * prerequisite — that is a deliberate, narrower contract for that route,
 * not a precedent this page needs to match; Projects are specifically
 * organization *inside* a canonical Personal Workspace, so an account
 * without one must never receive a Projects shell that every subsequent
 * Project API would then reject anyway.
 *
 * `resolvePersonalWorkspaceForOwner()` is reused verbatim — the same
 * canonical resolver `GET /api/user/workspace` and Phase 7A's
 * `GET /api/user/project-runs` already use — never a second,
 * independently-maintained Workspace validity check. This is a READ
 * prerequisite only: this page never provisions a Personal Workspace
 * (`ensurePersonalWorkspace()`/`createPersonalWorkspace()`/`.create()`
 * are never called here), and still never fetches Project/run data or
 * queries `projects`/`runs`/`projectEvents` directly — Phase 7B remains
 * eligibility, routing, navigation, and rendering only; Phase 7B.1 adds
 * exactly one additional read (the Workspace prerequisite itself), never
 * a data-fetching one.
 *
 * This gate has zero effect on any `app/api/user/project*` Route
 * Handler — all are independent, unaffected by this page's existence.
 *
 * ZCA L-6: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie, rollout
 * admission or workspace data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in the bearer-authorized endpoint named in
 * `components/workspace/PersonalWorkspacePage.tsx` — every closed gate or denial the same 404.
 */

import PersonalWorkspacePage from "@/components/workspace/PersonalWorkspacePage";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  return <PersonalWorkspacePage kind="projects" />;
}
