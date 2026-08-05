/**
 * Adaptive Synthesis Report, Phase 1 — reportStatus.ts tests. Covers the
 * 8-status model resolved in docs/adaptive-research-export-design.md §4.1/
 * §12 (Unreviewed split, Changes requested as its own status, Owner
 * override composition, Incomplete, and the dormant "pending" enum value).
 */

import { deriveReportStatus, REPORT_STATUS_LABELS } from "@/lib/adaptiveSchema/reportStatus";

describe("deriveReportStatus", () => {
  it("returns Incomplete when persistenceStatus is failed", () => {
    expect(deriveReportStatus({ persistenceStatus: "failed" }).kind).toBe("incomplete");
  });

  it("returns Incomplete when persistenceStatus is omitted_size_limit", () => {
    expect(deriveReportStatus({ persistenceStatus: "omitted_size_limit" }).kind).toBe("incomplete");
  });

  it("returns Incomplete when no humanReview is present at all (no governance record yet)", () => {
    expect(deriveReportStatus({}).kind).toBe("incomplete");
    expect(deriveReportStatus({ humanReview: null }).kind).toBe("incomplete");
  });

  it("returns unreviewed_in_queue when unreviewed and routing says in_queue", () => {
    const status = deriveReportStatus({ humanReview: { status: "unreviewed" }, reviewRouting: "in_queue" });
    expect(status).toEqual({ kind: "unreviewed_in_queue", isOwnerOverride: false });
  });

  it("returns not_reviewed_no_review_configured when unreviewed and routing says not_configured", () => {
    const status = deriveReportStatus({ humanReview: { status: "unreviewed" }, reviewRouting: "not_configured" });
    expect(status.kind).toBe("not_reviewed_no_review_configured");
  });

  it("fails toward unreviewed_in_queue (not a false 'no review configured' claim) when routing is unknown", () => {
    const status = deriveReportStatus({ humanReview: { status: "unreviewed" }, reviewRouting: "unknown" });
    expect(status.kind).toBe("unreviewed_in_queue");
  });

  it("fails toward unreviewed_in_queue when reviewRouting is omitted entirely", () => {
    const status = deriveReportStatus({ humanReview: { status: "unreviewed" } });
    expect(status.kind).toBe("unreviewed_in_queue");
  });

  it("treats the dormant 'pending' enum value identically to 'unreviewed' rather than as Incomplete", () => {
    const status = deriveReportStatus({ humanReview: { status: "pending" }, reviewRouting: "in_queue" });
    expect(status.kind).toBe("unreviewed_in_queue");
  });

  it("maps approved/approved_with_conditions/changes_requested/rejected directly", () => {
    expect(deriveReportStatus({ humanReview: { status: "approved" } }).kind).toBe("approved");
    expect(deriveReportStatus({ humanReview: { status: "changes_requested" } }).kind).toBe("changes_requested");
    expect(deriveReportStatus({ humanReview: { status: "rejected" } }).kind).toBe("rejected");
  });

  it("carries conditions verbatim only for approved_with_conditions", () => {
    const status = deriveReportStatus({
      humanReview: { status: "approved_with_conditions", conditions: ["Confirm the Q3 figure against the 10-K"] },
    });
    expect(status.kind).toBe("approved_with_conditions");
    expect(status.conditions).toEqual(["Confirm the Q3 figure against the 10-K"]);
  });

  it("defaults conditions to an empty array (never undefined) when approved_with_conditions omits it", () => {
    const status = deriveReportStatus({ humanReview: { status: "approved_with_conditions" } });
    expect(status.conditions).toEqual([]);
  });

  it("never attaches conditions to any other status kind", () => {
    expect(deriveReportStatus({ humanReview: { status: "approved" } }).conditions).toBeUndefined();
    expect(deriveReportStatus({ humanReview: { status: "rejected" } }).conditions).toBeUndefined();
  });

  it("flags isOwnerOverride independently of the underlying status", () => {
    const approvedOverride = deriveReportStatus({
      humanReview: { status: "approved", decidedVia: "multi_reviewer_owner_override" },
    });
    expect(approvedOverride).toEqual({ kind: "approved", isOwnerOverride: true });

    const rejectedOverride = deriveReportStatus({
      humanReview: { status: "rejected", decidedVia: "multi_reviewer_owner_override" },
    });
    expect(rejectedOverride.isOwnerOverride).toBe(true);
    expect(rejectedOverride.kind).toBe("rejected");
  });

  it("does not set isOwnerOverride for single_reviewer or multi_reviewer_panel decisions", () => {
    expect(deriveReportStatus({ humanReview: { status: "approved", decidedVia: "single_reviewer" } }).isOwnerOverride).toBe(false);
    expect(deriveReportStatus({ humanReview: { status: "approved", decidedVia: "multi_reviewer_panel" } }).isOwnerOverride).toBe(false);
  });

  it("every status kind has a non-empty display label", () => {
    const status = deriveReportStatus({ humanReview: { status: "approved" } });
    for (const kind of Object.keys(REPORT_STATUS_LABELS) as (keyof typeof REPORT_STATUS_LABELS)[]) {
      expect(REPORT_STATUS_LABELS[kind].length).toBeGreaterThan(0);
    }
    expect(REPORT_STATUS_LABELS[status.kind]).toBe("Reviewed and approved");
  });
});
