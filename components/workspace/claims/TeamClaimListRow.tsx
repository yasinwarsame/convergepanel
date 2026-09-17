/**
 * TEAM-VERIFICATION-PARITY-R4-I2 — the ONE Team Claim list row.
 *
 * Pure presentation: no hooks, no network, no auth, no storage. Shared by the
 * Workspace Claims list and the Project detail Claims section so the two can
 * never drift in what they show or where they link.
 *
 * ROUTING. The destination is built ONLY through `teamClaimDetailHref()`, from
 * the row's own `projectId`. That is what keeps a Workspace-wide list correct:
 * a row filed in Project P must open at the Project address
 * `/workspace/team/{W}/projects/{P}/claims/{V}`, never at the Unfiled address,
 * because the Unfiled detail route deliberately refuses to paint a filed Claim.
 *
 * DISCLOSURE. Renders only the R3 summary DTO's presentation-safe fields.
 * Never the creator, a reviewer, membership, capabilities, the origin or source
 * run id, model evidence, the audit bundle, token usage or a raw timestamp.
 */

import Link from "next/link";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import { formatAbsoluteDate, UNFILED_PROJECT_LABEL } from "@/lib/workspaces/reviewQueuePresentation";
import { teamClaimDetailHref } from "@/lib/workspaces/teamClaimDetailHref";
import type { TeamClaimListItem, TeamClaimVerdict } from "@/hooks/useTeamClaimVerificationList";

/**
 * Local pure mapping, deliberately NOT `lib/verification/shareText.ts`'s
 * `formatVerdictLabel()`: that is a share-text formatter over a much wider
 * union (video verdicts, model statuses) and renders "Partially True", whereas
 * the Claim detail page this row links to renders "Partially true". Reusing it
 * would make a row disagree with the page it opens. This mapping matches the
 * detail view exactly and changes no verdict semantics.
 */
export function teamClaimVerdictLabel(verdict: TeamClaimVerdict): string {
  switch (verdict) {
    case "confirmed":
      return "Confirmed";
    case "disputed":
      return "Disputed";
    case "partially_true":
      return "Partially true";
    default:
      return "Unverifiable";
  }
}

function verdictBadgeClass(verdict: TeamClaimVerdict): string {
  const base = "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold";
  switch (verdict) {
    case "confirmed":
      return `${base} border-emerald-200 bg-emerald-50 text-emerald-800`;
    case "disputed":
      return `${base} border-red-200 bg-red-50 text-red-800`;
    case "partially_true":
      return `${base} border-amber-200 bg-amber-50 text-amber-900`;
    default:
      return `${base} border-cp-border bg-cp-raised text-cp-muted`;
  }
}

const EVIDENCE_LABEL: Record<TeamClaimListItem["evidenceQuality"], string> = {
  strong: "Strong evidence",
  mixed: "Mixed evidence",
  weak: "Weak evidence",
};

export type TeamClaimListRowProps = {
  workspaceId: string;
  item: TeamClaimListItem;
  /** Workspace-wide lists show which Project a Claim is filed in; a Project's own section does not repeat it. */
  showProject: boolean;
};

export function TeamClaimListRow({ workspaceId, item, showProject }: TeamClaimListRowProps) {
  const href = teamClaimDetailHref({ workspaceId, projectId: item.projectId, verificationId: item.verificationId });
  const created = formatAbsoluteDate(item.createdAt);

  return (
    <li className="border-b border-cp-border-soft last:border-b-0">
      <Link
        href={href}
        className="block px-1 py-3 transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
        data-testid="team-claim-row"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={verdictBadgeClass(item.verdict)}>{teamClaimVerdictLabel(item.verdict)}</span>
          {item.governanceStatus ? <GovernanceChip status={item.governanceStatus} /> : null}
          {created !== null && (
            <span className="text-xs text-cp-faint" data-testid="team-claim-row-created">
              {created}
            </span>
          )}
        </div>

        <p className="mt-1.5 text-sm text-cp-text break-words" data-testid="team-claim-row-claim">
          {item.claim}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cp-muted">
          <span data-testid="team-claim-row-consensus">{item.consensusScore}/100 consensus</span>
          <span aria-hidden="true">·</span>
          <span data-testid="team-claim-row-confidence">{item.confidenceLabel} confidence</span>
          <span aria-hidden="true">·</span>
          <span data-testid="team-claim-row-evidence">{EVIDENCE_LABEL[item.evidenceQuality]}</span>
          {showProject && (
            <>
              <span aria-hidden="true">·</span>
              <span data-testid="team-claim-row-project">{item.project === null ? UNFILED_PROJECT_LABEL : item.project.name}</span>
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
