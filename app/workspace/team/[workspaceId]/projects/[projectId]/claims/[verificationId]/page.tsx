/**
 * Team Claim Detail —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/claims/{verificationId}`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I1 — LAYER 1: server route gate + Team chrome
 * context for a Project-filed Team Claim verification.
 *
 * Server-gated identically to the sibling Team research detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check), plus the
 * capability this page actually needs: `research.read` — the same capability
 * the R3 Claim read endpoints require, not `projects.read`, which covers only
 * Project metadata.
 *
 * The Claim itself is never read here. `TeamClaimDetailShell` loads it through
 * the canonical R3 endpoint
 * `GET /api/workspaces/{W}/verifications/{verificationId}?projectId={P}` —
 * where Claim-level Workspace + Project containment is enforced and a mismatch
 * is concealed as absent — and renders it with the shared R2
 * `ClaimVerificationResultView`.
 *
 * This page never interprets the verification payload, never reads Firestore
 * for the Claim, and never calls a Personal verification endpoint.
 *
 * ZCA L-5: this server render is a NEUTRAL shell. It resolves no identity and reads no cookie,
 * workspace or Project data; it names the page kind and passes only URL params. The gate above runs,
 * unchanged in order and outcome, in `GET /api/workspaces/[workspaceId]` (access), `TeamWorkspacePage`
 * (the required capabilities), `GET /api/workspaces/[workspaceId]/projects/[projectId]` (the Project,
 * looked up only after that gate; another Workspace's Project → the same 404) and, for creation pages,
 * the active-status rule — every denial the same 404.
 */

import TeamWorkspacePage from "@/components/workspace/TeamWorkspacePage";

export const dynamic = "force-dynamic";

export default function TeamProjectClaimDetailPage({ params }: { params: { workspaceId: string; projectId: string; verificationId: string } }) {
  return <TeamWorkspacePage kind="projectClaimDetail" workspaceId={params.workspaceId} projectId={params.projectId} verificationId={params.verificationId} />;
}
