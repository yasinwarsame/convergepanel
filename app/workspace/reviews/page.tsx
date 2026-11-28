/**
 * Approval Workflow, Phase 9C.1 (corrected 9C.1-R1C) — `GET /workspace/reviews`,
 * server-gated. The first Phase 9 frontend surface. Read-only: no
 * assignment, decision, panel, override, or resubmission control exists
 * anywhere behind this page in this phase.
 *
 * Eligibility is settled BEFORE any Reviews UI renders — never a
 * client-side flash-then-hide, matching `/workspace` and
 * `/workspace/projects`'s own established gating pattern.
 *
 * MULTI-WORKSPACE MODEL (Phase 9C.1-R1C — replaces a real defect, not a
 * design choice being revisited): the product supports a uid holding more
 * than one active Team Workspace membership (reachable today through
 * repeated `POST /api/workspaces` or Workspace-invitation acceptance —
 * both already merged, neither gated against a second membership). This
 * page therefore NEVER silently auto-selects among several — see
 * `resolveViewerTeamWorkspaceSelection()`'s `"none"/"single"/"multiple"`
 * discriminated result:
 *   - `"none"`: concealed `notFound()`.
 *   - `"single"`: unambiguous — that one Workspace is used directly.
 *   - `"multiple"`, no `?workspace=` param: renders
 *     `<WorkspaceReviewsChooser>`, an explicit selection UI. No queue
 *     data is fetched for any Workspace until the caller picks one.
 *   - `?workspace=<id>` present (any cardinality): that EXACT Workspace
 *     is independently revalidated via `resolveTeamRunWorkspaceAccess()`
 *     — a wrong/unrelated/unauthorized id is `notFound()`, never silently
 *     substituted for a different Workspace the caller does happen to
 *     belong to.
 *
 * Gate order (cheapest/most-restrictive first, mirroring
 * `GET /api/workspaces/{workspaceId}/review-queue`'s own documented
 * ordering): identity -> Approval Workflow admission (pure, zero I/O) ->
 * Team Workspace cardinality discovery (bounded) -> [chooser, if
 * ambiguous] -> Team Workspace access + capability check
 * (`resolveTeamRunWorkspaceAccess()`, reused verbatim, same as every
 * other Phase 9 route).
 *
 * Every ineligible case — unauthenticated, Approval Workflow not
 * admitted, no discoverable Team Workspace, an explicit `?workspace=`
 * the caller cannot access, Team Workspace access denied, or insufficient
 * capability — returns the IDENTICAL `notFound()`. The response gives a
 * non-canary authenticated user no signal distinguishing any one of these
 * from "this route doesn't exist," matching every existing Workspace
 * page's own concealment discipline. The multi-Workspace chooser is NOT
 * part of that concealment surface — it only ever renders once identity
 * and Approval Workflow admission have both already succeeded, and it
 * exposes nothing beyond Workspace names the caller is already an active
 * member of.
 *
 * This gate has zero effect on `GET /api/workspaces/{workspaceId}/review-queue`
 * or any other Phase 9 API — all are independent Route Handlers with
 * their own control flow, unaffected by this page's existence.
 *
 * ZCA L-6: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie, rollout
 * admission or workspace data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in the bearer-authorized endpoint named in
 * `components/workspace/PersonalWorkspacePage.tsx` — every closed gate or denial the same 404.
 */

import PersonalWorkspacePage from "@/components/workspace/PersonalWorkspacePage";

export const dynamic = "force-dynamic";

function firstStringParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export default function WorkspaceReviewsPage({ searchParams }: { searchParams: { [key: string]: string | string[] | undefined } }) {
  return <PersonalWorkspacePage kind="reviews" workspace={firstStringParam(searchParams.workspace)} />;
}
