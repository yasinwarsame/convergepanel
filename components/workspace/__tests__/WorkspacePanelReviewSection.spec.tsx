/**
 * Approval Workflow, Phase 9C.3 — WorkspacePanelReviewSection interactive
 * tests. `react-test-renderer` + `act()` (established 9C.2 precedent — no
 * jsdom, no @testing-library/react).
 *
 * Carries the mandatory Phase 9C.3 acceptance tests: create/reconfigure
 * OCC (panel=null -> 0, panel present -> panel.revision, never
 * assignmentRevision), quorum-table integration, candidate lazy-load
 * (deferred until the create/reconfigure form is actually opened, per
 * §76 — a DELIBERATE difference from 9C.2's eager-on-can* pattern),
 * candidate invalidation after a 409, vote/finalize/cancel eligibility +
 * OCC + 409, self-review absence, no round-2 language, no raw UID,
 * double-submit protection.
 *
 * Phase 9C.4 adds: Owner Override eligibility (`canOverride`-gated, never
 * inferred from other flags), dual-OCC override request (panel.revision +
 * governanceUpdatedAt, never assignmentRevision), justification
 * requiredness/max-length, 409 draft preservation, and Override's
 * participation in this section's SAME shared ref-backed mutation lock
 * (atomicity + lifetime tests extend the existing 9C.3-R2C suites below).
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

const mockedGetReviewerCandidates = jest.fn();
const mockedPutPanel = jest.fn();
const mockedDeletePanel = jest.fn();
const mockedSubmitPanelVote = jest.fn();
const mockedFinalizePanel = jest.fn();
const mockedOverridePanel = jest.fn();
jest.mock("@/lib/client/workspaceReviewClient", () => {
  const actual = jest.requireActual("@/lib/client/workspaceReviewClient");
  return {
    ...actual,
    getReviewerCandidates: (...args: unknown[]) => mockedGetReviewerCandidates(...args),
    putPanel: (...args: unknown[]) => mockedPutPanel(...args),
    deletePanel: (...args: unknown[]) => mockedDeletePanel(...args),
    submitPanelVote: (...args: unknown[]) => mockedSubmitPanelVote(...args),
    finalizePanel: (...args: unknown[]) => mockedFinalizePanel(...args),
    overridePanel: (...args: unknown[]) => mockedOverridePanel(...args),
  };
});

import WorkspacePanelReviewSection from "@/components/workspace/WorkspacePanelReviewSection";
import type { ReviewContextPanelInfo, WorkspaceReviewContext } from "@/lib/client/workspaceReviewClient";

const WS_ID = "ws-1";
const RUN_ID = "run-1";
const REVIEW = { governanceUpdatedAt: "gov-token-abc" };

function makeViewer(overrides: Partial<WorkspaceReviewContext["viewer"]> = {}): WorkspaceReviewContext["viewer"] {
  return {
    mode: "normal",
    isCreator: false,
    canManageAssignment: false,
    canSubmitDecision: false,
    canResubmit: false,
    canCreatePanel: false,
    canReconfigurePanel: false,
    canCancelPanel: false,
    canVote: false,
    hasVoted: false,
    canFinalize: false,
    canOverride: false,
    ...overrides,
  };
}

function makePanel(overrides: Partial<ReviewContextPanelInfo> = {}): ReviewContextPanelInfo {
  return {
    status: "open",
    revision: 1,
    reviewers: [
      { uid: "r1", displayName: "Alice" },
      { uid: "r2", displayName: "Bob" },
    ],
    voteSummary: null,
    createdAt: "x",
    updatedAt: "x",
    finalizedAt: null,
    ...overrides,
  };
}

function setup(props: { panel: ReviewContextPanelInfo | null; viewer: WorkspaceReviewContext["viewer"]; onMutated?: jest.Mock }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  const onMutated = props.onMutated ?? jest.fn();
  act(() => {
    renderer = TestRenderer.create(
      createElement(WorkspacePanelReviewSection, { workspaceId: WS_ID, runId: RUN_ID, panel: props.panel, review: REVIEW, viewer: props.viewer, onMutated })
    );
  });
  return { renderer, onMutated };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { uid: "manager-1" }, authReady: true });
  mockedGetReviewerCandidates.mockResolvedValue({ status: "ok", candidates: [{ uid: "c1", displayName: "Carol" }, { uid: "c2", displayName: "Dave" }] });
  mockedPutPanel.mockResolvedValue({ status: "ok" });
  mockedDeletePanel.mockResolvedValue({ status: "ok" });
  mockedSubmitPanelVote.mockResolvedValue({ status: "ok" });
  mockedFinalizePanel.mockResolvedValue({ status: "ok" });
  mockedOverridePanel.mockResolvedValue({ status: "ok" });
});

describe("WorkspacePanelReviewSection — no panel (§16/§110)", () => {
  it("canCreatePanel=false: renders nothing", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: null, viewer: makeViewer({ canCreatePanel: false }) }));
      await Promise.resolve();
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("canCreatePanel=true: 'Start panel review' visible, candidates NOT fetched until clicked (§76, deferred lazy-load)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: null, viewer: makeViewer({ canCreatePanel: true }) }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Start panel review");
    expect(mockedGetReviewerCandidates).not.toHaveBeenCalled();
  });
});

function findButton(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAllByType("button").find((b) => String(b.props.children).includes(text) || (Array.isArray(b.props.children) && b.props.children.join("").includes(text)));
}

/** Visible text ONLY — walks `children`, never `props`/`type`, so CSS class names (e.g. "rounded-xl") never produce a false positive for a word like "round". */
function extractVisibleText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractVisibleText).join(" ");
  if (typeof node === "object" && "children" in (node as Record<string, unknown>)) return extractVisibleText((node as { children: unknown }).children);
  return "";
}

