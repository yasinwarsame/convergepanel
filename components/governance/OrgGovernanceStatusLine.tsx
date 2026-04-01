"use client";

/**
 * Org governance status for result surfaces (claim + research): policy-aware, reviewer detail.
 */

import Link from "next/link";
import { useUserPlan } from "@/hooks/useUserPlan";
import { maskEmail } from "@/lib/utils/maskEmail";

export type OrgGovernanceEvalStatus = "approved" | "needs_review" | "blocked";

function formatGovDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function reviewerDisplay(
  email: string | null | undefined,
  uid: string | null | undefined,
  viewerEmail?: string | null
): string {
  const e = email?.trim();
  if (e) {
    if (e.includes("@")) return maskEmail(e, viewerEmail);
    return e;
  }
  const u = uid?.trim();
  if (u) return u.length > 14 ? `${u.slice(0, 10)}…` : u;
  return "Reviewer";
}

type Shell = { wrap: string; dot: string; title: string; titleClass: string };

export function OrgGovernanceStatusLine(props: {
  status: OrgGovernanceEvalStatus | null | undefined;
  /** Use "dark" on slate-950 claim result cards for readable links. */
  theme?: "light" | "dark";
  governanceReviewedByUid?: string | null;
  governanceReviewerEmail?: string | null;
  governanceReviewedAt?: string | null;
  governanceReviewComment?: string | null;
  /** Signed-in user's email; used to unmask their own address when shown as reviewer. */
  viewerEmail?: string | null;
}) {
  const { plan, governanceAssignedReviewerEmail } = useUserPlan();
  const dark = props.theme === "dark";
  const sub = dark ? "text-slate-400" : "text-slate-600";
  const link = dark ? "text-sky-400 hover:text-sky-300" : "text-sky-600 hover:text-sky-700";
  const strong = dark ? "text-slate-100" : "text-slate-800";
  const quote = dark ? "text-slate-300" : "text-slate-700";

  if (plan === "free" || !props.status) {
    return null;
  }

  const hasHumanReview = Boolean(
    props.governanceReviewedByUid?.trim() || props.governanceReviewerEmail?.trim()
  );
  const who = reviewerDisplay(
    props.governanceReviewerEmail,
    props.governanceReviewedByUid,
    props.viewerEmail
  );
  const when = formatGovDate(props.governanceReviewedAt);
  const whenPhrase = when ? ` · ${when}` : "";
  const comment = (props.governanceReviewComment ?? "").trim();

  let shell: Shell;

  if (props.status === "approved") {
    if (hasHumanReview) {
      shell = {
        wrap: dark
          ? "border border-emerald-800/80 border-l-4 border-l-emerald-500 bg-emerald-950/40"
          : "border border-emerald-200 border-l-4 border-l-emerald-500 bg-emerald-50/95",
        dot: "bg-emerald-500",
        title: "Governance: Approved",
        titleClass: dark ? "text-emerald-200" : "text-emerald-900",
      };
    } else {
      shell = {
        wrap: dark
          ? "border border-emerald-800/80 border-l-4 border-l-emerald-500 bg-emerald-950/40"
          : "border border-emerald-200 border-l-4 border-l-emerald-500 bg-emerald-50/95",
        dot: "bg-emerald-500",
        title: "Governance: Approved",
        titleClass: dark ? "text-emerald-200" : "text-emerald-900",
      };
    }
  } else if (props.status === "blocked") {
    shell = {
      wrap: dark
        ? "border border-red-900/80 border-l-4 border-l-red-500 bg-red-950/35"
        : "border border-red-200 border-l-4 border-l-red-500 bg-red-50/95",
      dot: "bg-red-500",
      title: "Governance: Blocked",
      titleClass: dark ? "text-red-200" : "text-red-900",
    };
  } else if (props.status === "needs_review" && hasHumanReview) {
    shell = {
      wrap: dark
        ? "border border-orange-900/70 border-l-4 border-l-orange-500 bg-orange-950/30"
        : "border border-orange-200 border-l-4 border-l-orange-500 bg-orange-50/95",
      dot: "bg-orange-500",
      title: "Governance: Changes Requested",
      titleClass: dark ? "text-orange-200" : "text-orange-950",
    };
  } else {
    shell = {
      wrap: dark
        ? "border border-amber-900/70 border-l-4 border-l-amber-500 bg-amber-950/30"
        : "border border-amber-200 border-l-4 border-l-amber-500 bg-amber-50/95",
      dot: "bg-amber-500",
      title: "Governance: Under Review — a reviewer will assess this result",
      titleClass: dark ? "text-amber-200" : "text-amber-950",
    };
  }

  const metaLine = (): string | null => {
    if (props.status === "approved") {
      if (hasHumanReview) {
        return `Reviewed by ${who}${whenPhrase}`;
      }
      return "Automatically approved by your organization's policy";
    }
    if (props.status === "blocked") {
      if (hasHumanReview) {
        return `Blocked by ${who}${whenPhrase}`;
      }
      return "A reviewer has flagged this result";
    }
    if (props.status === "needs_review" && hasHumanReview) {
      return `Feedback from ${who}${whenPhrase}`;
    }
    return null;
  };

  const meta = metaLine();

  const inner = (
    <div className={`mt-2 rounded-lg p-4 ${shell.wrap}`}>
      <div className="flex gap-3">
        <span
          className={`mt-1 h-3 w-3 shrink-0 rounded-full ${shell.dot}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className={`text-sm font-semibold ${shell.titleClass}`}>{shell.title}</p>
          {meta && <p className={`text-xs ${sub}`}>{meta}</p>}
          {props.status === "needs_review" && !hasHumanReview && (
            <p className={`text-xs ${sub}`}>
              {governanceAssignedReviewerEmail ? (
                <>
                  Your reviewer:{" "}
                  <span className={`font-medium ${strong}`}>
                    {maskEmail(governanceAssignedReviewerEmail, props.viewerEmail)}
                  </span>
                </>
              ) : (
                <>
                  Want someone to review your flagged runs?{" "}
                  <Link href="/profile" className={`font-medium underline ${link}`}>
                    Assign a reviewer in Account settings →
                  </Link>
                </>
              )}
            </p>
          )}
          {comment &&
            (props.status === "approved" ||
              props.status === "blocked" ||
              (props.status === "needs_review" && hasHumanReview)) && (
              <p className={`text-sm italic ${quote}`}>&quot;{comment}&quot;</p>
            )}
        </div>
      </div>
    </div>
  );

  if (plan === "lite") {
    return (
      <div className="mt-1">
        {inner}
        <p className={`mt-2 text-xs ${sub}`}>
          <Link href="/pricing" className={`font-medium underline ${link}`}>
            Governance review is available on the 5-Model plan. Upgrade →
          </Link>
        </p>
      </div>
    );
  }

  return <div className="mt-1">{inner}</div>;
}
