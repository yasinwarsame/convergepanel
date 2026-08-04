/**
 * Regression test for the "Create a multi-reviewer panel" button rendering
 * unconditionally in `AdaptiveMultiReviewerPanelSection` even when the
 * server would reject creation (`403 multi_reviewer_disabled` — global gate
 * off, or team opt-in off). The fix reads a server-derived `canCreatePanel`
 * capability flag (added to `GET .../review-panel`'s panel-absent response)
 * instead of showing the button unconditionally whenever `panel === null`.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({
  useAuth: () => mockedUseAuth(),
}));

function panelAbsentResponse(canCreatePanel: boolean) {
  return { ok: true, json: async () => ({ ok: true, version: 1, panel: null, canCreatePanel }) };
}
const ASSIGNMENT_RESPONSE = { ok: true, json: async () => ({ ok: true, eligibleReviewers: [] }) };

const authedFetchMock = jest.fn((url: string, _opts?: unknown): Promise<any> => {
  if (url.includes("/assignment")) return Promise.resolve(ASSIGNMENT_RESPONSE);
  throw new Error(`Unexpected authedFetch call in this test: ${url}`);
});
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: [string, unknown]) => authedFetchMock(...args),
}));

import AdaptiveMultiReviewerPanelSection from "@/components/teamGovernance/AdaptiveMultiReviewerPanelSection";

const RUN_ID = "run-1";

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(collect).join("");
    if (node && typeof node === "object" && "children" in (node as any)) return collect((node as any).children);
    return "";
  };
  return collect(renderer.toJSON());
}

beforeEach(() => {
  authedFetchMock.mockClear();
  mockedUseAuth.mockReturnValue({ user: { uid: "owner-uid" }, authReady: true, canMutate: true });
});

describe("AdaptiveMultiReviewerPanelSection — canCreatePanel gating", () => {
  it("hides the Create Panel button when the server reports canCreatePanel: false (e.g. global gate off or team not opted in)", async () => {
    authedFetchMock.mockImplementationOnce((url: string) => (url.includes("/review-panel") ? Promise.resolve(panelAbsentResponse(false)) : Promise.resolve(ASSIGNMENT_RESPONSE)));

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(AdaptiveMultiReviewerPanelSection, { runId: RUN_ID, expectedGovernanceUpdatedAt: "2026-01-01T00:00:00.000Z" }));
    });
    await flush();

    const text = renderedText(renderer!);
    expect(text).toContain("No multi-reviewer panel exists for this run.");
    expect(text).not.toContain("Create a multi-reviewer panel");
  });

  it("shows the Create Panel button when the server reports canCreatePanel: true", async () => {
    authedFetchMock.mockImplementationOnce((url: string) => (url.includes("/review-panel") ? Promise.resolve(panelAbsentResponse(true)) : Promise.resolve(ASSIGNMENT_RESPONSE)));

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(AdaptiveMultiReviewerPanelSection, { runId: RUN_ID, expectedGovernanceUpdatedAt: "2026-01-01T00:00:00.000Z" }));
    });
    await flush();

    expect(renderedText(renderer!)).toContain("Create a multi-reviewer panel");
  });
});
