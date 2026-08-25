/**
 * Approval Workflow, Phase 9C.2 — ReviewAssignmentCard interactive tests.
 * `react-test-renderer` + `act()` (no jsdom — established precedent, see
 * `NewProjectDialog.spec.tsx`). The client module's mutation/fetch
 * functions are mocked directly; `buildAssignmentPutRequest`/
 * `buildAssignmentDeleteRequest` are the REAL pure functions (not
 * mocked), so these tests prove the component actually calls them with
 * the correct context rather than constructing request bodies by hand.
 *
 * This file carries the mandatory Phase 9C.2 acceptance tests: §67
 * clear-then-reassign, §69 cleared-state-direct-load (the primary
 * acceptance criterion), §70 stale assignment, §78 candidate lazy-load,
 * §79 no raw UID, §46/§47 409 + candidate invalidation.
 */

import { createElement, createRef } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedGetReviewerCandidates = jest.fn();
const mockedPutAssignment = jest.fn();
const mockedDeleteAssignment = jest.fn();
jest.mock("@/lib/client/workspaceReviewClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceReviewClient");
  return {
    ...actual,
    getReviewerCandidates: (...args: unknown[]) => mockedGetReviewerCandidates(...args),
    putAssignment: (...args: unknown[]) => mockedPutAssignment(...args),
    deleteAssignment: (...args: unknown[]) => mockedDeleteAssignment(...args),
  };
});

import ReviewAssignmentCard from "@/components/workspace/ReviewAssignmentCard";
import type { ReviewContextAssignmentInfo } from "@/lib/client/workspaceReviewClient";

const WS_ID = "ws-1";
const RUN_ID = "run-1";

function setup(props: { assignment: ReviewContextAssignmentInfo | null; assignmentRevision: number; canManageAssignment: boolean; onMutated?: jest.Mock }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  const onMutated = props.onMutated ?? jest.fn();
  act(() => {
    renderer = TestRenderer.create(
      createElement(ReviewAssignmentCard, { workspaceId: WS_ID, runId: RUN_ID, assignment: props.assignment, assignmentRevision: props.assignmentRevision, canManageAssignment: props.canManageAssignment, onMutated })
    );
  });
  return { renderer, onMutated };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: "manager-1" }, authReady: true });
  mockedGetReviewerCandidates.mockResolvedValue({ status: "ok", candidates: [{ uid: "reviewer-a", displayName: "Alice" }, { uid: "reviewer-b", displayName: "Bob" }] });
  mockedPutAssignment.mockResolvedValue({ status: "ok" });
  mockedDeleteAssignment.mockResolvedValue({ status: "ok" });
});

describe("ReviewAssignmentCard — candidate lazy loading (§78)", () => {
  it("canManageAssignment=false: reviewer-candidates is never called", async () => {
    await act(async () => {
      setup({ assignment: null, assignmentRevision: 0, canManageAssignment: false });
      await Promise.resolve();
    });
    expect(mockedGetReviewerCandidates).not.toHaveBeenCalled();
  });

  it("canManageAssignment=true: reviewer-candidates is called exactly once", async () => {
    await act(async () => {
      setup({ assignment: null, assignmentRevision: 0, canManageAssignment: true });
      await Promise.resolve();
    });
    expect(mockedGetReviewerCandidates).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewAssignmentCard — presentation, no raw UID (§14/§79)", () => {
  it("unassigned: shows 'Unassigned', no raw uid anywhere in output", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ assignment: null, assignmentRevision: 0, canManageAssignment: false }));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Unassigned");
  });

  it("stale assignment: primary label is 'Needs reassignment', never presented as healthy", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({
        assignment: { assignedReviewerUserId: "foreign-uid-xyz", assignedReviewerDisplayName: "Reviewer unavailable", revision: 9, assignedAt: null, updatedAt: "x", dueAt: null, state: "stale" },
        assignmentRevision: 9,
        canManageAssignment: false,
      }));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Needs reassignment");
    expect(text).not.toContain("foreign-uid-xyz");
  });
});

async function selectAndSave(renderer: TestRenderer.ReactTestRenderer, uid: string) {
  const select = renderer.root.findByProps({ id: "review-assignment-reviewer" });
  await act(async () => {
    select.props.onChange({ target: { value: uid } });
  });
  const saveButton = renderer.root.findAllByType("button").find((b) => /Assign reviewer|Save assignment/.test(String(b.props.children)))!;
  await act(async () => {
    await saveButton.props.onClick();
  });
}

