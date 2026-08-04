/**
 * Regression test for the stale-panel-on-navigation bug: viewing Scenario C
 * (waiting, below quorum) right after Scenario A (ready to finalize) could
 * render Scenario A's panel data because `AdaptiveMultiReviewerPanelSection`
 * is never remounted by a client-side `runId` prop change — its own
 * `AdaptiveReviewDetail` parent stays mounted across `/team/reviews/[runId]`
 * navigations — and its `load()` had no guard against a slow, still-in-flight
 * fetch for the PREVIOUS runId resolving after the new runId's fetch already
 * landed. The fix mirrors `TeamReviewQueue.tsx`'s existing `abortRef`
 * pattern. This test proves the fix by resolving the two runs' fetches
 * deliberately OUT OF ORDER (Scenario C first, Scenario A's stale response
 * arriving late) and asserting the late response never overwrites the
 * already-correct Scenario C render.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

type Deferred = { promise: Promise<any>; resolve: (v: any) => void };
function createDeferred(): Deferred {
  let resolve!: (v: any) => void;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const deferredsByUrl = new Map<string, Deferred>();
const authedFetchMock = jest.fn((url: string, _opts?: unknown) => {
  if (!deferredsByUrl.has(url)) deferredsByUrl.set(url, createDeferred());
  return deferredsByUrl.get(url)!.promise;
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, unknown]) => authedFetchMock(...args),
}));

import AdaptiveMultiReviewerPanelSection from "@/components/teamGovernance/AdaptiveMultiReviewerPanelSection";

const RUN_A = "gov-e2e-seed-run-a-ready";
const RUN_C = "gov-e2e-seed-run-c-waiting";

function panelResponse(overrides: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      version: 1,
      panel: {
        mode: "majority_quorum",
        status: "open",
        revision: 1,
        reviewers: [
          { userId: "r1", displayName: "Seed Reviewer One", isCurrentUser: false, hasSubmittedVote: true, voteStatus: "approved" },
          { userId: "r2", displayName: "Seed Reviewer Two", isCurrentUser: false, hasSubmittedVote: false },
          { userId: "r3", displayName: "Seed Reviewer Three", isCurrentUser: false, hasSubmittedVote: false },
        ],
        requiredReviewerCount: 3,
        quorum: 2,
        canReconfigurePanel: false,
        canCancelPanel: false,
        canVote: false,
        canFinalize: false,
        canOverride: false,
        ...overrides,
      },
    }),
  };
}

const SCENARIO_A_READY = panelResponse({
  reviewers: [
    { userId: "r1", displayName: "Seed Reviewer One", isCurrentUser: false, hasSubmittedVote: true, voteStatus: "approved" },
    { userId: "r2", displayName: "Seed Reviewer Two", isCurrentUser: false, hasSubmittedVote: true, voteStatus: "approved" },
    { userId: "r3", displayName: "Seed Reviewer Three", isCurrentUser: false, hasSubmittedVote: false },
  ],
  submittedCount: 2,
  aggregationState: "ready",
  readyFinalStatus: "approved",
  canFinalize: true,
});

const SCENARIO_C_WAITING = panelResponse({
  submittedCount: 1,
  aggregationState: "waiting",
});

const ASSIGNMENT_RESPONSE = { ok: true, json: async () => ({ ok: true, eligibleReviewers: [] }) };

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(collect).join("");
    if (node && typeof node === "object" && "children" in (node as any)) {
      return collect((node as any).children);
    }
    return "";
  };
  return collect(renderer.toJSON());
}

beforeEach(() => {
  deferredsByUrl.clear();
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-uid" }, authReady: true, canMutate: true });
});

describe("AdaptiveMultiReviewerPanelSection — runId navigation race", () => {
  it("never lets a late-resolving PREVIOUS run's response overwrite the CURRENT run's correctly-rendered panel", async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AdaptiveMultiReviewerPanelSection, { runId: RUN_A, expectedGovernanceUpdatedAt: "2026-01-01T00:00:00.000Z" })
      );
    });
    await flush();

    // Scenario A's panel + assignment fetches are now in flight (deliberately
    // left unresolved) — simulates a client-side navigation starting while
    // A's own request hasn't landed yet.
    expect(deferredsByUrl.has(`/api/teams/adaptive-runs/${RUN_A}/review-panel`)).toBe(true);

    // Client-side navigation to Scenario C — the component is NOT remounted
    // (same instance, new `runId` prop), exactly like `/team/reviews/[runId]`
    // never remounting across a Link navigation.
    await act(async () => {
      renderer!.update(createElement(AdaptiveMultiReviewerPanelSection, { runId: RUN_C, expectedGovernanceUpdatedAt: "2026-01-01T00:00:00.000Z" }));
    });
    await flush();

    expect(deferredsByUrl.has(`/api/teams/adaptive-runs/${RUN_C}/review-panel`)).toBe(true);

    // Scenario C's fetch resolves first (fast).
    deferredsByUrl.get(`/api/teams/adaptive-runs/${RUN_C}/review-panel`)!.resolve(SCENARIO_C_WAITING);
    deferredsByUrl.get(`/api/teams/adaptive-runs/${RUN_C}/assignment`)!.resolve(ASSIGNMENT_RESPONSE);
    await flush();

    expect(renderedText(renderer!)).toContain("Waiting for more reviewer votes.");
    expect(renderedText(renderer!)).toContain("1 of 3 reviewers voted");

    // Scenario A's stale fetch FINALLY resolves late, after C is already
    // rendered correctly. Without the abort/staleness guard, this would
    // overwrite the panel with Scenario A's "ready to finalize" data even
    // though the URL/runId is now Scenario C.
    deferredsByUrl.get(`/api/teams/adaptive-runs/${RUN_A}/review-panel`)!.resolve(SCENARIO_A_READY);
    deferredsByUrl.get(`/api/teams/adaptive-runs/${RUN_A}/assignment`)!.resolve(ASSIGNMENT_RESPONSE);
    await flush();

    const finalText = renderedText(renderer!);
    expect(finalText).toContain("Waiting for more reviewer votes.");
    expect(finalText).toContain("1 of 3 reviewers voted");
    expect(finalText).not.toContain("Ready to finalize");
    expect(finalText).not.toContain("2 of 3 reviewers voted");
  });
});
