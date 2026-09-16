/**
 * TEAM-RESEARCH-PARITY-R2-C1 §H — the AUTHORITATIVE Team-forward-compatibility
 * proof: `PersistedResearchResultView` rendered with the REAL `ResultsDisplay`
 * (ESM markdown deps replaced by trivial factories), for a Team viewer with
 * exactly one successful model, no delegated destination, no adaptive result,
 * no delegated actions. The stubbed suite cannot see this DOM; this one can.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
const AUTH = { user: { uid: "uid-team" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import type { PersistedResearchPresentation } from "@/lib/research/persistedRunPresentation";

const RUN = "run-team-1";
function single(role: PersistedResearchPresentation["viewerRole"]): PersistedResearchPresentation {
  return {
    runId: RUN,
    viewerRole: role,
    question: "Team question?",
    results: [{ modelId: "chatgpt", status: "ok", rawTextFull: "The only answer text", rawText: "The only answer text", tokenUsage: { totalTokens: 3 }, latencyMs: 12 }] as never[],
    adaptive: null,
    restoreNotice: null,
    synthesisReport: null,
    synthesisConsensusSummary: null,
    orgGovernanceStatus: null,
    governance: undefined,
  };
}
async function mount(props: Record<string, unknown>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(PersistedResearchResultView as never, props as never));
  });
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
}
const anchors = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a").map((n) => n.props.href as string);
const buttonText = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "button").map((n) => JSON.stringify(n.children)).join("|");
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(globalThis, "fetch" as never).mockImplementation((() => {
    throw new Error("no fetch from the shared view");
  }) as never);
});
afterEach(() => jest.restoreAllMocks());

describe("PersistedResearchResultView — REAL render, Team viewer, one successful model, no destination (§H)", () => {
  it.each(["team_member", "team_reviewer"] as const)("%s: no <a href='/'>, no anchor at all, no Personal controls or URLs, no execution buttons, content renders, zero synthesis POST", async (role) => {
    const r = await mount({ presentation: single(role) });
    expect(anchors(r)).toEqual([]);
    expect(text(r)).not.toContain('"href":"/"');
    expect(text(r)).not.toContain("Add to Team Project");
    expect(text(r)).not.toContain("/workspace/research/");
    expect(text(r)).not.toContain("Back to Research");
    expect(text(r)).not.toContain("To run this question again");
    expect(buttonText(r)).not.toContain("Re-run");
    expect(buttonText(r)).not.toContain("Add Another Model");
    expect(text(r)).toContain("This saved report is read-only.");
    expect(text(r)).toContain("Only One Model Responded");
    expect(mockedAuthedFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("a Team caller that DOES delegate a destination gets exactly that destination — the view still chooses nothing itself", async () => {
    const r = await mount({ presentation: single("team_member"), readOnlyExecutionTarget: { href: "/workspace/team/ws1/research", label: "Team research" } });
    expect(anchors(r)).toEqual(["/workspace/team/ws1/research"]);
    expect(text(r)).toContain("Team research");
  });

  it("the Personal caller's delegated destination reproduces the established Personal pointer (href '/', label 'Research')", async () => {
    const r = await mount({ presentation: single("owner"), readOnlyExecutionTarget: { href: "/", label: "Research" } });
    expect(anchors(r)).toEqual(["/"]);
    expect(text(r)).toContain("To run this question again");
  });
});
