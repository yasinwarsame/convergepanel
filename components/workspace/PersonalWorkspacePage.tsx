"use client";

/**
 * ZCA L-6 — the client half of the six Personal workspace pages (D-4 #1–#5, #7). Each page's server render
 * is a neutral shell naming its `kind` and passing only URL params; this component asks the matching
 * bearer-authorized endpoint for the page's former Server Component decision and renders the page's
 * existing shell only for a positive answer (every closed gate / denial → the page's `notFound()`).
 *
 *   workspaceHome  /workspace                  gate personal_workspace → WorkspaceShell
 *   projects       /workspace/projects         gate projects           → ProjectsShell
 *   projectDetail  /workspace/projects/[id]    GET /api/user/projects/[id] → ProjectDetailShell { id, name, status }
 *   research       /workspace/research/[id]    gate signed_in          → PersonalResearchDetailShell
 *   reviews        /workspace/reviews          GET /api/user/workspace-reviews-target → chooser | queue shell
 *   teamLanding    /workspace/team             gate team_workspaces    → TeamWorkspacesLanding
 */
import { useAuthorizedResource } from "@/hooks/useAuthorizedResource";
import { AuthorizedPageGate } from "@/components/workspace/AuthorizedPageGate";
import WorkspaceShell from "@/components/workspace/WorkspaceShell";
import ProjectsShell from "@/components/projects/ProjectsShell";
import ProjectDetailShell from "@/components/projects/ProjectDetailShell";
import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";
import WorkspaceReviewQueueShell from "@/components/workspace/WorkspaceReviewQueueShell";
import WorkspaceReviewsChooser from "@/components/workspace/WorkspaceReviewsChooser";
import TeamWorkspacesLanding from "@/components/workspace/TeamWorkspacesLanding";

export type PersonalPageProps =
  | { kind: "workspaceHome" }
  | { kind: "projects" }
  | { kind: "projectDetail"; projectId: string }
  | { kind: "research"; runId: string }
  | { kind: "reviews"; workspace: string | null }
  | { kind: "teamLanding" };

type GateKind = "workspaceHome" | "projects" | "research" | "teamLanding";
export const PERSONAL_PAGE_GATE: Readonly<Record<GateKind, string>> = {
  workspaceHome: "personal_workspace",
  projects: "projects",
  research: "signed_in",
  teamLanding: "team_workspaces",
};

const parseOk = (body: unknown): true | null => (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true ? true : null);

type PersonalProject = { id: string; name: string; status: "active" | "archived" };
function parsePersonalProject(body: unknown): PersonalProject | null {
  if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) return null;
  const p = (body as { project?: Record<string, unknown> }).project;
  if (!p || typeof p.id !== "string" || typeof p.name !== "string" || (p.status !== "active" && p.status !== "archived")) return null;
  return { id: p.id, name: p.name, status: p.status };
}

type ReviewsTarget = { mode: "chooser" } | { mode: "queue"; workspaceId: string; workspaceName: string; hasMultipleWorkspaces: boolean };
function parseReviewsTarget(body: unknown): ReviewsTarget | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return null;
  if (b.mode === "chooser") return { mode: "chooser" };
  if (b.mode === "queue" && typeof b.workspaceId === "string" && typeof b.workspaceName === "string" && typeof b.hasMultipleWorkspaces === "boolean") {
    return { mode: "queue", workspaceId: b.workspaceId, workspaceName: b.workspaceName, hasMultipleWorkspaces: b.hasMultipleWorkspaces };
  }
  return null;
}

export default function PersonalWorkspacePage(props: PersonalPageProps) {
  switch (props.kind) {
    case "projectDetail":
      return <ProjectDetailPage projectId={props.projectId} />;
    case "reviews":
      return <ReviewsPage workspace={props.workspace} />;
    default:
      return <GatedPage page={props} />;
  }
}

function GatedPage({ page }: { page: Extract<PersonalPageProps, { kind: GateKind }> }) {
  const resource = useAuthorizedResource<true>(`/api/user/workspace-ui-gate?gate=${PERSONAL_PAGE_GATE[page.kind]}`, parseOk);
  return (
    <AuthorizedPageGate resource={resource}>
      {() => {
        switch (page.kind) {
          case "workspaceHome":
            return <WorkspaceShell />;
          case "projects":
            return <ProjectsShell />;
          case "research":
            return <PersonalResearchDetailShell runId={page.runId} />;
          case "teamLanding":
            return <TeamWorkspacesLanding />;
        }
      }}
    </AuthorizedPageGate>
  );
}

function ProjectDetailPage({ projectId }: { projectId: string }) {
  const resource = useAuthorizedResource<PersonalProject>(projectId ? `/api/user/projects/${encodeURIComponent(projectId)}` : null, parsePersonalProject);
  return <AuthorizedPageGate resource={resource}>{(project) => <ProjectDetailShell project={project} />}</AuthorizedPageGate>;
}

function ReviewsPage({ workspace }: { workspace: string | null }) {
  const url = `/api/user/workspace-reviews-target${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`;
  const resource = useAuthorizedResource<ReviewsTarget>(url, parseReviewsTarget);
  return (
    <AuthorizedPageGate resource={resource}>
      {(target) =>
        target.mode === "chooser" ? (
          <WorkspaceReviewsChooser />
        ) : (
          <WorkspaceReviewQueueShell workspaceId={target.workspaceId} workspaceName={target.workspaceName} hasMultipleWorkspaces={target.hasMultipleWorkspaces} />
        )
      }
    </AuthorizedPageGate>
  );
}
