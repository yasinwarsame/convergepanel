/**
 * Team Video Detail —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/videos/{verificationId}`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I2 — LAYER 1: server route gate + Team chrome
 * context for a Project-filed Team Video verification.
 *
 * Server-gated identically to the sibling Team Claim detail page (same
 * `resolveServerComponentIdentity()` + `resolveWorkspaceAccess()` +
 * `getProject()` + explicit cross-Workspace containment check), plus the
 * capability this page actually needs: `research.read` — the same capability
 * the R5-I1 Video read endpoints require, not `projects.read`, which covers
 * only Project metadata.
 *
 * The Video itself is never read here. `TeamVideoDetailShell` loads it through
 * the canonical R5-I1 endpoint
 * `GET /api/workspaces/{W}/video-verifications/{verificationId}?projectId={P}` —
 * where Video-level Workspace + Project containment is enforced and a mismatch
 * is concealed as absent — and renders it with the shared, presentation-pure
 * `VideoVerificationResultView`.
 *
 * This page never interprets the verification payload, never reads Firestore
 * for the Video, and never calls a Personal verification endpoint.
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

export default function TeamProjectVideoDetailPage({ params }: { params: { workspaceId: string; projectId: string; verificationId: string } }) {
  return <TeamWorkspacePage kind="projectVideoDetail" workspaceId={params.workspaceId} projectId={params.projectId} verificationId={params.verificationId} />;
}
