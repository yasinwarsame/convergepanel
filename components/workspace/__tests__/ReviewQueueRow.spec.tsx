/**
 * Approval Workflow, Phase 9C.1 — ReviewQueueRow structural rendering
 * tests. Pure/presentational, no fetch/effect — `renderToStaticMarkup`
 * fully exercises it synchronously (same technique as
 * `TeamReviewFilters.spec.tsx`), so full rendered-content assertions are
 * reliable here, not merely a loading-state snapshot.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { join } from "path";
import ReviewQueueRow from "@/components/workspace/ReviewQueueRow";
import type { WorkspaceReviewQueueRow } from "@/lib/client/workspaceReviewQueueClient";

function makeRow(overrides: Partial<WorkspaceReviewQueueRow> = {}): WorkspaceReviewQueueRow {
  return {
    runId: "run-1",
    workspaceId: "ws-1",
    projectId: null,
    runLabel: "What are the top risks in this acquisition?",
    reviewStatus: "unreviewed",
    createdAt: "2026-08-01T00:00:00.000Z",
    reviewedAt: null,
    assignment: { assignedReviewerUserId: null, assignedReviewerDisplayName: null, dueAt: null, state: "unassigned" },
    isAssignedToMe: false,
    isOverdue: false,
    ...overrides,
  };
}

function renderRow(row: WorkspaceReviewQueueRow, projectNameById: ReadonlyMap<string, string> = new Map(), canManageReviews = false): string {
  return renderToStaticMarkup(createElement(ReviewQueueRow, { row, projectNameById, canManageReviews }));
}

describe("ReviewQueueRow — run label and navigation", () => {
  it("renders runLabel as visible text (runId legitimately appears only inside the navigation href, never as its own visible label)", () => {
    const html = renderRow(makeRow({ runId: "run-secret-id", runLabel: "My research question" }));
    expect(html).toContain("My research question");
    expect(html).not.toMatch(/>run-secret-id</);
  });

  it("Phase 9C.1-R1C: navigates to the Workspace-native /workspace/reviews/{runId} route, via a real link, with a generic 'View' action label", () => {
    const html = renderRow(makeRow({ runId: "run-42" }));
    expect(html).toMatch(/href="\/workspace\/reviews\/run-42"/);
    expect(html).toContain(">View<");
  });

  it("Phase 9C.1-R1C: never navigates to the Personal review surface (/reviews/{runId}) or the legacy Team surface (/team/reviews/{runId}) — both reject/misrepresent Workspace-bound runs (R1-confirmed)", () => {
    const html = renderRow(makeRow({ runId: "run-42" }));
    expect(html).not.toMatch(/href="\/reviews\/run-42"/);
    expect(html).not.toMatch(/href="\/team\/reviews\/run-42"/);
  });

  it("a long runLabel renders without crashing (truncation handled visually, not by hard string-slicing)", () => {
    const long = "x".repeat(500);
    expect(() => renderRow(makeRow({ runLabel: long }))).not.toThrow();
  });

  it("empty runLabel falls back to a safe placeholder, never blank/undefined text", () => {
    const html = renderRow(makeRow({ runLabel: "" }));
    expect(html).toContain("Untitled research");
  });
});

describe("ReviewQueueRow — assignee presentation", () => {
  it("unassigned -> 'Unassigned'", () => {
    const html = renderRow(makeRow({ assignment: { assignedReviewerUserId: null, assignedReviewerDisplayName: null, dueAt: null, state: "unassigned" } }));
    expect(html).toContain("Unassigned");
  });

  it("actionable -> the resolved display name, never the raw uid", () => {
    const html = renderRow(makeRow({ assignment: { assignedReviewerUserId: "uid-should-never-render", assignedReviewerDisplayName: "Alice Reviewer", dueAt: null, state: "actionable" } }));
    expect(html).toContain("Alice Reviewer");
    expect(html).not.toContain("uid-should-never-render");
  });

  it("CRITICAL: stale assignment shows 'Needs reassignment', never a healthy 'Assigned to X' presentation", () => {
    const html = renderRow(makeRow({ assignment: { assignedReviewerUserId: "uid-1", assignedReviewerDisplayName: "Alice Reviewer", dueAt: null, state: "stale" } }));
    expect(html).toContain("Needs reassignment");
    expect(html).toContain("Previously assigned to Alice Reviewer");
  });

  it("never renders a raw uid anywhere in the row markup", () => {
    const html = renderRow(
      makeRow({
        assignment: { assignedReviewerUserId: "raw-uid-xyz-789", assignedReviewerDisplayName: "Bob Reviewer", dueAt: null, state: "actionable" },
      })
    );
    expect(html).not.toContain("raw-uid-xyz-789");
  });
});

describe("ReviewQueueRow — review status", () => {
  it("renders the human label for every status, never the raw enum value as visible text", () => {
    for (const status of ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"]) {
      const html = renderRow(makeRow({ reviewStatus: status }));
      expect(html).not.toMatch(new RegExp(`>${status}<`));
    }
  });

  it("approved_with_conditions renders distinctly from plain approved", () => {
    const approved = renderRow(makeRow({ reviewStatus: "approved" }));
    const withConditions = renderRow(makeRow({ reviewStatus: "approved_with_conditions" }));
    expect(approved).toContain("Approved");
    expect(approved).not.toContain("Approved with conditions");
    expect(withConditions).toContain("Approved with conditions");
  });
});

describe("ReviewQueueRow — overdue and due date", () => {
  it("isOverdue renders visible 'Overdue' text, not icon-only", () => {
    const html = renderRow(makeRow({ isOverdue: true, assignment: { assignedReviewerUserId: "u1", assignedReviewerDisplayName: "Alice", dueAt: "2026-01-01T00:00:00.000Z", state: "actionable" } }));
    expect(html).toContain("Overdue");
  });

  it("dueAt null renders 'No due date', never 'Invalid date'", () => {
    const html = renderRow(makeRow({ assignment: { assignedReviewerUserId: null, assignedReviewerDisplayName: null, dueAt: null, state: "unassigned" } }));
    expect(html).toContain("No due date");
    expect(html).not.toContain("Invalid date");
  });

  it("a valid future dueAt renders a 'Due <date>' label", () => {
    const html = renderRow(makeRow({ assignment: { assignedReviewerUserId: "u1", assignedReviewerDisplayName: "Alice", dueAt: "2099-01-01T00:00:00.000Z", state: "actionable" } }));
    expect(html).toMatch(/Due /);
  });
});

describe("ReviewQueueRow — project presentation", () => {
  it("projectId null -> 'Unfiled'", () => {
    const html = renderRow(makeRow({ projectId: null }));
    expect(html).toContain("Unfiled");
  });

  it("resolvable projectId -> the real Project name, never the raw id", () => {
    const html = renderRow(makeRow({ projectId: "proj-secret-id" }), new Map([["proj-secret-id", "Q3 Diligence"]]));
    expect(html).toContain("Q3 Diligence");
    expect(html).not.toContain("proj-secret-id");
  });
});

describe("ReviewQueueRow — read-only invariant (Phase 9C.1 §69, mandatory)", () => {
  const PROHIBITED_CONTROL_TEXT = [">Assign<", ">Reassign<", ">Remove assignment<", ">Review<", ">Approve<", ">Reject<", ">Request changes<", ">Resubmit<", ">Start panel<", ">Configure panel<", ">Vote<", ">Finalize<", ">Cancel panel<", ">Override<"];

  it("renders no mutation control, even when canManageReviews is true", () => {
    const html = renderRow(
      makeRow({ assignment: { assignedReviewerUserId: "u1", assignedReviewerDisplayName: "Alice", dueAt: null, state: "stale" } }),
      new Map(),
      /* canManageReviews */ true
    );
    for (const text of PROHIBITED_CONTROL_TEXT) {
      expect(html).not.toContain(text);
    }
  });

  it("renders exactly one interactive element per layout branch (the View link) — no nested buttons/forms", () => {
    const html = renderRow(makeRow());
    const buttonCount = (html.match(/<button/g) ?? []).length;
    const formCount = (html.match(/<form/g) ?? []).length;
    expect(buttonCount).toBe(0);
    expect(formCount).toBe(0);
  });

  it("source-level: the component file never imports a mutation client/service", () => {
    const source = readFileSync(join(__dirname, "..", "ReviewQueueRow.tsx"), "utf8");
    expect(source).not.toMatch(/review-assignment|review-decision|review-resubmit|review-panel|review-override/);
    expect(source).not.toMatch(/onClick=\{.*(assign|approve|reject|vote|finalize|override)/i);
  });
});
