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
    review: { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "gov-1" },
    assignment: null,
    assignmentRevision: 0,
    panel: null,
    viewer: { mode: "normal", isCreator: false, canManageAssignment: false, canSubmitDecision: false, canResubmit: false },
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

describe("WorkspaceRunReviewSection — drain mode (§11/§139)", () => {
  it("drain mode: no assignment/decision/resubmit controls, read-only unavailable message", async () => {
    const renderer = await render(baseContext({ viewer: { mode: "drain", isCreator: false, canManageAssignment: true, canSubmitDecision: true, canResubmit: true } }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Review actions are currently unavailable.");
    expect(text).not.toContain("mock-assignment-card");
    expect(text).not.toContain("mock-decision-form");
    expect(text).not.toContain("mock-resubmit-action");
  });
});

describe("WorkspaceRunReviewSection — open panel (§52/§133)", () => {
  it("panel.status=open: read-only 'Panel review in progress', no assignment/decision/resubmit controls even if can* were true", async () => {
    const renderer = await render(
      baseContext({
        panel: { status: "open", revision: 1, reviewers: [], voteSummary: null, createdAt: "x", updatedAt: "x", finalizedAt: null },
        viewer: { mode: "normal", isCreator: false, canManageAssignment: true, canSubmitDecision: true, canResubmit: true },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Panel review in progress");
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
        viewer: { mode: "normal", isCreator: false, canManageAssignment: false, canSubmitDecision: true, canResubmit: false },
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
        viewer: { mode: "normal", isCreator: false, canManageAssignment: true, canSubmitDecision: false, canResubmit: false },
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
        viewer: { mode: "normal", isCreator: false, canManageAssignment: true, canSubmitDecision: false, canResubmit: false },
      })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("mock-assignment-card");
    expect(text).not.toContain("Panel review in progress");
  });
});

describe("WorkspaceRunReviewSection — panel action / Owner Override absence (§57/§58)", () => {
  it("even with canOverride-shaped true-like flags absent from the type, no Owner Override text renders", async () => {
    const renderer = await render(baseContext({ review: { status: "approved", reviewedAt: "x", decidedVia: "multi_reviewer_owner_override", governanceUpdatedAt: "gov-5" } }));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Decided via owner override");
    // The informational caption is fine; no interactive Override control may exist.
    expect(renderer.root.findAllByType("button").some((b) => String(b.props.children).includes("Override"))).toBe(false);
  });
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
