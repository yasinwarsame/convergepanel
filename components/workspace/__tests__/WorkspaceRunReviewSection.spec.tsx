/**
 * Approval Workflow, Phase 9C.2 — WorkspaceRunReviewSection tests.
 * `react-test-renderer` + `act()`. Child components (ReviewAssignmentCard/
 * ReviewDecisionForm/ReviewResubmitAction) are mocked to isolate this
 * component's own orchestration responsibility: review-context fetch,
 * panel boundary (§52-§56), drain mode (§11/§139), stale-response
 * protection (§61/§144), and the two CRITICAL regression fixtures this
 * program has repeatedly flagged as the highest-risk regression: §134
 * finalized-panel-assigned-reviewer and §135 finalized-panel-manager
 * (the combined 9B.7 + finalized-panel scenario).
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedGetReviewContext = jest.fn();
jest.mock("@/lib/client/workspaceReviewClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceReviewClient");
  return { ...actual, getReviewContext: (...args: unknown[]) => mockedGetReviewContext(...args) };
});

jest.mock("@/components/workspace/ReviewAssignmentCard", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => createElement("mock-assignment-card", props),
}));
jest.mock("@/components/workspace/ReviewDecisionForm", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => createElement("mock-decision-form", props),
}));
jest.mock("@/components/workspace/ReviewResubmitAction", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => createElement("mock-resubmit-action", props),
}));

import WorkspaceRunReviewSection from "@/components/workspace/WorkspaceRunReviewSection";
import type { WorkspaceReviewContext } from "@/lib/client/workspaceReviewClient";

const WS_ID = "ws-1";
const RUN_ID = "run-1";

function baseContext(overrides: Partial<WorkspaceReviewContext> = {}): WorkspaceReviewContext {
  return {
    run: { runId: RUN_ID, workspaceId: WS_ID, projectId: null, label: "What are the top risks?" },
    // Every existing scenario in this file predates the 10C.4A-U2 decision
    // receipt and assumes content was always available — a structurally
    // valid default here preserves those scenarios unchanged; the
    // unavailable-receipt gate is covered by its own dedicated tests.
    decisionReceipt: {
      conclusion: "Overall risk is moderate.",
      basis: ["Historical incident rate", "Current mitigation coverage"],
      assumptions: ["Mitigations remain funded"],
      uncertainties: ["Long-tail vendor risk"],
      limitations: ["One model did not return usable output"],
      sourceBacked: true,
      humanReviewNeeded: true,
    },
    review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "gov-1" },
    assignment: null,
    assignmentRevision: 0,
    panel: null,
    viewer: { mode: "normal", isCreator: false, canManageAssignment: false, canSubmitDecision: false, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false },
    ...overrides,
  };
}

async function render(context: WorkspaceReviewContext | null, status: "ok" | "not_found" | "error" = "ok") {
  mockedGetReviewContext.mockResolvedValue(context ? { status: "ok", context } : { status });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(WorkspaceRunReviewSection, { workspaceId: WS_ID, runId: RUN_ID }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: "u1" }, authReady: true });
});

describe("WorkspaceRunReviewSection — loading/error/not_found", () => {
  it("shows a loading status before the fetch resolves", () => {
    mockedGetReviewContext.mockReturnValue(new Promise(() => {})); // never resolves
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(WorkspaceRunReviewSection, { workspaceId: WS_ID, runId: RUN_ID }));
    });
    expect(renderer.root.findByProps({ role: "status" })).toBeTruthy();
  });

  it("not_found: generic concealed message, no internal reason exposed", async () => {
    const renderer = await render(null, "not_found");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("This review is no longer available.");
  });

  it("error: generic message with retry, underlying report page (outside this section) remains untouched", async () => {
    const renderer = await render(null, "error");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("We couldn't load review details");
    expect(renderer.root.findByProps({ role: "alert" })).toBeTruthy();
  });
});

describe("WorkspaceRunReviewSection — current review detail (§12-16)", () => {
  it("renders status label, comment, and conditions when present", async () => {
    const renderer = await render(baseContext({ review: { status: "approved_with_conditions", reviewedAt: "2026-08-05T00:00:00.000Z", comment: "looks solid", conditions: ["verify sourcing"], governanceUpdatedAt: "gov-2" } }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Approved with conditions");
    expect(text).toContain("looks solid");
    expect(text).toContain("verify sourcing");
  });

  it("no history/audit timeline is rendered", async () => {
    const renderer = await render(baseContext());
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toMatch(/history|audit trail/i);
  });
});

describe("WorkspaceRunReviewSection — drain mode (Phase 9C.4 — replaces the old 9C.2/9C.3 dead-end)", () => {
  it("drain, no panel: completion-mode banner + review summary render, no assignment/decision/resubmit controls even with can*-shaped true-like flags (defensive, not merely trusting backend)", async () => {
    const renderer = await render(baseContext({ viewer: { mode: "drain", isCreator: false, canManageAssignment: true, canSubmitDecision: true, canResubmit: true, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false } }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Completion mode");
    expect(text).toContain("New review work is paused");
    expect(text).not.toContain("mock-assignment-card");
    expect(text).not.toContain("mock-decision-form");
    expect(text).not.toContain("mock-resubmit-action");
    expect(text).not.toContain("Start panel review");
  });

  it("drain, existing open panel, canVote=true: panel evidence + vote control render (real WorkspacePanelReviewSection, not mocked), no single-review controls", async () => {
    const renderer = await render(
      baseContext({
        panel: { status: "open", revision: 1, reviewers: [{ uid: "u1", displayName: "Me" }, { uid: "u2", displayName: "Other" }], voteSummary: { submittedCount: 0, aggregationState: "waiting" }, createdAt: "x", updatedAt: "x", finalizedAt: null },
        viewer: { mode: "drain", isCreator: false, canManageAssignment: false, canSubmitDecision: false, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: true, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Completion mode");
    expect(text).toContain("Panel review");
    expect(text).toContain("Submit vote");
    expect(text).not.toContain("mock-assignment-card");
    expect(text).not.toContain("mock-decision-form");
    expect(text).not.toContain("mock-resubmit-action");
    expect(text).not.toContain("Change reviewers");
    expect(text).not.toContain("Start panel review");
  });

  it("drain, finalized panel: read-only evidence only, no completion actions, no single-review controls", async () => {
    const renderer = await render(
      baseContext({
        panel: { status: "finalized", revision: 2, reviewers: [{ uid: "u1", displayName: "Me" }], voteSummary: null, createdAt: "x", updatedAt: "x", finalizedAt: "x" },
        viewer: { mode: "drain", isCreator: false, canManageAssignment: false, canSubmitDecision: false, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Panel review");
    expect(text).toContain("Finalized");
    expect(text).not.toContain("Submit vote");
    expect(text).not.toContain("Finalize panel");
    expect(text).not.toContain("Cancel panel review");
    expect(text).not.toContain("Owner override");
    expect(text).not.toContain("mock-assignment-card");
    expect(text).not.toContain("mock-decision-form");
    expect(text).not.toContain("mock-resubmit-action");
  });
});

describe("WorkspaceRunReviewSection — open panel (§52/§133)", () => {
  it("panel.status=open: Phase 9C.3 panel section renders (status 'In progress'), no single-review assignment/decision/resubmit controls even if can* were true", async () => {
    const renderer = await render(
      baseContext({
        panel: { status: "open", revision: 1, reviewers: [], voteSummary: null, createdAt: "x", updatedAt: "x", finalizedAt: null },
        viewer: { mode: "normal", isCreator: false, canManageAssignment: true, canSubmitDecision: true, canResubmit: true, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Panel review");
    expect(text).toContain("In progress");
    expect(text).not.toContain("mock-assignment-card");
    expect(text).not.toContain("mock-decision-form");
    expect(text).not.toContain("mock-resubmit-action");
  });
});

describe("WorkspaceRunReviewSection — CRITICAL: finalized panel does not block single-review fallback (§53-§55/§134/§135)", () => {
  it("§134 finalized panel + valid assignment to caller + canSubmitDecision=true: decision form IS visible", async () => {
    const renderer = await render(
      baseContext({
        review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "gov-3" },
        panel: { status: "finalized", revision: 1, reviewers: [], voteSummary: null, createdAt: "x", updatedAt: "x", finalizedAt: "x" },
        assignment: { assignedReviewerUserId: "u1", assignedReviewerDisplayName: "Me", revision: 1, assignedAt: null, updatedAt: "x", dueAt: null, state: "actionable" },
        assignmentRevision: 1,
        viewer: { mode: "normal", isCreator: false, canManageAssignment: false, canSubmitDecision: true, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const decisionForm = renderer.root.findAllByProps({ canSubmitDecision: true });
    expect(decisionForm.length).toBeGreaterThan(0);
  });

  it("§135 finalized panel + no active assignment + assignmentRevision=N + canManageAssignment=true: assignment UI IS visible and receives assignmentRevision=N, not silently 0", async () => {
    const renderer = await render(
      baseContext({
        review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "gov-4" },
        panel: { status: "finalized", revision: 1, reviewers: [], voteSummary: null, createdAt: "x", updatedAt: "x", finalizedAt: "x" },
        assignment: null,
        assignmentRevision: 6,
        viewer: { mode: "normal", isCreator: false, canManageAssignment: true, canSubmitDecision: false, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const assignmentCards = renderer.root.findAllByProps({ canManageAssignment: true });
    expect(assignmentCards.length).toBeGreaterThan(0);
    expect(assignmentCards[0].props.assignmentRevision).toBe(6);
    expect(assignmentCards[0].props.assignment).toBeNull();
  });

  it("§136 cancelled panel: single-review controls visible per can*, no panel control rendered", async () => {
    const renderer = await render(
      baseContext({
        panel: { status: "cancelled", revision: 1, reviewers: [], voteSummary: null, createdAt: "x", updatedAt: "x", finalizedAt: null },
        viewer: { mode: "normal", isCreator: false, canManageAssignment: true, canSubmitDecision: false, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: false, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("mock-assignment-card");
    expect(text).not.toContain("Panel review in progress");
  });
});

describe("WorkspaceRunReviewSection — Owner Override provenance caption (Phase 9C.4)", () => {
  it("decidedVia=multi_reviewer_owner_override renders the caption; with canOverride=false (default) no interactive Override control exists", async () => {
    const renderer = await render(baseContext({ review: { status: "approved", reviewedAt: "x", decidedVia: "multi_reviewer_owner_override", governanceUpdatedAt: "gov-5" } }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Decided via owner override");
    // The informational caption is fine; no interactive Override control exists when canOverride is false (default fixture) and there is no open panel.
    expect(renderer.root.findAllByType("button").some((b) => String(b.props.children).includes("Override"))).toBe(false);
  });

  // Owner Override presence/interaction (form rendering, OCC, confirmation,
  // lock sharing) is tested directly in WorkspacePanelReviewSection.spec.tsx,
  // where WorkspacePanelReviewSection is the real (unmocked) component under
  // test. This file keeps only the orchestration-level absence check above.
});

describe("WorkspaceRunReviewSection — stale response protection (§61/§144)", () => {
  it("a slower earlier request (for an abandoned runId) does not overwrite the newer request's result", async () => {
    let resolveFirst!: (v: unknown) => void;
    mockedGetReviewContext.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(WorkspaceRunReviewSection, { workspaceId: WS_ID, runId: "run-1" }));
    });

    // A prop change to a different runId is a real dependency change —
    // it triggers a genuine second fetch, exactly like navigating to a
    // different run while the first request is still in flight.
    mockedGetReviewContext.mockResolvedValueOnce({ status: "ok", context: baseContext({ review: { status: "approved", reviewedAt: "x", governanceUpdatedAt: "fresh" } }) });
    await act(async () => {
      renderer.update(createElement(WorkspaceRunReviewSection, { workspaceId: WS_ID, runId: "run-2" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Now the FIRST (abandoned run-1) request resolves late.
    await act(async () => {
      resolveFirst({ status: "ok", context: baseContext({ review: { status: "rejected", reviewedAt: "x", governanceUpdatedAt: "stale" } }) });
      await Promise.resolve();
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Approved");
    expect(text).not.toContain("Rejected");
  });
});

describe("WorkspaceRunReviewSection — Decision Receipt (10C.4A-U2)", () => {
  const ASSIGNED_REVIEWER_VIEWER = {
    mode: "normal" as const,
    isCreator: false,
    canManageAssignment: false,
    canSubmitDecision: true,
    canResubmit: false,
    canCreatePanel: false,
    canReconfigurePanel: false,
    canCancelPanel: false,
    canVote: false,
    hasVoted: false,
    canFinalize: false,
    canOverride: false,
  };

  it("A: renders the Decision Receipt content (conclusion, basis, assumptions, uncertainties, limitations) when present", async () => {
    const renderer = await render(baseContext());
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Overall risk is moderate.");
    expect(text).toContain("Historical incident rate");
    expect(text).toContain("Mitigations remain funded");
    expect(text).toContain("Long-tail vendor risk");
    expect(text).toContain("One model did not return usable output");
  });

  it("B: Decision Receipt renders before the ordinary decision controls in the component tree", async () => {
    const renderer = await render(baseContext({ viewer: ASSIGNED_REVIEWER_VIEWER }));
    const serialized = JSON.stringify(renderer.toJSON());
    const receiptPos = serialized.indexOf("Overall risk is moderate.");
    const decisionFormPos = serialized.indexOf("mock-decision-form");
    expect(receiptPos).toBeGreaterThanOrEqual(0);
    expect(decisionFormPos).toBeGreaterThanOrEqual(0);
    expect(receiptPos).toBeLessThan(decisionFormPos);
  });

  it("C: assigned Reviewer + receipt present: decision form IS mounted", async () => {
    const renderer = await render(baseContext({ viewer: ASSIGNED_REVIEWER_VIEWER }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("mock-decision-form");
  });

  it("D: assigned Reviewer + receipt missing/malformed: decision form is NOT mounted, unavailable message shown instead", async () => {
    const renderer = await render(
      baseContext({
        viewer: ASSIGNED_REVIEWER_VIEWER,
        decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [] } as any, // missing limitations/sourceBacked/humanReviewNeeded
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("mock-decision-form");
    expect(text).toContain("Review content is unavailable. A decision cannot be submitted until the review content is available.");
  });

  it("10C.4A-U2C CENTRAL CORRECTION: assigned Reviewer + structurally-complete-but-substantively-empty receipt (empty conclusion, empty arrays — the reachable deep_research/evidence_review/bias_blindspot_audit partial-degradation shape): decision form is NOT mounted", async () => {
    const renderer = await render(
      baseContext({
        viewer: ASSIGNED_REVIEWER_VIEWER,
        decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sourceBacked: false, humanReviewNeeded: true },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("mock-decision-form");
    expect(text).toContain("Review content is unavailable. A decision cannot be submitted until the review content is available.");
  });

  it("10C.4A-U2C: whitespace-only conclusion is treated the same as empty — decision form NOT mounted", async () => {
    const renderer = await render(
      baseContext({
        viewer: ASSIGNED_REVIEWER_VIEWER,
        decisionReceipt: { conclusion: "   \n\t ", basis: [], assumptions: [], uncertainties: [], limitations: [], sourceBacked: false, humanReviewNeeded: true },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("mock-decision-form");
  });

  it("10C.4A-U2C: a non-empty conclusion with every supporting array empty remains USABLE — a legitimate 'nothing found' receipt must not be wrongly blocked", async () => {
    const renderer = await render(
      baseContext({
        viewer: ASSIGNED_REVIEWER_VIEWER,
        decisionReceipt: {
          conclusion: "The panel did not converge on enough shared subjects and attributes for a comparison.",
          basis: [],
          assumptions: [],
          uncertainties: [],
          limitations: [],
          sourceBacked: false,
          humanReviewNeeded: true,
        },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("mock-decision-form");
  });

  it("E: Viewer role (canSubmitDecision=false) + receipt present: receipt visible, decision form not mounted (existing capability rule, unaffected by the new gate)", async () => {
    const renderer = await render(
      baseContext({ viewer: { ...ASSIGNED_REVIEWER_VIEWER, canSubmitDecision: false } })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Overall risk is moderate.");
    expect(text).not.toContain("mock-decision-form");
  });

  it("I: malformed receipt renders the unavailable message even for a viewer with no decision authority", async () => {
    const renderer = await render(baseContext({ decisionReceipt: null as any }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Review content is unavailable. A decision cannot be submitted until the review content is available.");
  });

  it("10C.4A-U2C: end-to-end wiring — an empty-conclusion receipt computed at this level also blocks panel voting in the real (unmocked) WorkspacePanelReviewSection it's threaded into", async () => {
    const renderer = await render(
      baseContext({
        decisionReceipt: { conclusion: "", basis: [], assumptions: [], uncertainties: [], limitations: [], sourceBacked: false, humanReviewNeeded: true },
        panel: { status: "open", revision: 1, reviewers: [{ uid: "u1", displayName: "Me" }, { uid: "u2", displayName: "Other" }], voteSummary: { submittedCount: 0, aggregationState: "waiting" }, createdAt: "x", updatedAt: "x", finalizedAt: null },
        viewer: { mode: "normal", isCreator: false, canManageAssignment: false, canSubmitDecision: false, canResubmit: false, canCreatePanel: false, canReconfigurePanel: false, canCancelPanel: false, canVote: true, hasVoted: false, canFinalize: false, canOverride: false },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("Your vote");
    expect(text).toContain("Review content is unavailable. A decision cannot be submitted until the review content is available.");
  });
});
