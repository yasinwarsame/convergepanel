/**
 * Approval Workflow, Phase 9C.1 — pure presentation-mapping tests for the
 * Workspace review queue UI. No rendering — plain function assertions.
 */

import {
  REVIEW_QUEUE_VIEWS,
  DEFAULT_REVIEW_QUEUE_VIEW,
  getReviewQueueViewLabel,
  normalizeReviewQueueView,
  getReviewQueueEmptyStateCopy,
  getReviewStatusLabel,
  getReviewStatusBadgeClass,
  isApprovedWithConditions,
  getAssignmentPresentation,
  getProjectLabel,
  UNFILED_PROJECT_LABEL,
  formatDueDate,
  formatAbsoluteDate,
} from "@/lib/workspaces/reviewQueuePresentation";

describe("view labels and normalization", () => {
  it("default view is assigned_to_me", () => {
    expect(DEFAULT_REVIEW_QUEUE_VIEW).toBe("assigned_to_me");
  });

  it("maps every backend view to a human label, never exposing the raw snake_case value", () => {
    const expected: Record<string, string> = {
      assigned_to_me: "Assigned to me",
      needs_review: "Needs review",
      changes_requested: "Changes requested",
      overdue: "Overdue",
      recently_approved: "Recently approved",
    };
    for (const view of REVIEW_QUEUE_VIEWS) {
      const label = getReviewQueueViewLabel(view);
      expect(label).toBe(expected[view]);
      expect(label).not.toBe(view);
      expect(label).not.toMatch(/_/);
    }
  });

  it("normalizes null/undefined/invalid view params to the default, never forwarding the invalid value", () => {
    expect(normalizeReviewQueueView(null)).toBe("assigned_to_me");
    expect(normalizeReviewQueueView(undefined)).toBe("assigned_to_me");
    expect(normalizeReviewQueueView("not_a_real_view")).toBe("assigned_to_me");
    expect(normalizeReviewQueueView("")).toBe("assigned_to_me");
  });

  it("preserves every valid view unchanged", () => {
    for (const view of REVIEW_QUEUE_VIEWS) {
      expect(normalizeReviewQueueView(view)).toBe(view);
    }
  });

  it("gives each of the five views distinct, non-empty empty-state copy", () => {
    const seen = new Set<string>();
    for (const view of REVIEW_QUEUE_VIEWS) {
      const copy = getReviewQueueEmptyStateCopy(view);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.message.length).toBeGreaterThan(0);
      expect(seen.has(copy.message)).toBe(false);
      seen.add(copy.message);
    }
  });
});

describe("review status presentation", () => {
  it("maps all six statuses to distinct human labels", () => {
    const statuses = ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"];
    const labels = statuses.map(getReviewStatusLabel);
    expect(new Set(labels).size).toBe(statuses.length);
    expect(labels).toEqual(["Awaiting review", "Under review", "Approved", "Approved with conditions", "Changes requested", "Rejected"]);
  });

  it("approved_with_conditions is a distinct label from plain approved", () => {
    expect(getReviewStatusLabel("approved_with_conditions")).not.toBe(getReviewStatusLabel("approved"));
    expect(isApprovedWithConditions("approved_with_conditions")).toBe(true);
    expect(isApprovedWithConditions("approved")).toBe(false);
  });

  it("changes_requested is never confused with rejected or pending in label or class", () => {
    expect(getReviewStatusLabel("changes_requested")).not.toBe(getReviewStatusLabel("rejected"));
    expect(getReviewStatusLabel("changes_requested")).not.toBe(getReviewStatusLabel("pending"));
    expect(getReviewStatusBadgeClass("changes_requested")).not.toBe(getReviewStatusBadgeClass("rejected"));
  });

  it("every status badge class carries visible border/background/text tokens — never color-only via an empty class", () => {
    for (const status of ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"]) {
      const cls = getReviewStatusBadgeClass(status);
      expect(cls.length).toBeGreaterThan(0);
    }
  });

  it("unknown status falls back safely, never throws", () => {
    expect(getReviewStatusLabel("totally_unknown")).toBe("Unknown");
    expect(() => getReviewStatusBadgeClass("totally_unknown")).not.toThrow();
  });
});