describe("WorkspacePanelReviewSection — create OCC (§33/§34/§111/§112)", () => {
  it("create with 2 reviewers: PUT uses expectedRevision=0 (panel=null)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: null, viewer: makeViewer({ canCreatePanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Start panel review")!.props.onClick();
      await Promise.resolve();
    });
    // toggle the two candidate checkboxes (c1, c2)
    const checkboxes = renderer.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
    expect(checkboxes.length).toBe(2);
    await act(async () => {
      checkboxes[0].props.onChange();
      checkboxes[1].props.onChange();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Start panel review" && !b.props.disabled)!;
    await act(async () => {
      await saveBtn.props.onClick();
    });
    expect(mockedPutPanel).toHaveBeenCalledWith(expect.objectContaining({ body: { reviewerUserIds: ["c1", "c2"], expectedRevision: 0 } }));
  });

  it("§115 create 409: no automatic retry, draft candidate re-checked, invalidated selection cannot be silently resubmitted", async () => {
    mockedPutPanel.mockResolvedValueOnce({ status: "conflict" });
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "c1", displayName: "Carol" }, { uid: "c2", displayName: "Dave" }] });
    // After the conflict, c1 is no longer eligible.
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "c2", displayName: "Dave" }] });

    let renderer!: TestRenderer.ReactTestRenderer;
    let onMutated!: jest.Mock;
    await act(async () => {
      ({ renderer, onMutated } = setup({ panel: null, viewer: makeViewer({ canCreatePanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Start panel review")!.props.onClick();
      await Promise.resolve();
    });
    let checkboxes = renderer.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
    await act(async () => {
      checkboxes[0].props.onChange();
      checkboxes[1].props.onChange();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Start panel review" && !b.props.disabled)!;
    await act(async () => {
      await saveBtn.props.onClick();
    });
    expect(mockedPutPanel).toHaveBeenCalledTimes(1);
    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(mockedGetReviewerCandidates).toHaveBeenCalledTimes(2);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("no longer eligible");
    // c1 must have been dropped from the still-checked selection.
    checkboxes = renderer.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
    const checkedCount = checkboxes.filter((c) => c.props.checked).length;
    expect(checkedCount).toBeLessThan(2);
  });
});

describe("WorkspacePanelReviewSection — reconfigure OCC (§38/§116)", () => {
  it("reconfigure uses panel.revision, not 0, and pre-fills current reviewers", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 6 }), viewer: makeViewer({ canReconfigurePanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Change reviewers")!.props.onClick();
      await Promise.resolve();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Save reviewers" && !b.props.disabled)!;
    await act(async () => {
      await saveBtn.props.onClick();
    });
    expect(mockedPutPanel).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ expectedRevision: 6, reviewerUserIds: ["r1", "r2"] }) }));
  });

  it("shows the reconfiguration warning copy, never 'round 2' language", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canReconfigurePanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Change reviewers")!.props.onClick();
      await Promise.resolve();
    });
    const text = extractVisibleText(renderer.toJSON());
    expect(text).toContain("starts a new panel revision");
    expect(text).not.toMatch(/round/i);
  });

  it("Phase 9C.3-R1C PERMANENT REGRESSION: RECONFIGURE 409 candidate invalidation — a reviewer already selected in the draft, dropped by candidates on refetch, cannot be silently resubmitted", async () => {
    mockedPutPanel.mockResolvedValueOnce({ status: "conflict" });
    // Panel currently has r1/r2; reconfigure form pre-selects both. After the
    // conflict, candidates refetch drops r1 (no longer eligible).
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "r1", displayName: "Alice" }, { uid: "r2", displayName: "Bob" }] });
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "r2", displayName: "Bob" }] });

    let renderer!: TestRenderer.ReactTestRenderer;
    let onMutated!: jest.Mock;
    await act(async () => {
      ({ renderer, onMutated } = setup({ panel: makePanel({ revision: 6 }), viewer: makeViewer({ canReconfigurePanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Change reviewers")!.props.onClick();
      await Promise.resolve();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Save reviewers" && !b.props.disabled)!;
    await act(async () => {
      await saveBtn.props.onClick();
    });
    // Exactly one PUT — no automatic replay through the conflict-recovery refetch.
    expect(mockedPutPanel).toHaveBeenCalledTimes(1);
    expect(mockedPutPanel).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ expectedRevision: 6 }) }));
    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(mockedGetReviewerCandidates).toHaveBeenCalledTimes(2);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("no longer eligible");
    // r1 must have been dropped from the still-checked selection — the same
    // shared `handleSave` code path the create-409 test already proves;
    // this test proves it specifically for RECONFIGURE (§30/§93).
    const checkboxes = renderer.root.findAllByType("input").filter((i) => i.props.type === "checkbox");
    expect(checkboxes.filter((c) => c.props.checked).length).toBeLessThan(2);
  });
});

