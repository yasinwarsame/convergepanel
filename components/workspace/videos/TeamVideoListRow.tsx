/**
 * TEAM-VERIFICATION-PARITY-R5-I2 — the ONE Team Video list row.
 *
 * Pure presentation: no hooks, no network, no auth, no storage. Shared by the
 * Workspace Videos list and the Project detail Videos section so the two can
 * never drift in what they show or where they link.
 *
 * ROUTING. The destination is built ONLY through `teamVideoDetailHref()`, from
 * the row's own `projectId` — never from the page's current scope or filter
 * state. That is what keeps a Workspace-wide list correct: a row filed in
 * Project P must open at the Project address
 * `/workspace/team/{W}/projects/{P}/videos/{V}`, never at the Unfiled address,
 * because the Unfiled detail route deliberately refuses to paint a filed Video.
 *
 * DISCLOSURE. Renders only the R5-I1 summary DTO's presentation-safe fields.
 * Never the uploader, creator email, membership, capabilities, model evidence,
 * raw metadata, token usage or billing/quota state.
 */

import Link from "next/link";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import { formatAbsoluteDate, UNFILED_PROJECT_LABEL } from "@/lib/workspaces/reviewQueuePresentation";
import { teamVideoDetailHref } from "@/lib/workspaces/teamVideoDetailHref";
import type { TeamVideoListItem, TeamVideoVerdict } from "@/hooks/useTeamVideoVerificationList";

/**
 * Local pure mapping. Compact row labels that stay semantically aligned with
 * `VideoVerificationResultView`'s own verdict titles without copying its longer
 * sentence-style headings — and without editing the shared view, whose text is
 * frozen. `"authentic"` is the historical aggregate label that view still
 * renders, so a stored row carrying it is displayable, not corrupt.
 */
export function teamVideoVerdictLabel(verdict: TeamVideoVerdict): string {
  switch (verdict) {
    case "authentic_captured":
      return "Authentic camera footage";
    case "authentic_produced":
      return "Legitimately produced";
    case "likely_manipulated":
      return "Likely manipulated";
    case "inconclusive":
      return "Inconclusive";
    case "insufficient":
      return "Insufficient data";
    default:
      return "Authentic";
  }
}

function verdictBadgeClass(verdict: TeamVideoVerdict): string {
  const base = "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold";
  switch (verdict) {
    case "authentic_captured":
    case "authentic":
      return `${base} border-emerald-200 bg-emerald-50 text-emerald-800`;
    case "authentic_produced":
      return `${base} border-blue-200 bg-blue-50 text-blue-800`;
    case "likely_manipulated":
      return `${base} border-red-200 bg-red-50 text-red-800`;
    case "inconclusive":
      return `${base} border-amber-200 bg-amber-50 text-amber-900`;
    default:
      return `${base} border-cp-border bg-cp-raised text-cp-muted`;
  }
}

const EVIDENCE_LABEL: Record<TeamVideoListItem["evidenceQuality"], string> = {
  strong: "Strong evidence",
  mixed: "Mixed evidence",
  weak: "Weak evidence",
};

export type TeamVideoListRowProps = {
  workspaceId: string;
  item: TeamVideoListItem;
  /** Workspace-wide lists show which Project a Video is filed in; a Project's own section does not repeat it. */
  showProject: boolean;
};

export function TeamVideoListRow({ workspaceId, item, showProject }: TeamVideoListRowProps) {
  const href = teamVideoDetailHref({ workspaceId, projectId: item.projectId, verificationId: item.verificationId });
  const created = formatAbsoluteDate(item.createdAt);

  return (
    <li className="border-b border-cp-border-soft last:border-b-0">
      <Link
        href={href}
        className="block px-1 py-3 transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        data-testid="team-video-row"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={verdictBadgeClass(item.verdict)}>{teamVideoVerdictLabel(item.verdict)}</span>
          {item.governanceStatus ? <GovernanceChip status={item.governanceStatus} /> : null}
          {created !== null && (
            <span className="text-xs text-cp-faint" data-testid="team-video-row-created">
              {created}
            </span>
          )}
        </div>

        <p className="mt-1.5 text-sm text-cp-text break-words" data-testid="team-video-row-filename">
          {item.fileName}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cp-muted">
          <span data-testid="team-video-row-consensus">{item.consensusScore}/100 consensus</span>
          <span aria-hidden="true">·</span>
          <span data-testid="team-video-row-confidence">{item.confidenceLabel} confidence</span>
          <span aria-hidden="true">·</span>
          <span data-testid="team-video-row-evidence">{EVIDENCE_LABEL[item.evidenceQuality]}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="team-video-row-frames">
            {item.frameCount} {item.frameCount === 1 ? "frame" : "frames"}
          </span>
          {showProject && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="team-video-row-project">{item.project === null ? UNFILED_PROJECT_LABEL : item.project.name}</span>
              {item.project !== null && item.project.status !== "active" && (
                <span className="rounded-full border border-cp-border bg-cp-raised px-1.5 py-0.5 text-[10px] text-cp-faint">Archived</span>
              )}
            </>
          )}
        </div>
      </Link>
    </li>
  );
}
