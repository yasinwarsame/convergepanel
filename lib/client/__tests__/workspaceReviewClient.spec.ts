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
  buildPanelPutRequest,
  buildPanelDeleteRequest,
  buildPanelVoteRequest,
  buildPanelFinalizeRequest,
  buildOverrideRequest,
  currentPanelRevision,
  hasUsableDecisionReceipt,
  type WorkspaceReviewContext,
  type ReviewContextPanelInfo,
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

// ============================================
// Phase 9C.3 — panel OCC. A THIRD independent concurrency domain
// alongside assignmentRevision and governanceUpdatedAt.
// ============================================

function makePanel(overrides: Partial<ReviewContextPanelInfo> = {}): ReviewContextPanelInfo {
  return {
    status: "open",
    revision: 1,
    reviewers: [
      { uid: "r1", displayName: "Alice" },
      { uid: "r2", displayName: "Bob" },
    ],
    voteSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    finalizedAt: null,
    ...overrides,
  };
}

describe("currentPanelRevision — panel=null is UNAMBIGUOUS (never created), unlike the assignment case", () => {
  it("panel=null -> 0", () => {
    expect(currentPanelRevision({ panel: null })).toBe(0);
  });
  it("panel present -> panel.revision, regardless of status", () => {
    expect(currentPanelRevision({ panel: makePanel({ revision: 5, status: "open" }) })).toBe(5);
    expect(currentPanelRevision({ panel: makePanel({ revision: 5, status: "cancelled" }) })).toBe(5);
    expect(currentPanelRevision({ panel: makePanel({ revision: 5, status: "finalized" }) })).toBe(5);
  });
});

describe("buildPanelPutRequest — create (panel=null) and reconfigure (panel present) share one builder", () => {
  it("create: no panel exists -> expectedRevision=0", () => {
    const body = buildPanelPutRequest({ panel: null }, ["r1", "r2"]);
    expect(body).toEqual({ reviewerUserIds: ["r1", "r2"], expectedRevision: 0 });
  });
  it("reconfigure: existing open panel at revision 3 -> expectedRevision=3, never 0", () => {
    const body = buildPanelPutRequest({ panel: makePanel({ revision: 3 }) }, ["r1", "r3"]);
    expect(body).toEqual({ reviewerUserIds: ["r1", "r3"], expectedRevision: 3 });
    expect(body.expectedRevision).not.toBe(0);
  });
});

describe("buildPanelDeleteRequest (cancel) — sources revision from the caller-supplied current panel", () => {
  it("expectedRevision = panel.revision", () => {
    expect(buildPanelDeleteRequest({ revision: 12 })).toEqual({ expectedRevision: 12 });
  });
});

describe("buildPanelVoteRequest — panelRevision only, never assignmentRevision or governanceUpdatedAt", () => {
  it("uses the supplied panel revision exactly", () => {
    const body = buildPanelVoteRequest({ revision: 4 }, { status: "approved" });
    expect(body).toEqual({ panelRevision: 4, status: "approved" });
  });
  it("includes comment/conditions only when provided", () => {
    const bare = buildPanelVoteRequest({ revision: 1 }, { status: "changes_requested" });
    expect("comment" in bare).toBe(false);
    const full = buildPanelVoteRequest({ revision: 1 }, { status: "approved_with_conditions", comment: "note", conditions: ["x"] });
    expect(full.comment).toBe("note");
    expect(full.conditions).toEqual(["x"]);
  });
});

describe("buildPanelFinalizeRequest — the TWO-domain builder: panel.revision AND governanceUpdatedAt, never assignmentRevision", () => {
  it("PHASE 9C.3 PRIMARY ACCEPTANCE CRITERION: three deliberately divergent OCC values (assignmentRevision=111, panelRevision=7, governanceUpdatedAt=distinct token) — finalize request contains only its own two, never the assignment one", () => {
    const panel = makePanel({ revision: 7 });
    const review = { status: "unreviewed" as const, reviewedAt: null, governanceUpdatedAt: "distinct-governance-token" };
    // assignmentRevision=111 exists in a full context but is never passed to this builder at all —
    // proves the function signature itself makes cross-wiring structurally impossible, not just
    // "happens not to" for this input.
    const body = buildPanelFinalizeRequest(panel, review);
    expect(body).toEqual({ expectedPanelRevision: 7, expectedGovernanceUpdatedAt: "distinct-governance-token" });
    expect(Object.values(body)).not.toContain(111);
  });
});