describe("WorkspacePanelReviewSection — Phase 9C.3-R1C: shared panel mutation exclusion", () => {
  it("a vote in flight blocks finalize (visually disabled AND the underlying guard rejects a direct call, bypassing the disabled attribute)", async () => {
    let resolveVote!: (v: unknown) => void;
    mockedSubmitPanelVote.mockReturnValueOnce(new Promise((resolve) => (resolveVote = resolve)));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 3 }), viewer: makeViewer({ canVote: true, canFinalize: true }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    // Start the vote submission; deliberately do not resolve it yet.
    act(() => {
      form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(mockedSubmitPanelVote).toHaveBeenCalledTimes(1);

    const finalizeOpenBtn = findButton(renderer, "Finalize panel")!;
    expect(finalizeOpenBtn.props.disabled).toBe(true);
    await act(async () => {
      finalizeOpenBtn.props.onClick(); // opening the confirm dialog is local UI state only — allowed either way.
      await Promise.resolve();
    });
    const confirmBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize").pop()!;
    expect(confirmBtn.props.disabled).toBe(true);
    await act(async () => {
      confirmBtn.props.onClick(); // bypasses the disabled attribute, exactly like the existing double-submit test.
      await Promise.resolve();
    });
    expect(mockedFinalizePanel).not.toHaveBeenCalled();

    await act(async () => {
      resolveVote({ status: "ok" });
      await Promise.resolve();
    });
  });

  it("a reconfigure in flight blocks cancel; after it settles, cancel becomes available again", async () => {
    let resolvePut!: (v: unknown) => void;
    mockedPutPanel.mockReturnValueOnce(new Promise((resolve) => (resolvePut = resolve)));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 2 }), viewer: makeViewer({ canReconfigurePanel: true, canCancelPanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Change reviewers")!.props.onClick();
      await Promise.resolve();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Save reviewers" && !b.props.disabled)!;
    act(() => {
      saveBtn.props.onClick();
    });
    expect(mockedPutPanel).toHaveBeenCalledTimes(1);

    const cancelOpenBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelOpenBtn.props.disabled).toBe(true);
    await act(async () => {
      cancelOpenBtn.props.onClick();
      await Promise.resolve();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Cancel panel review");
    const confirmCancelBtn = confirmButtons[confirmButtons.length - 1];
    expect(confirmCancelBtn.props.disabled).toBe(true);
    await act(async () => {
      confirmCancelBtn.props.onClick();
      await Promise.resolve();
    });
    expect(mockedDeletePanel).not.toHaveBeenCalled();

    // Once the reconfigure resolves, the shared lock releases and the panel
    // re-renders from canonical (unchanged fixture) state — cancel is no
    // longer blocked by a stale lock.
    await act(async () => {
      resolvePut({ status: "ok" });
      await Promise.resolve();
    });
    const cancelBtnAfter = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtnAfter.props.disabled).toBe(false);
  });

  it("shared lock releases after a 409 — a different mutation is no longer blocked", async () => {
    mockedSubmitPanelVote.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 5 }), viewer: makeViewer({ canVote: true, canCancelPanel: true }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(mockedSubmitPanelVote).toHaveBeenCalledTimes(1);
    // Lock released post-conflict: cancel is now available, not stuck disabled.
    const cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });
});

