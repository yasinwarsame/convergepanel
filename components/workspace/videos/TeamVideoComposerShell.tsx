"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the ONE ordinary Team Video composer,
 * serving both creation addresses:
 *
 *   /workspace/team/{W}/videos/new                      → Unfiled
 *   /workspace/team/{W}/projects/{P}/videos/new         → filed in P
 *
 * THE ROUTE IS THE SCOPE. There is deliberately no Workspace or Project picker:
 * the Project comes from the server-resolved record its page gate already
 * authorized, and is shown as fixed text. A form that could change its own
 * destination would be a second, weaker copy of the server's containment.
 *
 * It renders no result. On a validated success it REPLACES the history entry
 * with the canonical R5-I2 detail address, so Back returns to the Videos or
 * Project parent rather than a stale already-submitted form, and the detail
 * page remains the single owner of result rendering.
 *
 * THE UPLOADER IS NOT FORKED. All browser preparation and presentation — file
 * selection, preview, frame extraction, metadata extraction, the legal
 * acknowledgement, quota copy, progress and the single-activation guard — comes
 * from the shared `VideoUploaderSurface` that I3-A extracted from Personal.
 * This shell supplies only the three things a transport owns: whether
 * submission is possible, how to submit, and where success goes.
 *
 * Mutation safety is the hook's (`useTeamVideoVerificationCreate`): synchronous
 * single-flight, no automatic retry except the one provably pre-side-effect 401
 * refresh, and an explicit `outcome_unknown` outcome that tells the user to
 * CHECK before resubmitting rather than implying nothing was created.
 */

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import VideoUploaderSurface from "@/components/verification/VideoUploaderSurface";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { teamVideoDetailHref } from "@/lib/workspaces/teamVideoDetailHref";
import {
  useTeamVideoVerificationCreate,
  type TeamVideoCreateAddress,
  type TeamVideoCreateRejectionCode,
} from "@/hooks/useTeamVideoVerificationCreate";
import type { PreparedVideoUpload, VideoUploadSubmitOutcome } from "@/lib/verification/videoUploadClientContract";

/** What a confirmed Team creation hands to the success path. */
export type TeamVideoCreateSuccess = {
  verificationId: string;
  workspaceId: string;
  projectId: string | null;
};

export type TeamVideoComposerShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
  /** Server-resolved, active, Workspace-contained Project; `null` for the Unfiled address. */
  project: { id: string; name: string } | null;
};

/**
 * Safe, non-disclosing copy for every definite rejection.
 *
 * Membership, capability and Workspace drift are collapsed onto one sentence:
 * the user learns they can no longer create here, never whether something
 * exists. Quota and payload rejections keep their actionable distinctions,
 * because the user can act on those.
 */
export function teamVideoCreateRejectionCopy(code: TeamVideoCreateRejectionCode): string {
  switch (code) {
    case "plan_required":
      return "Video verification is not available on your current plan.";
    case "video_limit_reached":
      return "You've used all your video verifications this month. It resets on the first day of next month.";
    case "run_limit_reached":
      return "You've reached your monthly run limit. Each video verification also uses runs from your allowance.";
    case "model_limit":
      return "Your plan does not allow enough models for this verification.";
    case "rate_limit_exceeded":
      return "You're verifying videos too quickly. Please wait a moment and try again.";
    case "no_frames":
    case "invalid_frame":
      return "Could not use the extracted frames. Try another file or browser.";
    case "too_many_frames":
    case "invalid_metadata":
      return "This video could not be prepared for verification. Try a shorter or different file.";
    case "file_too_large":
      return "File too large. Maximum size is 50MB.";
    case "frame_too_large":
    case "payload_too_large":
      return "Frame data is too large. Try a shorter or lower-resolution video.";
    case "invalid_request":
      return "Invalid request. Ensure the app is updated and try again.";
    case "unauthorized":
    case "auth_error":
      return "Please sign in again to verify a video.";
    // Membership, capability, Workspace and rollout drift — deliberately one
    // indistinguishable sentence.
    case "not_found":
    case "insufficient_capability":
    case "team_workspaces_disabled":
      return "You can no longer create videos in this Workspace.";
  }
}

