/**
 * Approval Workflow, Phase 9C.2 — workspaceReviewClient.ts tests.
 *
 * The four `build*Request` functions are the ONLY place in the codebase
 * that construct a governance mutation request body from a
 * `WorkspaceReviewContext`. Because they are pure (no I/O, no React), the
 * two acceptance criteria this phase will be scrutinized hardest on are
 * tested here directly with plain objects — no rendering, no mocked
 * fetch, no jsdom (this repo has neither jsdom nor @testing-library/react
 * — see WorkspaceReviewQueueShell.spec.tsx's own doc comment):
 *
 *   1. `expectedRevision` always comes from `context.assignmentRevision`,
 *      NEVER from whether `context.assignment` is null — including the
 *      "cleared assignment loaded directly on page load" fixture
 *      (assignment: null, assignmentRevision: 7), which is the exact
 *      regression Phase 9B.7 fixed at the backend.
 *   2. Assignment OCC (`assignmentRevision`) and governance OCC
 *      (`review.governanceUpdatedAt`) never cross-wire — proven with a
 *      fixture where the two values deliberately differ.
 */

import {
  buildAssignmentPutRequest,
  buildAssignmentDeleteRequest,
  buildDecisionRequest,
  buildResubmitRequest,
  type WorkspaceReviewContext,
} from "@/lib/client/workspaceReviewClient";

function makeContext(overrides: Partial<Pick<WorkspaceReviewContext, "assignment" | "assignmentRevision" | "review">> = {}): Pick<WorkspaceReviewContext, "assignment" | "assignmentRevision" | "review"> {
  return {
    assignment: null,
    assignmentRevision: 0,
    review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "2026-08-01T00:00:00.000Z" },
    ...overrides,
  };
}

describe("buildAssignmentPutRequest — expectedRevision is ALWAYS context.assignmentRevision", () => {
  it("never assigned (assignment=null, assignmentRevision=0): expectedRevision=0", () => {
    const context = makeContext({ assignment: null, assignmentRevision: 0 });
    const body = buildAssignmentPutRequest(context, { assignedReviewerUserId: "reviewer-a", dueAt: null });
    expect(body).toEqual({ assignedReviewerUserId: "reviewer-a", expectedRevision: 0, dueAt: null });
  });

  it("active assignment (assignmentRevision=N): expectedRevision=N, sourced from assignmentRevision not assignment.revision", () => {
    const context = makeContext({
      assignment: { assignedReviewerUserId: "reviewer-a", assignedReviewerDisplayName: "A", revision: 999, assignedAt: null, updatedAt: "x", dueAt: null, state: "actionable" },
      assignmentRevision: 5,
    });
    const body = buildAssignmentPutRequest(context, { assignedReviewerUserId: "reviewer-b", dueAt: null });
    expect(body.expectedRevision).toBe(5);
    expect(body.expectedRevision).not.toBe(999);
  });

  it("PHASE 9C.2 PRIMARY ACCEPTANCE CRITERION: cleared assignment loaded directly on page load (assignment=null, assignmentRevision=7) -> expectedRevision=7, NEVER 0", () => {
    const context = makeContext({ assignment: null, assignmentRevision: 7 });
    const body = buildAssignmentPutRequest(context, { assignedReviewerUserId: "reviewer-b", dueAt: null });
    expect(body.expectedRevision).toBe(7);
    expect(body.expectedRevision).not.toBe(0);
  });

  it("stale assignment (assignment.state=stale, assignmentRevision=9): expectedRevision=9, stale is not treated as a new resource", () => {
    const context = makeContext({
      assignment: { assignedReviewerUserId: "reviewer-a", assignedReviewerDisplayName: "Reviewer unavailable", revision: 9, assignedAt: null, updatedAt: "x", dueAt: null, state: "stale" },
      assignmentRevision: 9,
    });
    const body = buildAssignmentPutRequest(context, { assignedReviewerUserId: "reviewer-b", dueAt: null });
    expect(body.expectedRevision).toBe(9);
  });

  it("dueAt is always sent explicitly (never omitted), including null", () => {
    const context = makeContext({ assignmentRevision: 2 });
    const withDate = buildAssignmentPutRequest(context, { assignedReviewerUserId: "r1", dueAt: "2026-09-01T00:00:00.000Z" });
    expect(withDate.dueAt).toBe("2026-09-01T00:00:00.000Z");
    const withoutDate = buildAssignmentPutRequest(context, { assignedReviewerUserId: "r1", dueAt: null });
    expect(withoutDate.dueAt).toBeNull();
    expect("dueAt" in withoutDate).toBe(true);
  });

  it("never derives expectedRevision from assignment being null/non-null — same assignmentRevision yields same expectedRevision regardless of assignment presentation", () => {
    const nullCtx = makeContext({ assignment: null, assignmentRevision: 3 });
    const activeCtx = makeContext({
      assignment: { assignedReviewerUserId: "x", assignedReviewerDisplayName: "X", revision: 3, assignedAt: null, updatedAt: "x", dueAt: null, state: "actionable" },
      assignmentRevision: 3,
    });
    expect(buildAssignmentPutRequest(nullCtx, { assignedReviewerUserId: "r", dueAt: null }).expectedRevision).toBe(3);
    expect(buildAssignmentPutRequest(activeCtx, { assignedReviewerUserId: "r", dueAt: null }).expectedRevision).toBe(3);
  });
});