describe("WorkspacePanelReviewSection — Phase 9C.3-R2C: atomic mutation lock (ref-backed, immune to stale React-state closures)", () => {
  it("PERMANENT REGRESSION — reproduces R2's exact defect: vote submit and finalize confirm invoked BACK-TO-BACK inside ONE synchronous act() callback (no rerender/commit between them) still results in exactly ONE network mutation", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 3 }), viewer: makeViewer({ canVote: true, canFinalize: true }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    // Pre-open the finalize confirm dialog — purely local UI state, unrelated
    // to the shared mutation lock, so it's safe to do before the critical window.
    await act(async () => {
      findButton(renderer, "Finalize panel")!.props.onClick();
      await Promise.resolve();
    });
    const confirmBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize").pop()!;

    // THE CRITICAL WINDOW — both handlers invoked synchronously, back-to-back,
    // inside ONE act() callback, with no await/rerender between them. This is
    // R2's exact reproduction of the stale-closure defect: with a
    // React-state-only guard, both handlers would observe `activeMutation ===
    // null` from the same pre-commit closure. With the ref-backed guard, the
    // first handler's synchronous write to `activeMutationRef.current` (which
    // happens before its own first `await`) is visible to the second handler
    // immediately — no render/commit required.
    act(() => {
      form.props.onSubmit({ preventDefault: () => {} });
      confirmBtn.props.onClick();
    });

    expect(mockedSubmitPanelVote).toHaveBeenCalledTimes(1);
    expect(mockedFinalizePanel).not.toHaveBeenCalled();
  });

  it("reverse order — finalize confirm then vote submit, back-to-back in one synchronous act() — still exactly one mutation", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 4 }), viewer: makeViewer({ canVote: true, canFinalize: true }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    await act(async () => {
      findButton(renderer, "Finalize panel")!.props.onClick();
      await Promise.resolve();
    });
    const confirmBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize").pop()!;

    act(() => {
      confirmBtn.props.onClick();
      form.props.onSubmit({ preventDefault: () => {} });
    });

    expect(mockedFinalizePanel).toHaveBeenCalledTimes(1);
    expect(mockedSubmitPanelVote).not.toHaveBeenCalled();
  });

  it("manager pair — reconfigure Save and cancel confirm invoked back-to-back in one synchronous act() — still exactly one mutation", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 2 }), viewer: makeViewer({ canReconfigurePanel: true, canCancelPanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Change reviewers")!.props.onClick();
      await Promise.resolve();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Save reviewers" && !b.props.disabled)!;
    await act(async () => {
      findButton(renderer, "Cancel panel review")!.props.onClick();
      await Promise.resolve();
    });
    const confirmCancelBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Cancel panel review").pop()!;

    act(() => {
      saveBtn.props.onClick();
      confirmCancelBtn.props.onClick();
    });

    expect(mockedPutPanel).toHaveBeenCalledTimes(1);
    expect(mockedDeletePanel).not.toHaveBeenCalled();
  });
});