export default function TeamVideoComposerShell({ workspaceId, workspaceName, showAudit, project }: TeamVideoComposerShellProps) {
  const router = useRouter();
  const { user, authReady } = useAuth();
  const { plan, videoLimit, videoRunsThisMonth, loading: planLoading, refresh } = useUserPlan();

  const address: TeamVideoCreateAddress =
    project === null ? { kind: "workspace", workspaceId } : { kind: "project", workspaceId, projectId: project.id };
  const { submit } = useTeamVideoVerificationCreate({ address });

  // Navigation ownership: a late success must not move a viewer who has already
  // left this form.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * The injected transport seam. It receives the prepared upload UNCHANGED and
   * passes it to the hook, which is the only place Team context is combined
   * with it — and even there only while building the request body.
   */
  const submitPreparedVideo = useCallback(
    async (prepared: PreparedVideoUpload): Promise<VideoUploadSubmitOutcome<TeamVideoCreateSuccess>> => {
      const outcome = await submit(prepared);
      switch (outcome.status) {
        case "ok":
          return {
            status: "ok",
            value: { verificationId: outcome.verificationId, workspaceId: outcome.workspaceId, projectId: outcome.projectId },
          };
        case "rejected":
          return { status: "rejected", message: teamVideoCreateRejectionCopy(outcome.code) };
        case "already_submitting":
          // No request was issued, so this IS a definite non-creation.
          return { status: "rejected", message: "A video verification is already in progress." };
        case "outcome_unknown":
          return { status: "outcome_unknown" };
      }
    },
    [submit]
  );

  /**
   * Navigation happens ONLY here, and only for a confirmed success whose
   * server-authoritative locators match the address this composer was mounted
   * at. A mismatch is not "corrected" by navigating somewhere else.
   */
  const onSuccess = useCallback(
    (value: TeamVideoCreateSuccess) => {
      if (!mountedRef.current) return;
      const expectedProjectId = project === null ? null : project.id;
      if (value.workspaceId !== workspaceId || value.projectId !== expectedProjectId) return;
      router.replace(
        teamVideoDetailHref({ workspaceId: value.workspaceId, projectId: value.projectId, verificationId: value.verificationId })
      );
    },
    [router, workspaceId, project]
  );

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;
  const projectHref = project === null ? null : `${workspaceHref}/projects/${encodeURIComponent(project.id)}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <Breadcrumb
        className="mb-3"
        segments={
          project === null
            ? [{ label: workspaceName, href: workspaceHref }, { label: "Videos", href: `${workspaceHref}/videos` }, { label: "New" }]
            : [
                { label: workspaceName, href: workspaceHref },
                { label: project.name, href: projectHref! },
                { label: "New video" },
              ]
        }
        mobileParent={{ label: project === null ? "Videos" : project.name, href: project === null ? `${workspaceHref}/videos` : projectHref! }}
      />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-cp-text">New video</h1>
        <p className="mt-1 text-sm text-cp-muted">
          {project === null
            ? "This video will be saved to this Workspace and will not be filed in a Project."
            : `This video will be filed in ${project.name}.`}
        </p>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="videos" showAudit={showAudit} />

      {planLoading ? (
        <p className="text-sm text-cp-muted" data-testid="team-video-composer-loading">
          Loading your plan…
        </p>
      ) : (
        <VideoUploaderSurface<TeamVideoCreateSuccess>
          plan={plan ?? "free"}
          videoLimit={videoLimit}
          videoRunsThisMonth={videoRunsThisMonth}
          submissionEnabled={authReady && user != null}
          submitPreparedVideo={submitPreparedVideo}
          onSuccess={onSuccess}
          onUsageRefresh={refresh}
          outcomeUnknownSurface={
            <p>
              We couldn&apos;t confirm whether this video was saved to the Workspace. Check{" "}
              <a className="font-medium underline underline-offset-2" href={`${workspaceHref}/videos`}>
                Videos
              </a>{" "}
              before trying again, so you don&apos;t run it twice.
            </p>
          }
        />
      )}
    </main>
  );
}