describe("assignment presentation", () => {
  it("unassigned -> Unassigned, no secondary label, never 'Never reviewed'", () => {
    const p = getAssignmentPresentation({ state: "unassigned", assignedReviewerDisplayName: null });
    expect(p.label).toBe("Unassigned");
    expect(p.secondaryLabel).toBeNull();
  });

  it("actionable -> displays the resolved reviewer name, never a raw uid", () => {
    const p = getAssignmentPresentation({ state: "actionable", assignedReviewerDisplayName: "Alice Reviewer" });
    expect(p.label).toBe("Alice Reviewer");
    expect(p.tone).toBe("positive");
  });

  it("CRITICAL: stale assignment never presents as a healthy actionable assignment — primary label is always 'Needs reassignment'", () => {
    const p = getAssignmentPresentation({ state: "stale", assignedReviewerDisplayName: "Alice Reviewer" });
    expect(p.label).toBe("Needs reassignment");
    expect(p.label).not.toBe("Alice Reviewer");
    expect(p.tone).toBe("warning");
  });

  it("stale assignment with a resolved former-reviewer name surfaces it only as secondary context", () => {
    const p = getAssignmentPresentation({ state: "stale", assignedReviewerDisplayName: "Alice Reviewer" });
    expect(p.secondaryLabel).toBe("Previously assigned to Alice Reviewer");
  });

  it("stale assignment with no resolvable display name omits the secondary label rather than fabricating one", () => {
    const p = getAssignmentPresentation({ state: "stale", assignedReviewerDisplayName: null });
    expect(p.secondaryLabel).toBeNull();
  });

  it("actionable with an unresolvable display name (foreign/removed identity) falls back to a safe generic label, never null/empty text", () => {
    const p = getAssignmentPresentation({ state: "actionable", assignedReviewerDisplayName: null });
    expect(p.label).toBe("Reviewer unavailable");
  });
});

describe("project presentation", () => {
  it("projectId null -> Unfiled, the established product wording", () => {
    expect(getProjectLabel(null, new Map())).toBe(UNFILED_PROJECT_LABEL);
    expect(UNFILED_PROJECT_LABEL).toBe("Unfiled");
  });

  it("resolvable projectId -> the real Project name, never the raw id", () => {
    const label = getProjectLabel("proj-1", new Map([["proj-1", "Q3 Diligence"]]));
    expect(label).toBe("Q3 Diligence");
    expect(label).not.toBe("proj-1");
  });

  it("unresolvable projectId -> a safe generic fallback, never the raw id", () => {
    const label = getProjectLabel("proj-unknown", new Map());
    expect(label).not.toBe("proj-unknown");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("date presentation", () => {
  it("formats a valid ISO due date as 'Due <Mon D>', never a raw ISO string", () => {
    const label = formatDueDate("2026-08-28T12:00:00.000Z");
    expect(label).toMatch(/^Due /);
    expect(label).not.toContain("T12:00");
  });

  it("null dueAt -> null (caller renders 'No due date'), never 'Invalid date'", () => {
    expect(formatDueDate(null)).toBeNull();
  });

  it("malformed dueAt string -> null, never a crash or 'Invalid date' text", () => {
    expect(formatDueDate("not-a-date")).toBeNull();
  });

  it("formats an absolute date without the 'Due' prefix for updated/reviewed timestamps", () => {
    const label = formatAbsoluteDate("2026-08-28T12:00:00.000Z");
    expect(label).not.toMatch(/^Due /);
    expect(label).not.toBeNull();
  });

  it("null/malformed absolute date -> null, never a fabricated value", () => {
    expect(formatAbsoluteDate(null)).toBeNull();
    expect(formatAbsoluteDate("garbage")).toBeNull();
  });
});