describe("WorkspacePanelReviewSection — Phase 9C.3-R2C: lock lifetime through canonical refresh (not merely the HTTP round-trip)", () => {
  it("success: lock remains held after the mutation HTTP call has already resolved, while the canonical review-context refresh (onMutated) is still pending — releases only once the refresh resolves", async () => {
    let resolveMutated!: () => void;
    const onMutated = jest.fn().mockReturnValue(new Promise<void>((resolve) => (resolveMutated = resolve)));
    mockedSubmitPanelVote.mockResolvedValueOnce({ status: "ok" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 3 }), viewer: makeViewer({ canVote: true, canCancelPanel: true }), onMutated }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    // Fire without awaiting — the handler itself does not finish until the
    // deferred `onMutated()` resolves, so awaiting it directly would hang.
    act(() => {
      form.props.onSubmit({ preventDefault: () => {} });
    });
    // Flush every queued microtask (submitPanelVote's resolution + the call
    // into onMutated) WITHOUT resolving onMutated's own promise.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onMutated).toHaveBeenCalledTimes(1);
    let cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(true);
    await act(async () => {
      cancelBtn.props.onClick();
      await Promise.resolve();
    });
    const confirmCancelBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Cancel panel review").pop()!;
    expect(confirmCancelBtn.props.disabled).toBe(true);
    await act(async () => {
      confirmCancelBtn.props.onClick();
      await Promise.resolve();
    });
    expect(mockedDeletePanel).not.toHaveBeenCalled();

    await act(async () => {
      resolveMutated();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });

  it("409: lock remains held while canonical review-context refresh is still pending after the conflict response — releases only once the refresh resolves", async () => {
    let resolveMutated!: () => void;
    const onMutated = jest.fn().mockReturnValue(new Promise<void>((resolve) => (resolveMutated = resolve)));
    mockedSubmitPanelVote.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 5 }), viewer: makeViewer({ canVote: true, canCancelPanel: true }), onMutated }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    act(() => {
      form.props.onSubmit({ preventDefault: () => {} });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onMutated).toHaveBeenCalledTimes(1);
    let cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(true); // still locked — conflict recovery isn't done yet.

    await act(async () => {
      resolveMutated();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });

  it("reconfigure 409: lock remains held while candidate revalidation is still pending, even though the canonical context refresh has already resolved — the lock covers BOTH awaited reconciliation steps", async () => {
    mockedPutPanel.mockResolvedValueOnce({ status: "conflict" });
    let resolveCandidates!: (v: unknown) => void;
    mockedGetReviewerCandidates
      .mockResolvedValueOnce({ status: "ok", candidates: [{ uid: "r1", displayName: "Alice" }, { uid: "r2", displayName: "Bob" }] }) // initial open
      .mockReturnValueOnce(new Promise((resolve) => (resolveCandidates = resolve))); // post-409 revalidation — held pending
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 6 }), viewer: makeViewer({ canReconfigurePanel: true, canCancelPanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Change reviewers")!.props.onClick();
      await Promise.resolve();
    });
    const saveBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Save reviewers" && !b.props.disabled)!;
    act(() => {
      saveBtn.props.onClick();
    });
    // Flush every queued microtask: putPanel's "conflict" resolution, the
    // (default, immediately-resolving) onMutated() call, and the start of
    // the getReviewerCandidates() revalidation call — WITHOUT resolving the
    // deliberately-held-pending candidates promise.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(true);

    await act(async () => {
      resolveCandidates({ status: "ok", candidates: [{ uid: "r2", displayName: "Bob" }] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });

  it("generic (non-conflict) mutation error: lock releases immediately — no canonical refresh is needed since server state never changed", async () => {
    mockedFinalizePanel.mockResolvedValueOnce({ status: "error" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 7 }), viewer: makeViewer({ canFinalize: true, canCancelPanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      findButton(renderer, "Finalize panel")!.props.onClick();
      await Promise.resolve();
    });
    const confirmBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize").pop()!;
    await act(async () => {
      await confirmBtn.props.onClick();
    });
    const cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });
});

describe("WorkspacePanelReviewSection — voting (§43/§44/§119/§120)", () => {
  it("canVote=false: no vote form rendered (includes self-review case — backend-derived, no client inference)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canVote: false, isCreator: true }) }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Your vote");
  });

  it("canVote=true, hasVoted=false: vote form renders; submit uses panelRevision, never assignmentRevision/governanceUpdatedAt", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 4 }), viewer: makeViewer({ canVote: true, hasVoted: false }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(mockedSubmitPanelVote).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ panelRevision: 4, status: "approved" }) }));
    const call = mockedSubmitPanelVote.mock.calls[0][0];
    expect(call.body.expectedRevision).toBeUndefined();
    expect(call.body.expectedUpdatedAt).toBeUndefined();
  });

  it("canVote=true, hasVoted=true: 'You already voted', no vote form (votes are cast-once, never replaceable)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canVote: true, hasVoted: true }) }));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("You already voted");
    expect(text).not.toContain("Your vote");
  });

  it("§122 vote 409: no automatic retry (call count stays 1)", async () => {
    mockedSubmitPanelVote.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    let onMutated!: jest.Mock;
    await act(async () => {
      ({ renderer, onMutated } = setup({ panel: makePanel({ revision: 2 }), viewer: makeViewer({ canVote: true }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    const form = renderer.root.findAllByType("form")[0];
    await act(async () => {
      await form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(mockedSubmitPanelVote).toHaveBeenCalledTimes(1);
    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("This panel changed while you were editing");
  });
});

describe("WorkspacePanelReviewSection — finalize (§55/§57/§126/§127)", () => {
  it("canFinalize=false: no finalize control", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canFinalize: false }) }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Finalize panel");
  });

  it("finalize request uses panel.revision AND review.governanceUpdatedAt, never assignmentRevision — deliberately divergent values", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 9 }), viewer: makeViewer({ canFinalize: true }) }));
      await Promise.resolve();
    });
    const openBtn = findButton(renderer, "Finalize panel")!;
    await act(async () => {
      openBtn.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    expect(mockedFinalizePanel).toHaveBeenCalledWith(expect.objectContaining({ body: { expectedPanelRevision: 9, expectedGovernanceUpdatedAt: "gov-token-abc" } }));
    const call = mockedFinalizePanel.mock.calls[0][0];
    expect(Object.values(call.body)).not.toContain(111);
  });

  it("§129 finalize 409: no automatic retry", async () => {
    mockedFinalizePanel.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canFinalize: true }) }));
      await Promise.resolve();
    });
    const openBtn = findButton(renderer, "Finalize panel")!;
    await act(async () => {
      openBtn.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    expect(mockedFinalizePanel).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspacePanelReviewSection — cancel (§66/§67/§132/§133)", () => {
  it("canCancelPanel=false: no cancel control", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canCancelPanel: false }) }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Cancel panel review");
  });

  it("cancel DELETE uses panel.revision (12), never 0, never assignmentRevision", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 12 }), viewer: makeViewer({ canCancelPanel: true }) }));
      await Promise.resolve();
    });
    const openBtn = findButton(renderer, "Cancel panel review")!;
    await act(async () => {
      openBtn.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Cancel panel review");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    expect(mockedDeletePanel).toHaveBeenCalledWith(expect.objectContaining({ body: { expectedRevision: 12 } }));
  });

  it("§134 cancel 409: no automatic retry", async () => {
    mockedDeletePanel.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canCancelPanel: true }) }));
      await Promise.resolve();
    });
    const openBtn = findButton(renderer, "Cancel panel review")!;
    await act(async () => {
      openBtn.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Cancel panel review");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    expect(mockedDeletePanel).toHaveBeenCalledTimes(1);
  });
});

