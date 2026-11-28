/**
 * Phase 7E-B — `GET /workspace/projects/{projectId}`, server-gated. The
 * canonical assigned-research surface for one Project. Extends the exact
 * gate `/workspace/projects/page.tsx` already establishes (identity ->
 * combined UI+backend eligibility -> canonical Personal Workspace
 * prerequisite) with one additional step: `resolveProjectForOwner()`.
 *
 * Every existing concealment outcome (unauthenticated, ineligible,
 * missing/invalid Workspace, invalid/missing/foreign Project, workspace
 * mismatch) returns the IDENTICAL `notFound()` — same rationale as the
 * top-level page's own doc comment: no signal distinguishing "doesn't
 * exist" from "not yours" from "not eligible."
 *
 * Deliberate deviation from the top-level page's own precedent for
 * exactly one outcome: `resolveProjectForOwner()`'s `lookup_failed`
 * (a genuine, transient Firestore/infrastructure failure) is NOT
 * collapsed into `notFound()` here. Unlike the top-level page — which has
 * no specific resource the caller was trying to reach, so concealing an
 * infrastructure hiccup behind "not found" is harmless — this page has an
 * authorized caller reaching for a specific Project they may legitimately
 * expect to exist. Silently telling them "this project doesn't exist"
 * during a transient outage would be a real defect, not a security
 * property. A thrown Error is caught by the app's existing global
 * `app/error.tsx` boundary — no new error framework is introduced.
 *
 * No new Project-detail GET API — `resolveProjectForOwner()`'s returned
 * `ProjectV1` already supplies everything the header needs (`id`, `name`,
 * `status`); this was a deliberate Phase 6B decision this page simply
 * consumes, not a new capability.
 *
 * ZCA L-6: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie, rollout
 * admission or workspace data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in the bearer-authorized endpoint named in
 * `components/workspace/PersonalWorkspacePage.tsx` — every closed gate or denial the same 404.
 */

import PersonalWorkspacePage from "@/components/workspace/PersonalWorkspacePage";

export const dynamic = "force-dynamic";

export default function ProjectDetailPage({ params }: { params: { projectId: string } }) {
  return <PersonalWorkspacePage kind="projectDetail" projectId={params.projectId} />;
}