describe("buildAssignmentDeleteRequest — expectedRevision is ALWAYS context.assignmentRevision", () => {
  it("active assignment: expectedRevision matches assignmentRevision, not assignment.revision", () => {
    const context = makeContext({
      assignment: { assignedReviewerUserId: "a", assignedReviewerDisplayName: "A", revision: 100, assignedAt: null, updatedAt: "x", dueAt: null, state: "actionable" },
      assignmentRevision: 12,
    });
    expect(buildAssignmentDeleteRequest(context)).toEqual({ expectedRevision: 12 });
  });

  it("clearing an already-cleared state still sources from assignmentRevision (idempotent structurally, backend rejects if actually stale)", () => {
    const context = makeContext({ assignment: null, assignmentRevision: 8 });
    expect(buildAssignmentDeleteRequest(context)).toEqual({ expectedRevision: 8 });
  });
});

describe("buildDecisionRequest / buildResubmitRequest — governance OCC domain, NEVER assignmentRevision", () => {
  it("PHASE 9C.2 SECOND ACCEPTANCE CRITERION: decision request uses review.governanceUpdatedAt even when assignmentRevision holds a different value", () => {
    const context = makeContext({ assignmentRevision: 12, review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "different-token" } });
    const body = buildDecisionRequest(context, { status: "approved" });
    expect(body.expectedUpdatedAt).toBe("different-token");
    expect(body.expectedUpdatedAt).not.toBe(12);
    expect((body as unknown as Record<string, unknown>).expectedUpdatedAt).not.toBe(context.assignmentRevision);
  });

  it("resubmit request uses review.governanceUpdatedAt even when assignmentRevision holds a different value", () => {
    const context = makeContext({ assignmentRevision: 12, review: { status: "changes_requested", reviewedAt: null, governanceUpdatedAt: "different-token" } });
    const body = buildResubmitRequest(context);
    expect(body).toEqual({ expectedUpdatedAt: "different-token" });
  });

  it("decision request never includes an assignmentRevision-shaped field", () => {
    const context = makeContext({ assignmentRevision: 42, review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "gov-token" } });
    const body = buildDecisionRequest(context, { status: "rejected", comment: "no" }) as unknown as Record<string, unknown>;
    expect(body.assignmentRevision).toBeUndefined();
    expect(Object.values(body)).not.toContain(42);
  });

  it("decision request omits comment/conditions when not provided, includes them when provided", () => {
    const context = makeContext();
    const bare = buildDecisionRequest(context, { status: "approved" });
    expect("comment" in bare).toBe(false);
    expect("conditions" in bare).toBe(false);
    const full = buildDecisionRequest(context, { status: "approved_with_conditions", comment: "note", conditions: ["cap table review"] });
    expect(full.comment).toBe("note");
    expect(full.conditions).toEqual(["cap table review"]);
  });
});
