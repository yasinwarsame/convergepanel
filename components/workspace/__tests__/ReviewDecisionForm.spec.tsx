/**
 * Approval Workflow, Phase 9C.2 — ReviewDecisionForm interactive tests.
 * `react-test-renderer` + `act()`, client module mocked, pure builders
 * real. Carries the mandatory §36/§37 eligibility, §38 decision enum,
 * §41 conditions, §42/§45 OCC cross-domain, §44 409 tests.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedSubmitDecision = jest.fn();
jest.mock("@/lib/client/workspaceReviewClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceReviewClient");
  return { ...actual, submitDecision: (...args: unknown[]) => mockedSubmitDecision(...args) };
});

import ReviewDecisionForm from "@/components/workspace/ReviewDecisionForm";
import type { ReviewContextReviewInfo } from "@/lib/client/workspaceReviewClient";

const WS_ID = "ws-1";
const RUN_ID = "run-1";

function review(overrides: Partial<ReviewContextReviewInfo> = {}): ReviewContextReviewInfo {
  return { status: "unreviewed", reviewedAt: null, governanceUpdatedAt: "gov-token-1", ...overrides };
}

function setup(props: { review: ReviewContextReviewInfo; canSubmitDecision: boolean; onMutated?: jest.Mock }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  const onMutated = props.onMutated ?? jest.fn();
  act(() => {
    renderer = TestRenderer.create(createElement(ReviewDecisionForm, { workspaceId: WS_ID, runId: RUN_ID, review: props.review, canSubmitDecision: props.canSubmitDecision, onMutated }));
  });
  return { renderer, onMutated };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: "reviewer-1" }, authReady: true });
  mockedSubmitDecision.mockResolvedValue({ status: "ok" });
});

describe("ReviewDecisionForm — eligibility (§36/§37 self-review)", () => {
  it("canSubmitDecision=false: renders nothing, no role inference", () => {
    const { renderer } = setup({ review: review(), canSubmitDecision: false });
    expect(renderer.toJSON()).toBeNull();
  });

  it("canSubmitDecision=true: renders the decision form", () => {
    const { renderer } = setup({ review: review(), canSubmitDecision: true });
    expect(renderer.root.findByType("form")).toBeTruthy();
  });
});

function selectRadio(renderer: TestRenderer.ReactTestRenderer, value: string) {
  const radio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === value)!;
  act(() => {
    radio.props.onChange();
  });
}

function submitForm(renderer: TestRenderer.ReactTestRenderer) {
  const form = renderer.root.findByType("form");
  return act(async () => {
    await form.props.onSubmit({ preventDefault: () => {} });
  });
}

describe("ReviewDecisionForm — decision enum (§38) and OCC separation (§42/§45)", () => {
  it("approved: submits status=approved, expectedUpdatedAt from review.governanceUpdatedAt", async () => {
    const { renderer } = setup({ review: review({ governanceUpdatedAt: "gov-42" }), canSubmitDecision: true });
    selectRadio(renderer, "approved");
    await submitForm(renderer);
    expect(mockedSubmitDecision).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ status: "approved", expectedUpdatedAt: "gov-42" }) }));
  });

  it("PHASE 9C.2 SECOND ACCEPTANCE CRITERION: decision request never uses a value that looks like assignmentRevision — uses governanceUpdatedAt exclusively even when it's a large integer-like assignment revision would be", async () => {
    const { renderer } = setup({ review: review({ governanceUpdatedAt: "2026-08-20T00:00:00.000Z" }), canSubmitDecision: true });
    selectRadio(renderer, "approved");
    await submitForm(renderer);
    const call = mockedSubmitDecision.mock.calls[0][0];
    expect(call.body.expectedUpdatedAt).toBe("2026-08-20T00:00:00.000Z");
    expect(call.body).not.toHaveProperty("assignmentRevision");
  });

  it("changes_requested requires a comment before submit is enabled", async () => {
    const { renderer } = setup({ review: review(), canSubmitDecision: true });
    selectRadio(renderer, "changes_requested");
    const submitButton = renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;
    expect(submitButton.props.disabled).toBe(true);
  });

  it("rejected requires a comment before submit is enabled", async () => {
    const { renderer } = setup({ review: review(), canSubmitDecision: true });
    selectRadio(renderer, "rejected");
    const submitButton = renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;
    expect(submitButton.props.disabled).toBe(true);
  });
});

describe("ReviewDecisionForm — conditions (§41)", () => {
  it("approved_with_conditions requires a non-empty condition before submit is enabled", () => {
    const { renderer } = setup({ review: review(), canSubmitDecision: true });
    selectRadio(renderer, "approved_with_conditions");
    const submitButton = renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!;
    expect(submitButton.props.disabled).toBe(true);
  });

  it("switching away from approved_with_conditions clears the conditions draft so it is never sent for another status", async () => {
    const { renderer } = setup({ review: review(), canSubmitDecision: true });
    selectRadio(renderer, "approved_with_conditions");
    const textarea = renderer.root.findByProps({ id: "review-decision-conditions" });
    act(() => {
      textarea.props.onChange({ target: { value: "cap table verified" } });
    });
    selectRadio(renderer, "approved");
    await submitForm(renderer);
    const call = mockedSubmitDecision.mock.calls[0][0];
    expect(call.body.conditions).toBeUndefined();
  });
});

describe("ReviewDecisionForm — 409 (§44, no blind retry)", () => {
  it("conflict: draft preserved, onMutated called, no automatic resubmit", async () => {
    mockedSubmitDecision.mockResolvedValueOnce({ status: "conflict" });
    const { renderer, onMutated } = setup({ review: review(), canSubmitDecision: true });
    selectRadio(renderer, "approved");
    await submitForm(renderer);
    expect(mockedSubmitDecision).toHaveBeenCalledTimes(1);
    expect(onMutated).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("This review changed while you were editing");
  });
});