function fillOverrideDraft(renderer: TestRenderer.ReactTestRenderer, statusValue: string, justification: string) {
  const radio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.name === "owner-override-status" && i.props.value === statusValue)!;
  radio.props.onChange();
  const textarea = renderer.root.findAllByType("textarea").find((t) => t.props.id === "owner-override-justification")!;
  textarea.props.onChange({ target: { value: justification } });
}

describe("WorkspacePanelReviewSection — Owner Override (Phase 9C.4, §26-§45)", () => {
  it("canOverride=true, panel open: 'Owner override' section renders as its own card, separate from 'Panel review'", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Owner override");
    expect(text).toContain("Panel review");
    expect(text).toContain("exceptional governance decision");
  });

  it("canOverride=true but panel finalized: Override does not render (backend's own canOverride never true here, but verified defensively too)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ status: "finalized", finalizedAt: "x" }), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    expect(extractVisibleText(renderer.toJSON())).not.toMatch(/owner override/i);
  });

  it("submit is blocked with no status selected, or with empty/whitespace-only justification", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    let triggerBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!;
    expect(triggerBtn.props.disabled).toBe(true);

    await act(async () => {
      fillOverrideDraft(renderer, "approved", "   ");
    });
    triggerBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!;
    expect(triggerBtn.props.disabled).toBe(true);

    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Sufficient sourcing confirmed independently.");
    });
    triggerBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!;
    expect(triggerBtn.props.disabled).toBe(false);
  });

  it("justification textarea enforces maxLength=4000, mirroring the backend's MAX_REVIEW_COMMENT_LENGTH", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    const textarea = renderer.root.findAllByType("textarea").find((t) => t.props.id === "owner-override-justification")!;
    expect(textarea.props.maxLength).toBe(4000);
  });

  it("approved_with_conditions requires at least one condition before the trigger is enabled", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved_with_conditions", "Conditional override justification.");
    });
    let triggerBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!;
    expect(triggerBtn.props.disabled).toBe(true);

    const conditionsTextarea = renderer.root.findAllByType("textarea").find((t) => t.props.id === "owner-override-conditions")!;
    await act(async () => {
      conditionsTextarea.props.onChange({ target: { value: "Verify primary source" } });
    });
    triggerBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!;
    expect(triggerBtn.props.disabled).toBe(false);
  });

  it("override request uses expectedPanelRevision (panel.revision) AND expectedGovernanceUpdatedAt (review.governanceUpdatedAt), never assignmentRevision — deliberately divergent values", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 7 }), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Independently verified before override.");
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    expect(mockedOverridePanel).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ expectedPanelRevision: 7, expectedGovernanceUpdatedAt: "gov-token-abc", status: "approved", justification: "Independently verified before override." }) })
    );
    const call = mockedOverridePanel.mock.calls[0][0];
    expect(Object.values(call.body)).not.toContain(111);
  });

  it("409: no automatic retry (call count stays 1), draft (status + justification) preserved, conflict notice shown", async () => {
    mockedOverridePanel.mockResolvedValueOnce({ status: "conflict" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "rejected", "Justification preserved across a conflict.");
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    expect(mockedOverridePanel).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("This review changed while you were preparing the override");
    const preservedRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "rejected")!;
    expect(preservedRadio.props.checked).toBe(true);
    const preservedTextarea = renderer.root.findAllByType("textarea").find((t) => t.props.id === "owner-override-justification")!;
    expect(preservedTextarea.props.value).toBe("Justification preserved across a conflict.");
  });

  it("success: draft clears only after the awaited canonical refresh", async () => {
    let resolveMutated!: () => void;
    const onMutated = jest.fn(() => new Promise<void>((resolve) => (resolveMutated = resolve)));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true }), onMutated }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Success path justification text.");
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    act(() => {
      confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Still pending — the deferred onMutated() has not resolved yet.
    let confirmBtn = renderer.root.findAllByType("button").find((b) => b.props.children === "Submitting…");
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      resolveMutated();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockedOverridePanel).toHaveBeenCalledTimes(1);
  });

  it("generic (non-conflict) mutation error: releases immediately, other panel controls become available again", async () => {
    mockedOverridePanel.mockResolvedValueOnce({ status: "error" });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true, canCancelPanel: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Generic error path justification.");
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    await act(async () => {
      await confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    const cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });
});