describe("Phase 9C.3 — cross-domain OCC separation across all three concurrency tokens", () => {
  it("assignment, panel, and governance builders each use only their own domain even when all three values differ", () => {
    const assignmentRevision = 111;
    const panel = makePanel({ revision: 7 });
    const review = { status: "unreviewed" as const, reviewedAt: null, governanceUpdatedAt: "gov-token-xyz" };

    const assignmentBody = buildAssignmentPutRequest({ assignmentRevision }, { assignedReviewerUserId: "r1", dueAt: null });
    expect(assignmentBody.expectedRevision).toBe(111);

    const panelBody = buildPanelPutRequest({ panel }, ["r1", "r2"]);
    expect(panelBody.expectedRevision).toBe(7);
    expect(panelBody.expectedRevision).not.toBe(111);

    const voteBody = buildPanelVoteRequest({ revision: panel.revision }, { status: "approved" });
    expect(voteBody.panelRevision).toBe(7);
    expect(voteBody.panelRevision).not.toBe(111);

    const finalizeBody = buildPanelFinalizeRequest(panel, review);
    expect(finalizeBody.expectedPanelRevision).toBe(7);
    expect(finalizeBody.expectedGovernanceUpdatedAt).toBe("gov-token-xyz");
    expect(Object.values(finalizeBody)).not.toContain(111);

    const decisionBody = buildDecisionRequest({ review }, { status: "approved" });
    expect(decisionBody.expectedUpdatedAt).toBe("gov-token-xyz");
    expect(Object.values(decisionBody)).not.toContain(111);
    expect(Object.values(decisionBody)).not.toContain(7);

    const resubmitBody = buildResubmitRequest({ review });
    expect(resubmitBody.expectedUpdatedAt).toBe("gov-token-xyz");

    const overrideBody = buildOverrideRequest(panel, review, { status: "approved", justification: "Independently verified." });
    expect(overrideBody.expectedPanelRevision).toBe(7);
    expect(overrideBody.expectedGovernanceUpdatedAt).toBe("gov-token-xyz");
    expect(Object.values(overrideBody)).not.toContain(111);
  });
});

describe("buildOverrideRequest — Phase 9C.4: the SAME two-domain shape as buildPanelFinalizeRequest, verified from the actual backend override route/service contract, never assignmentRevision", () => {
  it("PHASE 9C.4 PRIMARY ACCEPTANCE CRITERION: three deliberately divergent OCC values (assignmentRevision=111, panelRevision=7, governanceUpdatedAt=distinct token) — override request contains only its own two, never the assignment one", () => {
    const panel = makePanel({ revision: 7 });
    const review = { status: "unreviewed" as const, reviewedAt: null, governanceUpdatedAt: "distinct-governance-token" };
    const body = buildOverrideRequest(panel, review, { status: "approved", justification: "Reviewed independently." });
    expect(body).toEqual({ expectedPanelRevision: 7, expectedGovernanceUpdatedAt: "distinct-governance-token", status: "approved", justification: "Reviewed independently." });
    expect(Object.values(body)).not.toContain(111);
  });

  it("omits conditions when not supplied", () => {
    const panel = makePanel({ revision: 1 });
    const review = { status: "unreviewed" as const, reviewedAt: null, governanceUpdatedAt: "gov-1" };
    const body = buildOverrideRequest(panel, review, { status: "rejected", justification: "Not sufficiently sourced." });
    expect("conditions" in body).toBe(false);
  });

  it("includes conditions verbatim when supplied (approved_with_conditions)", () => {
    const panel = makePanel({ revision: 1 });
    const review = { status: "unreviewed" as const, reviewedAt: null, governanceUpdatedAt: "gov-1" };
    const body = buildOverrideRequest(panel, review, { status: "approved_with_conditions", justification: "Approved with conditions.", conditions: ["Verify primary source"] });
    expect(body.conditions).toEqual(["Verify primary source"]);
  });
});

describe("hasUsableDecisionReceipt — 10C.4A-U2 defensive validator (REVIEW_DECISION_UI_REQUIRES_DECISION_RECEIPT)", () => {
  const VALID = {
    conclusion: "x",
    basis: ["a"],
    assumptions: [],
    uncertainties: [],
    limitations: [],
    sources: [],
    sourceBacked: true,
    humanReviewNeeded: false,
  };

  it("accepts a structurally complete receipt", () => {
    expect(hasUsableDecisionReceipt(VALID)).toBe(true);
  });

  it("accepts empty arrays and false booleans — absence of content is not the same as malformed shape", () => {
    expect(hasUsableDecisionReceipt({ ...VALID, basis: [], sourceBacked: false, humanReviewNeeded: false })).toBe(true);
  });

  it.each([null, undefined, "string", 42, [], true])("rejects non-plain-object input: %p", (value) => {
    expect(hasUsableDecisionReceipt(value)).toBe(false);
  });

  it.each(["conclusion", "basis", "assumptions", "uncertainties", "limitations", "sources", "sourceBacked", "humanReviewNeeded"])("rejects a receipt missing the %s field", (field) => {
    const { [field]: _omit, ...rest } = VALID as Record<string, unknown>;
    expect(hasUsableDecisionReceipt(rest)).toBe(false);
  });

  it("rejects wrong field types (conclusion as number, basis as string instead of array)", () => {
    expect(hasUsableDecisionReceipt({ ...VALID, conclusion: 1 })).toBe(false);
    expect(hasUsableDecisionReceipt({ ...VALID, basis: "not-an-array" })).toBe(false);
    expect(hasUsableDecisionReceipt({ ...VALID, sourceBacked: "yes" })).toBe(false);
  });
});
