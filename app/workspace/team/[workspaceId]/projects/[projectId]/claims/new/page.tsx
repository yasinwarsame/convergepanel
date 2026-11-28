/**
 * New Team Claim — Project-bound —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/claims/new`.
 *
 * TEAM-VERIFICATION-PARITY-R4-I3 — the creation address for a Claim filed in
 * exactly this Project. The route IS the scope: the composer receives the
 * SERVER-RESOLVED Project record and has no picker, so the browser's Project id
 * is never the source of the binding — it is only the address whose Project this
 * gate independently resolves and validates.
 *
 * LAYER 1 gate: identity → Team Workspace access (`lookup_failed` throws, every
 * other denial is a concealed 404) → Team Workspace type → `research.create`
 * (create at all) → `research.organize` (file into a Project — the exact extra
 * capability the POST's Gate 1 and Gate 2 require for a Project-filed create)
 * → `getProject()` (infra failure throws) → Project exists → cross-Workspace
 * containment → Project is `active`.
 *
 * An ARCHIVED Project is a concealed 404 here, not a disabled form: the POST
 * would reject it with `project_archived`, so rendering a composer that cannot
 * succeed would be a dead end. The Claims that already live in an archived
 * Project remain readable through R4-I2's read-only section.
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

export default function TeamProjectClaimCreatePage({ params }: { params: { workspaceId: string; projectId: string } }) {
  return <TeamWorkspacePage kind="projectClaimNew" workspaceId={params.workspaceId} projectId={params.projectId} />;
}
