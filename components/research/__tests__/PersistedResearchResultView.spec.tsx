/**
 * TEAM-RESEARCH-PARITY-R2 §K/§R/§U — `PersistedResearchResultView` contract.
 * `ResultsDisplay` is stubbed (it has its own real-render policy suite); what
 * matters here is exactly WHAT the shared view hands down, that it fetches
 * nothing, and that it accepts Team presentations without Personal assumptions.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const captured: Record<string, unknown>[] = [];
jest.mock("@/components/ResultsDisplay", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    captured.push(props);
    return require("react").createElement("div", { "data-testid": "results-display" });
  },
}));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import type { PersistedResearchPresentation } from "@/lib/research/persistedRunPresentation";
import { interpretPersistedRunReadPayload, MALFORMED_STRUCTURED_RESULT_NOTICE } from "@/lib/research/persistedRunPresentation";
import { deepResearchAdaptiveOutput, legacyAdaptiveOutput } from "@/lib/runs/__tests__/runReadFixtures";

const RUN = "run-9";
const rows = [
  { modelId: "chatgpt", status: "ok", rawText: "one" },
  { modelId: "claude", status: "ok", rawText: "two" },
] as never[];

function presentation(over: Partial<PersistedResearchPresentation> = {}): PersistedResearchPresentation {
  return {
    runId: RUN,
    viewerRole: "owner",
    question: "What changed?",
    results: rows,
    adaptive: null,
    restoreNotice: null,
    synthesisReport: null,
    synthesisConsensusSummary: null,
    orgGovernanceStatus: null,
    governance: undefined,
    ...over,
  };
}

function mount(props: Record<string, unknown>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(PersistedResearchResultView as never, props as never));
  });
  return renderer;
}
const last = () => captured[captured.length - 1];

beforeEach(() => {
  captured.length = 0;
  mockedAuthedFetch.mockReset();
  jest.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
    throw new Error("the shared result view must never fetch");
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

describe("PersistedResearchResultView — wiring", () => {
  it("ordinary results: hands the presentation to ResultsDisplay read-only with synthesis generation DISABLED", () => {
    mount({ presentation: presentation() });
    expect(captured).toHaveLength(1);
    expect(last()).toMatchObject({
      results: rows,
      synthesizedReport: null,
      question: "What changed?",
      runId: RUN,
      adaptive: null,
      synthesisStatus: "idle",
      synthesisReport: null,
      synthesisConsensusSummary: null,
      orgGovernanceStatus: null,
      readOnlyActions: true,
      allowSynthesisGeneration: false,
    });
    expect(typeof last().onRerun).toBe("function");
    expect(typeof last().onAddModel).toBe("function");
  });

  it("adaptive result and legacy-adaptive result (after interpretation) are passed through as the adaptive payload", () => {
    const adaptive = interpretPersistedRunReadPayload({ ok: true, runId: RUN, viewerRole: "owner", status: "complete", results: [], adaptive: { status: "valid", output: deepResearchAdaptiveOutput() } }, RUN);
    if (adaptive.kind !== "ready") throw new Error("unreachable");
    mount({ presentation: adaptive.presentation });
    expect((last().adaptive as { schemaId: string }).schemaId).toBe("deep_research");

    const legacy = interpretPersistedRunReadPayload({ ok: true, runId: RUN, viewerRole: "owner", status: "complete", results: rows, legacyAdaptive: { status: "valid", output: legacyAdaptiveOutput() } }, RUN);
    if (legacy.kind !== "ready") throw new Error("unreachable");
    mount({ presentation: legacy.presentation });
    expect((last().adaptive as { schemaId: string }).schemaId).toBe("procedural");
  });

  it("restore notice renders above the report; none renders when null", () => {
    const withNotice = mount({ presentation: presentation({ restoreNotice: MALFORMED_STRUCTURED_RESULT_NOTICE }) });
    const text = JSON.stringify(withNotice.toJSON());
    expect(text).toContain(MALFORMED_STRUCTURED_RESULT_NOTICE);
    expect(text.indexOf("couldn't be restored")).toBeLessThan(text.indexOf("results-display"));
    const without = mount({ presentation: presentation() });
    expect(JSON.stringify(without.toJSON())).not.toContain("restored");
  });

  it("persisted synthesis is passed through and marks synthesis complete; governance and org status pass through", () => {
    mount({ presentation: presentation({ synthesisReport: { headline: "R" }, synthesisConsensusSummary: { agreement: 0.5 }, orgGovernanceStatus: "needs_review", governance: { governanceReviewRequired: true } }) });
    expect(last()).toMatchObject({ synthesisStatus: "complete", synthesisReport: { headline: "R" }, synthesisConsensusSummary: { agreement: 0.5 }, orgGovernanceStatus: "needs_review", teamGovernance: { governanceReviewRequired: true } });
  });
});

describe("PersistedResearchResultView — delegated actions", () => {
  it("optional verify-claim and follow-up callbacks are handed down unchanged", () => {
    const onVerifyClaim = jest.fn();
    const onRunFollowUp = jest.fn();
    mount({ presentation: presentation(), onVerifyClaim, onRunFollowUp });
    (last().onVerifyClaim as (a: unknown) => void)({ runId: RUN, claimId: "c1" });
    (last().onRunFollowUp as (q: string) => void)("next?");
    expect(onVerifyClaim).toHaveBeenCalledWith({ runId: RUN, claimId: "c1" });
    expect(onRunFollowUp).toHaveBeenCalledWith("next?");
  });

  it("absence of callbacks fabricates NO action (undefined is handed down, never a Personal route)", () => {
    mount({ presentation: presentation() });
    expect(last().onVerifyClaim).toBeUndefined();
    expect(last().onRunFollowUp).toBeUndefined();
  });

  it("the execution callbacks are inert no-ops (read-only surface)", () => {
    mount({ presentation: presentation() });
    expect(() => (last().onRerun as () => void)()).not.toThrow();
    expect(() => (last().onAddModel as () => void)()).not.toThrow();
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
  });
});

describe("PersistedResearchResultView — Team forward-compatibility (§R) and read-only guarantees", () => {
  it.each(["team_member", "team_reviewer"] as const)("accepts a %s presentation without assuming Personal ownership and renders no Personal-only controls", (role) => {
    const r = mount({ presentation: presentation({ viewerRole: role }) });
    expect(last()).toMatchObject({ runId: RUN, readOnlyActions: true, allowSynthesisGeneration: false });
    const text = JSON.stringify(r.toJSON());
    expect(text).not.toContain("Add to Team Project");
    expect(text).not.toContain("Back to Research");
    expect(text).not.toContain("/workspace/research/");
  });

  it("renders identically for every role — role never changes what the shared view hands down", () => {
    const seen = new Set<string>();
    for (const role of ["owner", "personal_reviewer", "team_member", "team_reviewer"] as const) {
      mount({ presentation: presentation({ viewerRole: role }) });
      const { onRerun: _a, onAddModel: _b, ...rest } = last();
      seen.add(JSON.stringify(rest));
    }
    expect(seen.size).toBe(1);
  });

  it("performs no API read and no fetch of its own", () => {
    mount({ presentation: presentation() });
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