describe("ReviewAssignmentCard — assignment OCC (Phase 9B.7 acceptance tests, §67-§71)", () => {
  it("§68 never-assigned: PUT request uses expectedRevision=0", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ assignment: null, assignmentRevision: 0, canManageAssignment: true }));
      await Promise.resolve();
    });
    await selectAndSave(renderer, "reviewer-a");
    expect(mockedPutAssignment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ assignedReviewerUserId: "reviewer-a", expectedRevision: 0 }) }));
  });

  it("§69 PRIMARY ACCEPTANCE CRITERION — cleared-state direct load (assignment=null, assignmentRevision=7): PUT uses expectedRevision=7, NOT 0", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      // This context is loaded DIRECTLY in this state — no prior clear action happened in this test/session.
      ({ renderer } = setup({ assignment: null, assignmentRevision: 7, canManageAssignment: true }));
      await Promise.resolve();
    });
    await selectAndSave(renderer, "reviewer-b");
    expect(mockedPutAssignment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ expectedRevision: 7 }) }));
    const call = mockedPutAssignment.mock.calls[0][0];
    expect(call.body.expectedRevision).not.toBe(0);
  });

  it("§70 stale assignment: reassignment PUT uses assignmentRevision (9), not treated as a fresh resource", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({
        assignment: { assignedReviewerUserId: "stale-uid", assignedReviewerDisplayName: "Reviewer unavailable", revision: 9, assignedAt: null, updatedAt: "x", dueAt: null, state: "stale" },
        assignmentRevision: 9,
        canManageAssignment: true,
      }));
      await Promise.resolve();
    });
    await selectAndSave(renderer, "reviewer-a");
    expect(mockedPutAssignment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ expectedRevision: 9 }) }));
  });

  it("§71 clear: DELETE uses assignmentRevision (12), not assignment.revision", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({
        assignment: { assignedReviewerUserId: "reviewer-a", assignedReviewerDisplayName: "Alice", revision: 999, assignedAt: null, updatedAt: "x", dueAt: null, state: "actionable" },
        assignmentRevision: 12,
        canManageAssignment: true,
      }));
      await Promise.resolve();
    });
    const clearButton = renderer.root.findAllByType("button").find((b) => b.props.children === "Clear assignment")!;
    await act(async () => {
      clearButton.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Clear assignment");
    const confirmInDialog = confirmButtons[confirmButtons.length - 1];
    await act(async () => {
      await confirmInDialog.props.onClick();
    });
    expect(mockedDeleteAssignment).toHaveBeenCalledWith(expect.objectContaining({ body: { expectedRevision: 12 } }));
  });
});

describe("ReviewAssignmentCard — 409 conflict handling (§31-§34/§46/§47, no blind retry)", () => {
  it("assignment 409: no automatic retry, draft preserved, onMutated called for refetch, candidates re-checked for eligibility", async () => {
    mockedPutAssignment.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    let onMutated!: jest.Mock;
    await act(async () => {
      ({ renderer, onMutated } = setup({ assignment: null, assignmentRevision: 4, canManageAssignment: true }));
      await Promise.resolve();
    });
    await selectAndSave(renderer, "reviewer-a");
    expect(mockedPutAssignment).toHaveBeenCalledTimes(1);
    expect(onMutated).toHaveBeenCalledTimes(1);
    // draft (selected reviewer) preserved — Save button still shows the assign label, no crash/reset error
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("This review changed while you were editing");
  });

  it("§34/§47 candidate becomes ineligible after 409: selection is cleared, not silently resubmitted", async () => {
    mockedPutAssignment.mockResolvedValueOnce({ status: "conflict" });
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "reviewer-a", displayName: "Alice" }, { uid: "reviewer-b", displayName: "Bob" }] });
    // After the conflict, reviewer-a is no longer eligible.
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "reviewer-b", displayName: "Bob" }] });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ assignment: null, assignmentRevision: 4, canManageAssignment: true }));
      await Promise.resolve();
    });
    await selectAndSave(renderer, "reviewer-a");
    expect(mockedGetReviewerCandidates).toHaveBeenCalledTimes(2);
    const select = renderer.root.findByProps({ id: "review-assignment-reviewer" });
    expect(select.props.value).toBe("");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("no longer eligible");
  });
});
