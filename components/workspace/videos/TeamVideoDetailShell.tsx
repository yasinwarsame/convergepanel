"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I2 — the Team Video DETAIL client shell.
 *
 * Rendered by both canonical Team Video addresses after their Server Component
 * has already enforced identity, Team Workspace access and `research.read`:
 *   - `/workspace/team/{W}/projects/{P}/videos/{verificationId}` (`project` given)
 *   - `/workspace/team/{W}/videos/{verificationId}`               (`project` null → Unfiled)
 *
 * It loads the Video ONLY through the canonical R5-I1 endpoint
 * `GET /api/workspaces/{W}/video-verifications/{verificationId}` (with
 * `?projectId=` on a Project address) via `useTeamVideoVerification`, and
 * renders the body with the shared, presentation-pure
 * `VideoVerificationResultView`.
 *
 * PERSONAL BOUNDARY. It never mounts the Personal `VideoVerificationResult`
 * wrapper, never calls `/api/user/...`, `/api/user/run-governance` or
 * `/api/verify-video`, never fetches live governance or reviewer identity, and
 * exposes no memo export, audit-JSON download, clipboard action bar or "Verify
 * another" control — `actionsSurface` is deliberately absent, so the shared
 * view renders nothing in that position. Team export is a later roadmap item,
 * and a local download is not authorization to ship one.
 *
 * GOVERNANCE. `governanceSurface` carries ONLY the already-stored,
 * presentation-safe status from the authorized payload, through the existing
 * pure `GovernanceChip`. There is no live governance lookup.
 *
 * NAVIGATION. A Project Video is addressed beneath its Project, so "Projects"
 * stays the active nav item and the breadcrumb keeps the Project hierarchy. An
 * Unfiled Video's real parent is the Workspace Videos list
 * `/workspace/team/{W}/videos`, so that segment carries its href, the mobile
 * "up one level" affordance points at it, and "Videos" is the active nav item.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import VideoVerificationResultView from "@/components/verification/VideoVerificationResultView";
import { useTeamVideoVerification, type TeamVideoDetailTeam } from "@/hooks/useTeamVideoVerification";
import { formatAbsoluteDate, UNFILED_PROJECT_LABEL } from "@/lib/workspaces/reviewQueuePresentation";

export type TeamVideoDetailShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  verificationId: string;
  /** Server-resolved, Workspace-contained Project for a Project address; `null` for the Unfiled address. */
  project: { id: string; name: string } | null;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
};

const STATE_BOX = "mt-6 rounded-xl border-2 border-cp-border bg-cp-raised p-6";
const BUTTON = "mt-4 rounded-lg bg-cp-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent";

/**
 * The mandatory three-way Project label. A filed Video whose Project could not
 * be resolved is NEVER shown as "Unfiled": the R5-I1 detail route degrades an
 * unresolvable Project to `team.project === null` while keeping
 * `team.projectId`, so only `projectId === null` means genuinely unfiled.
 */
export function teamVideoProjectLabel(team: TeamVideoDetailTeam): string {
  if (team.projectId === null) return UNFILED_PROJECT_LABEL;
  if (team.project === null) return "Project unavailable";
  return team.project.name;
}

