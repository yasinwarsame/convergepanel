/**
 * TEAM-RESEARCH-PARITY-R2 §N/§O/§V — the Personal shell after extraction.
 * Same harness discipline as `PersonalResearchDetailShell.spec.tsx` (which
 * still covers the full load-arbitration matrix): the shell is REAL, the shared
 * interpreter is REAL, `ResultsDisplay` is stubbed to observe what reaches it.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never) }));
const mockedUseAuth = jest.fn();
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockedUseAuth() }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ teamWorkspacesUiEnabled: false }) }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
const resultsProps: Record<string, unknown>[] = [];
jest.mock("@/components/ResultsDisplay", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    resultsProps.push(props);
    return require("react").createElement("div", { "data-testid": "results-display" });
  },
}));

import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";
import { NEWER_VERSION_STRUCTURED_RESULT_NOTICE } from "@/lib/research/persistedRunPresentation";

const AUTH = { user: { uid: "uid_alice" }, authReady: true };
const RUN = "run-7";
const okRun = (over: Record<string, unknown> = {}) => ({
  ok: true,
  runId: RUN,
  question: "What changed?",
  status: "complete",
  viewerRole: "owner",
  results: [{ modelId: "chatgpt", status: "ok", rawText: "answer" }, { modelId: "claude", status: "ok", rawText: "answer 2" }],
  adaptive: { status: "absent", output: null },
  legacyAdaptive: { status: "absent", output: null },
  ...over,
});

async function mountWith(body: unknown, status = 200) {
  mockedAuthedFetch.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(createElement(PersonalResearchDetailShell, { runId: RUN }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return renderer;
}
const text = (r: TestRenderer.ReactTestRenderer) => JSON.stringify(r.toJSON());
const last = () => resultsProps[resultsProps.length - 1];

beforeEach(() => {
  jest.clearAllMocks();
  resultsProps.length = 0;
  mockedUseAuth.mockReturnValue(AUTH);
});

describe("PersonalResearchDetailShell — R2 read-only synthesis policy", () => {
  it("the durable Personal report hands ResultsDisplay allowSynthesisGeneration=false AND readOnlyActions=true", async () => {
    await mountWith(okRun());
    expect(resultsProps).toHaveLength(1);
    expect(last()).toMatchObject({ allowSynthesisGeneration: false, readOnlyActions: true, runId: RUN, synthesisStatus: "idle" });
  });

  it("only the persisted synthesis is shown: a cached report yields synthesisStatus complete, none yields idle — never a generation", async () => {
    await mountWith(okRun({ synthesisCache: { report: { headline: "R" }, schemaVersion: 1, synthesizedBy: "cached", consensusSummary: null } }));
    expect(last()).toMatchObject({ synthesisStatus: "complete", synthesisReport: { headline: "R" }, allowSynthesisGeneration: false });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    expect((mockedAuthedFetch.mock.calls[0][0] as string).startsWith("/api/user/runs/")).toBe(true);
  });
});

describe("PersonalResearchDetailShell — R2 containment stays Personal-owned (§O)", () => {
  it.each(["team_member", "team_reviewer"])("a %s response on the Personal address renders the CONCEALED unavailable state, not a report", async (role) => {
    const r = await mountWith(okRun({ viewerRole: role }));
    expect(text(r)).toContain("This research isn");
    expect(resultsProps).toHaveLength(0);
  });

  it("a Team role wins over a mismatched run id (containment is decided before interpretation, exactly as before)", async () => {
    const r = await mountWith(okRun({ viewerRole: "team_member", runId: "run-8" }));
    expect(text(r)).toContain("This research isn");
  });

  it.each([undefined, "admin", "", 3])("a missing/unknown viewerRole %p is MALFORMED (fails closed), never rendered and never 'unavailable'", async (role) => {
    const r = await mountWith(okRun({ viewerRole: role }));
    expect(text(r)).toContain("couldn&#x27;t be displayed".replace("&#x27;", "'"));
    expect(text(r)).not.toContain("This research isn");
    expect(resultsProps).toHaveLength(0);
  });

  it("owner and personal_reviewer reach a rendered report with the response's role", async () => {
    await mountWith(okRun({ viewerRole: "personal_reviewer" }));
    expect(resultsProps).toHaveLength(1);
    await mountWith(okRun({ viewerRole: "owner" }));
    expect(resultsProps).toHaveLength(2);
  });

  it("a mismatched run id for a Personal role is malformed", async () => {
    const r = await mountWith(okRun({ runId: "run-8" }));
    expect(text(r)).toContain("couldn't be displayed");
    expect(resultsProps).toHaveLength(0);
  });
});

describe("PersonalResearchDetailShell — R2 interpreted states", () => {
  it("in_progress and failed carry the question through the shared interpreter", async () => {
    const a = await mountWith(okRun({ status: "running" }));
    expect(text(a)).toContain("still in progress");
    expect(text(a)).toContain("What changed?");
    const b = await mountWith(okRun({ status: "failed" }));
    expect(text(b)).toContain("didn't finish successfully");
  });

  it("unsupported-version structured result → the newer-version restore notice above the raw rows", async () => {
    const r = await mountWith(okRun({ adaptive: { status: "unsupported_version", output: null } }));
    expect(text(r)).toContain(NEWER_VERSION_STRUCTURED_RESULT_NOTICE);
    expect(last()).toMatchObject({ adaptive: null });
    expect((last().results as unknown[]).length).toBe(2);
  });

  it("a completed run with no structured output and no rows is malformed, not an empty report", async () => {
    const r = await mountWith(okRun({ results: [] }));
    expect(text(r)).toContain("couldn't be displayed");
    expect(resultsProps).toHaveLength(0);
  });
});
