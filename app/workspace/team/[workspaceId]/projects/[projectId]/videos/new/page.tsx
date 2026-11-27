/**
 * New Team Video — Project-bound —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/videos/new`.
 *
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the creation address for a Video filed in
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
 * would reject the write, so rendering a composer that cannot succeed — after
 * the browser has already spent time extracting frames — would be a dead end.
 * The Videos already filed in an archived Project remain readable through
 * R5-I2's read-only surfaces.
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

export default function TeamProjectVideoCreatePage({ params }: { params: { workspaceId: string; projectId: string } }) {
  return <TeamWorkspacePage kind="projectVideoNew" workspaceId={params.workspaceId} projectId={params.projectId} />;
}