export default function TeamVideoDetailShell({ workspaceId, workspaceName, verificationId, project, showAudit }: TeamVideoDetailShellProps) {
  const projectId = project?.id ?? null;
  const { state, retry } = useTeamVideoVerification({ workspaceId, verificationId, expectedProjectId: projectId });

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.kind === "ready") {
      headingRef.current?.focus();
    }
  }, [state.kind]);

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;
  const projectHref = project ? `${workspaceHref}/projects/${encodeURIComponent(project.id)}` : null;
  const videosHref = `${workspaceHref}/videos`;

  const fileName = state.kind === "ready" ? state.payload.fileName : null;
  const team = state.kind === "ready" ? state.team : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      {/*
        Breadcrumb -> heading -> WorkspaceNav -> content. The final segment and
        the heading are the Video itself, which exists only once this address's
        authorized read has returned — so both render only then, never on a
        denied, absent, malformed or transient path.
      */}
      {fileName !== null && (
        <Breadcrumb
          className="mb-3"
          segments={
            project && projectHref
              ? [
                  { label: workspaceName, href: workspaceHref },
                  { label: "Projects", href: `${workspaceHref}/projects` },
                  { label: project.name, href: projectHref },
                  { label: fileName },
                ]
              : [{ label: workspaceName, href: workspaceHref }, { label: "Videos", href: videosHref }, { label: fileName }]
          }
          mobileParent={project && projectHref ? { label: project.name, href: projectHref } : { label: "Videos", href: videosHref }}
        />
      )}

      {fileName !== null && team !== null && (
        <div className="mb-6">
          <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-cp-text break-words focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
            {fileName}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-cp-muted" data-testid="team-video-meta">
            <span data-testid="team-video-project-label">{teamVideoProjectLabel(team)}</span>
            {team.project !== null && team.project.status !== "active" && (
              <span className="rounded-full border border-cp-border bg-cp-raised px-2 py-0.5 text-xs text-cp-faint">Archived</span>
            )}
            {formatAbsoluteDate(team.createdAt) !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="team-video-created-at">{formatAbsoluteDate(team.createdAt)}</span>
              </>
            )}
          </p>
        </div>
      )}

      {/*
        A Project Video keeps the Project hierarchy (Projects stays active); an
        Unfiled Video's parent is the Workspace Videos list.
      */}
      <WorkspaceNav workspaceId={workspaceId} active={project ? "projects" : "videos"} showAudit={showAudit} />

      {state.kind === "loading" && (
        <div role="status" className="mt-6 rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          Loading this video…
        </div>
      )}

      {state.kind === "not_found" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">Video not found.</h2>
          <p className="mt-2 text-sm text-cp-muted">We couldn&apos;t open this video. It may have been removed, moved, or you may not have access to it.</p>
          <Link href={workspaceHref} className="mt-4 inline-block rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
            Back to {workspaceName}
          </Link>
        </section>
      )}

      {state.kind === "forbidden" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">You don&apos;t have permission to view this video</h2>
          <p className="mt-2 text-sm text-cp-muted">Your access to research in this Workspace has changed. Ask a Workspace admin if you think this is a mistake.</p>
          <Link href={workspaceHref} className="mt-4 inline-block rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
            Back to {workspaceName}
          </Link>
        </section>
      )}

      {state.kind === "auth_error" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t verify your session</h2>
          <p className="mt-2 text-sm text-cp-muted">
            Your sign-in could not be confirmed, so we didn&apos;t load this video. This says nothing about the video itself — please sign in again and reopen this page.
          </p>
          <Link href="/login" className={`${BUTTON} inline-block`}>
            Sign in again
          </Link>
        </section>
      )}

      {state.kind === "unavailable" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t load this video</h2>
          <p className="mt-2 text-sm text-cp-muted">Something went wrong on our side. The video hasn&apos;t gone anywhere — please try again.</p>
          <button type="button" onClick={retry} className={BUTTON}>
            Try again
          </button>
        </section>
      )}

      {state.kind === "internal" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">We couldn&apos;t load this video</h2>
          <p className="mt-2 text-sm text-cp-muted">Something went wrong while reading this video. Nothing was changed.</p>
          <button type="button" onClick={retry} className={BUTTON}>
            Try again
          </button>
        </section>
      )}

      {state.kind === "malformed" && (
        <section role="alert" className={STATE_BOX}>
          <h2 className="text-lg font-semibold text-cp-text">This video couldn&apos;t be displayed</h2>
          <p className="mt-2 text-sm text-cp-muted">The saved result for this video couldn&apos;t be read. Nothing was changed.</p>
        </section>
      )}

      {/*
        The shared pure result boundary, mounted directly. `governanceSurface`
        carries ONLY the already-stored status from the authorized payload —
        never a live governance or reviewer lookup. `actionsSurface` is
        deliberately absent, so the shared view renders nothing there.
      */}
      {state.kind === "ready" && (
        <div className="mt-6">
          <VideoVerificationResultView
            data={state.payload}
            governanceSurface={state.payload.governanceStatus ? <GovernanceChip status={state.payload.governanceStatus} /> : undefined}
          />
        </div>
      )}
    </main>
  );
}