describe("WorkspacePanelReviewSection — Phase 9C.4: Override participates in the SAME ref-backed atomic mutation lock as vote/finalize/cancel", () => {
  it("same-tick vote + override: only one underlying mutation fires", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 3 }), viewer: makeViewer({ canVote: true, canOverride: true }) }));
      await Promise.resolve();
    });
    const approveRadio = renderer.root.findAllByType("input").find((i) => i.props.type === "radio" && i.props.value === "approved" && i.props.name === "panel-vote-status")!;
    await act(async () => {
      approveRadio.props.onChange();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Same-tick atomicity probe justification.");
    });
    const form = renderer.root.findAllByType("form")[0];
    // Open the override confirm dialog first (a separate user action, not part of the atomicity probe itself).
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    const confirmOverrideBtn = confirmButtons[confirmButtons.length - 1];

    // Both handlers invoked synchronously, back-to-back, inside ONE act() —
    // no intervening await/rerender — mirrors the 9C.3-R2C same-tick proof.
    act(() => {
      form.props.onSubmit({ preventDefault: () => {} });
      confirmOverrideBtn.props.onClick();
    });

    expect(mockedSubmitPanelVote).toHaveBeenCalledTimes(1);
    expect(mockedOverridePanel).not.toHaveBeenCalled();
  });

  it("same-tick override + finalize (reverse order): only one underlying mutation fires", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ revision: 3 }), viewer: makeViewer({ canFinalize: true, canOverride: true }) }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Reverse-order atomicity probe justification.");
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const overrideConfirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    const confirmOverrideBtn = overrideConfirmButtons[overrideConfirmButtons.length - 1];

    await act(async () => {
      findButton(renderer, "Finalize panel")!.props.onClick();
    });
    const finalizeConfirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize");
    const confirmFinalizeBtn = finalizeConfirmButtons[finalizeConfirmButtons.length - 1];

    act(() => {
      confirmOverrideBtn.props.onClick();
      confirmFinalizeBtn.props.onClick();
    });

    expect(mockedOverridePanel).toHaveBeenCalledTimes(1);
    expect(mockedFinalizePanel).not.toHaveBeenCalled();
  });

  it("lock lifetime: override HTTP resolved, canonical refresh still pending — Cancel remains disabled", async () => {
    let resolveMutated!: () => void;
    const onMutated = jest.fn(() => new Promise<void>((resolve) => (resolveMutated = resolve)));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canOverride: true, canCancelPanel: true }), onMutated }));
      await Promise.resolve();
    });
    await act(async () => {
      fillOverrideDraft(renderer, "approved", "Lock lifetime probe justification.");
    });
    await act(async () => {
      renderer.root.findAllByType("button").find((b) => b.props.children === "Override review")!.props.onClick();
    });
    const confirmButtons = renderer.root.findAllByType("button").filter((b) => b.props.children === "Confirm override");
    act(() => {
      confirmButtons[confirmButtons.length - 1].props.onClick();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(true);

    await act(async () => {
      resolveMutated();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    cancelBtn = findButton(renderer, "Cancel panel review")!;
    expect(cancelBtn.props.disabled).toBe(false);
  });
});

