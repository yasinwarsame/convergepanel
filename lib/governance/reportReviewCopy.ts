/**
 * Order B, Stage B3: the fixed Report Review copy and vocabulary, safe to import from client components.
 *
 * Imports nothing, so both the server modules (lib/governance/reportReview.ts re-exports these) and the browser UI read the
 * same values. The disclaimer is the owner's exact text (B3 authorization, 2026-11-03). It is never configurable, never
 * replaced by the purpose note, and is shown wherever approval can be requested, recorded, viewed or exported.
 */

export const REPORT_REVIEW_DISCLAIMER =
  "Approval means this report was reviewed and considered acceptable for its stated purpose. It does not verify the factual accuracy of its claims.";

/** D-B1a: the fixed purpose categories. Workflow labels only; never certifications. */
export const REPORT_REVIEW_PURPOSES = Object.freeze(["internal_review", "client_delivery", "publication_review", "other"] as const);
export type ReportReviewPurposeCode = (typeof REPORT_REVIEW_PURPOSES)[number];

export const REPORT_REVIEW_PURPOSE_LABELS: Readonly<Record<ReportReviewPurposeCode, string>> = Object.freeze({
  internal_review: "Internal review",
  client_delivery: "Client delivery",
  publication_review: "Publication review",
  other: "Other",
});

/** D-B1a: optional note, at most 280 characters (counted as Unicode code points). */
export const REPORT_REVIEW_NOTE_MAX_CHARS = 280;

export type ReportReviewStatus = "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

export const REPORT_REVIEW_STATUS_LABELS: Readonly<Record<ReportReviewStatus, string>> = Object.freeze({
  unreviewed: "Awaiting review",
  pending: "Awaiting review",
  approved: "Approved",
  approved_with_conditions: "Approved with conditions",
  changes_requested: "Changes requested",
  rejected: "Rejected",
});

/** The four decisions a reviewer can record (B2 decision contract). */
export const REPORT_REVIEW_DECISION_STATUSES = Object.freeze(["approved", "approved_with_conditions", "changes_requested", "rejected"] as const);
export type ReportReviewDecisionStatus = (typeof REPORT_REVIEW_DECISION_STATUSES)[number];

/** B2 decision limits (enforced by validateDecisionUpdate; mirrored by the decision form). */
export const MAX_DECISION_COMMENT_CHARS = 2000;
export const MAX_DECISION_CONDITIONS = 10;
export const MAX_DECISION_CONDITION_CHARS = 500;

export type ReportReviewIneligibleReason = "governed_run" | "already_submitted" | "already_decided" | "not_complete" | "no_review_information";

/**
 * Why submission is unavailable (design §6, D-B8): the fixed sentences the submit route has returned since B1, now shared
 * with the page so both say exactly the same thing. Reveals nothing beyond what an authorized reader already sees.
 */
export const REPORT_REVIEW_INELIGIBLE_EXPLANATIONS: Readonly<Record<ReportReviewIneligibleReason, string>> = Object.freeze({
  governed_run: "This research already has a review record and uses the standard approval workflow.",
  already_submitted: "This research is already submitted for approval.",
  already_decided: "This research has a completed review. Resubmit it to start a new review cycle.",
  not_complete: "This research isn't finished yet.",
  no_review_information: "This research can't be submitted: it was saved without the information approval review needs.",
});

export function reportReviewStatusLabel(status: string): string {
  return (REPORT_REVIEW_STATUS_LABELS as Record<string, string>)[status] ?? "Unknown status";
}

export function reportReviewPurposeLabel(code: string): string {
  return (REPORT_REVIEW_PURPOSE_LABELS as Record<string, string>)[code] ?? "Unknown purpose";
}

/** The analyses a report-review scope tracks, worded for sentences ("This report does not contain …"). */
export const REPORT_REVIEW_ANALYSIS_LABELS: Readonly<Record<"unifiedAnswer" | "synthesis" | "consensus", string>> = Object.freeze({
  unifiedAnswer: "a Unified Answer",
  consensus: "a consensus summary",
  synthesis: "a synthesis",
});
