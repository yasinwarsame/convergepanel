/**
 * Approval Workflow, Phase 9C.2 — ReviewResubmitAction interactive tests.
 * `react-test-renderer` + `act()`. Carries §46 eligibility, §48 OCC
 * (governance domain, never assignmentRevision), §51 409 tests.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedResubmitReview = jest.fn();
jest.mock("@/lib/client/workspaceReviewClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceReviewClient");
  return { ...actual, resubmitReview: (...args: unknown[]) => mockedResubmitReview(...args) };
});

import ReviewResubmitAction from "@/components/workspace/ReviewResubmitAction";
import type { ReviewContextReviewInfo } from "@/lib/client/workspaceReviewClient";

const WS_ID = "ws-1";
const RUN_ID = "run-1";

function review(overrides: Partial<ReviewContextReviewInfo> = {}): ReviewContextReviewInfo {
  return { status: "changes_requested", reviewedAt: null, governanceUpdatedAt: "gov-token", ...overrides };
}

function setup(props: { review: ReviewContextReviewInfo; canResubmit: boolean; onMutated?: jest.Mock }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  const onMutated = props.onMutated ?? jest.fn();
  act(() => {
    renderer = TestRenderer.create(createElement(ReviewResubmitAction, { workspaceId: WS_ID, runId: RUN_ID, review: props.review, canResubmit: props.canResubmit, onMutated }));
  });
  return { renderer, onMutated };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: "manager-1" }, authReady: true });
  mockedResubmitReview.mockResolvedValue({ status: "ok" });
});

describe("ReviewResubmitAction — eligibility (§46, server flag only)", () => {
  it("canResubmit=false: renders nothing", () => {
    const { renderer } = setup({ review: review(), canResubmit: false });
    expect(renderer.toJSON()).toBeNull();
  });

  it("canResubmit=true: renders the action", () => {
    const { renderer } = setup({ review: review(), canResubmit: true });
    expect(renderer.root.findAllByType("button").some((b) => b.props.children === "Resubmit for review")).toBe(true);
  });
});

function openAndConfirm(renderer: TestRenderer.ReactTestRenderer) {
  const trigger = renderer.root.findAllByType("button").find((b) => b.props.children === "Resubmit for review")!;
  act(() => {
    trigger.props.onClick();
  });
  const confirmButtons = renderer.root.findAllByType("button").filter((b) => typeof b.props.children === "string" && b.props.children.startsWith("Resubmit"));
  const confirm = confirmButtons[confirmButtons.length - 1];
  return act(async () => {
    await confirm.props.onClick();
  });
}

describe("ReviewResubmitAction — OCC (§48, governance domain only)", () => {
  it("resubmit request uses review.governanceUpdatedAt, never assignmentRevision-shaped data", async () => {
    const { renderer } = setup({ review: review({ governanceUpdatedAt: "gov-99" }), canResubmit: true });
    await openAndConfirm(renderer);
    expect(mockedResubmitReview).toHaveBeenCalledWith(expect.objectContaining({ body: { expectedUpdatedAt: "gov-99" } }));
  });
});

describe("ReviewResubmitAction — 409 (§51, no blind retry)", () => {
  it("conflict: onMutated called once, no automatic second resubmit", async () => {
    mockedResubmitReview.mockResolvedValueOnce({ status: "conflict" });
    const { renderer, onMutated } = setup({ review: review(), canResubmit: true });
    await openAndConfirm(renderer);
    expect(mockedResubmitReview).toHaveBeenCalledTimes(1);
    expect(onMutated).toHaveBeenCalledTimes(1);
  });
});