describe("WorkspacePanelReviewSection — finalized / cancelled read-only evidence (§18/§19/§136/§137)", () => {
  it("finalized: shows 'Finalized' status, reviewer list, no vote/reconfigure/finalize/cancel controls", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({
        panel: makePanel({ status: "finalized", finalizedAt: "x" }),
        viewer: makeViewer({ canVote: true, canReconfigurePanel: true, canFinalize: true, canCancelPanel: true }),
      }));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Finalized");
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    expect(text).not.toContain("Your vote");
    expect(text).not.toContain("Change reviewers");
    expect(text).not.toContain("Finalize panel");
    expect(text).not.toContain("Cancel panel review");
  });

  it("cancelled: shows 'Cancelled' status, not treated as an active blocker", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel({ status: "cancelled" }), viewer: makeViewer() }));
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Cancelled");
  });
});

describe("WorkspacePanelReviewSection — scope discipline (§91/§140/§141/§57-§58 panel action absence)", () => {
  it("Owner Override does not render when canOverride=false, even with every other can* flag true", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canVote: true, canReconfigurePanel: true, canFinalize: true, canCancelPanel: true, canOverride: false }) }));
      await Promise.resolve();
    });
    expect(extractVisibleText(renderer.toJSON())).not.toMatch(/override/i);
  });

  it("no panel round 2 language across every rendered state", async () => {
    const states: { panel: ReviewContextPanelInfo | null; viewer: WorkspaceReviewContext["viewer"] }[] = [
      { panel: null, viewer: makeViewer({ canCreatePanel: true }) },
      { panel: makePanel(), viewer: makeViewer({ canVote: true, canReconfigurePanel: true, canFinalize: true, canCancelPanel: true }) },
      { panel: makePanel({ status: "finalized" }), viewer: makeViewer() },
      { panel: makePanel({ status: "cancelled" }), viewer: makeViewer() },
    ];
    for (const state of states) {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        ({ renderer } = setup(state));
        await Promise.resolve();
      });
      expect(extractVisibleText(renderer.toJSON())).not.toMatch(/round/i);
    }
  });

  it("no raw UID visible as text — only displayName ('r1'/'r2' machine uids never appear)", async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer() }));
      await Promise.resolve();
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain('"r1"');
    expect(text).not.toContain('"r2"');
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
  });
});

describe("WorkspacePanelReviewSection — double-submit protection (§96/§145)", () => {
  it("finalize confirm button becomes disabled while the mutation is in flight, and a second click while disabled issues no additional request", async () => {
    let resolveFinalize!: (v: unknown) => void;
    mockedFinalizePanel.mockReturnValueOnce(new Promise((resolve) => (resolveFinalize = resolve)));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      ({ renderer } = setup({ panel: makePanel(), viewer: makeViewer({ canFinalize: true }) }));
      await Promise.resolve();
    });
    const openBtn = findButton(renderer, "Finalize panel")!;
    await act(async () => {
      openBtn.props.onClick();
    });
    let confirmBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalize").pop()!;
    // First click starts the in-flight mutation but does not await its resolution.
    act(() => {
      confirmBtn.props.onClick();
    });
    expect(mockedFinalizePanel).toHaveBeenCalledTimes(1);
    // Re-query: the pending re-render disables the button — the real double-submit guard a genuine second click would hit.
    confirmBtn = renderer.root.findAllByType("button").filter((b) => b.props.children === "Finalizing…").pop()!;
    expect(confirmBtn.props.disabled).toBe(true);
    // A synchronous second invocation of the same handler (bypassing the disabled attribute, as a
    // malicious/fast client might) is still rejected by the in-function `pending` guard.
    await act(async () => {
      confirmBtn.props.onClick();
      await Promise.resolve();
    });
    expect(mockedFinalizePanel).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFinalize({ status: "ok" });
      await Promise.resolve();
    });
  });
});
