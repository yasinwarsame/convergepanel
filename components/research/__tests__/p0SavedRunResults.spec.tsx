/**
 * P0 research-results restoration (2026-11-01). A completed saved run must never render as an unexecuted question.
 *
 * Production symptom: four of five models answered (Gemini failed), the run was saved, the saved read returned 200,
 * and the report page showed "No unified answer yet. Run the panel to generate…" with every saved response hidden.
 *
 * Chain under test, every layer real except the I/O seams:
 *   Firestore-shaped run document (JSON round-tripped)
 *     -> buildRunReadPayload()            [the read API's own builder]
 *     -> interpretPersistedRunReadPayload() / interpretTeamRunDetailResponse()
 *     -> <PersistedResearchResultView>    [the one shared Personal + Team renderer]
 *     -> <ResultsDisplay>                 [real component; only react-markdown is stubbed, as elsewhere]
 * The seams: authedFetch (must never be called) and the review-routing resolver.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
// One stable object: a fresh `user` per call would re-key useUserPlan's effect on every render (a test-only loop).
const AUTH = { user: { uid: "owner-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ResultsDisplay from "@/components/ResultsDisplay";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import { UNAVAILABLE_ANALYSIS_SECTIONS } from "@/components/research/ResponsesWithoutAnalysis";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import { interpretTeamRunDetailResponse } from "@/lib/research/teamRunDetailPresentation";

const RUN_ID = "run-p0-fixture-1";
const WS = "aTeamWorkspaceAutoId12345";
const PROJECT = "projAutoId0001";
const ANSWERS: Record<string, string> = {
  chatgpt: "ChatGPT: automation displaces routine roles first.",
  claude: "Claude: net effect depends on adoption speed.",
  grok: "Grok: new categories of work offset losses.",
  perplexity: "Perplexity: studies disagree on the ten-year horizon.",
};
const FORBIDDEN = [/No unified answer yet/i, /Run the panel to generate/i];

const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** The production shape: four completed models, Gemini failed, no adaptive envelope, no legacy envelope, no synthesis. */
function savedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const perModel = [
    ...Object.entries(ANSWERS).map(([modelId, text]) => ({ modelId, status: "ok", rawTextTruncated: text, tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, latencyMs: 900, wasTruncated: false })),
    { modelId: "gemini", status: "error", rawTextTruncated: "Gemini request failed. Please try again.", tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 250, wasTruncated: false },
  ];
  return roundTrip({
    userId: "owner-1",
    question: "Will AI eliminate more jobs than it creates in the next 10 years?",
    selectedModels: ["chatgpt", "claude", "grok", "perplexity", "gemini"],
    status: "complete",
    runDocument: { perModel },
    ...overrides,
  });
}

async function payloadFor(data: Record<string, unknown>, viewerRole: "owner" | "team_member" = "owner") {
  const p = await buildRunReadPayload({ mayReadDecisionContent: true, runId: RUN_ID, data, viewerRole, resolveReviewRouting: jest.fn().mockResolvedValue("not_configured") });
  return roundTrip(p) as Record<string, unknown>;
}

async function mount(element: ReturnType<typeof createElement>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(element);
  });
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
}

function textOf(r: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (n == null) return;
    if (typeof n === "string") return void out.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as { children?: unknown[] };
    (node.children ?? []).forEach(walk);
  };
  walk(r.toJSON());
  return out.join("");
}

const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);

async function renderPersonal(data: Record<string, unknown>) {
  const interp = interpretPersistedRunReadPayload(await payloadFor(data), RUN_ID);
  expect(interp.kind).toBe("ready");
  if (interp.kind !== "ready") throw new Error("not ready");
  return mount(createElement(PersistedResearchResultView, { presentation: interp.presentation }));
}

/**
 * The invariant is "no model call and no write": no POST, and nothing to the run or synthesis endpoints. A read-only
 * GET (the existing usage/plan lookup some surfaces mount) is pre-existing behaviour and is allowed.
 */
function expectNoExecutionOrSynthesisCall() {
  for (const [url, init] of mockedAuthedFetch.mock.calls as [string, { method?: string } | undefined][]) {
    expect([url, init?.method ?? "GET"]).not.toEqual(expect.arrayContaining(["POST"]));
    expect(String(url)).not.toMatch(/\/api\/(synthesize-panel|run-panel|workspaces\/[^/]+\/runs$)/);
  }
}

beforeEach(() => {
  mockedAuthedFetch.mockReset();
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function expectResponsesShown(r: TestRenderer.ReactTestRenderer) {
  const text = textOf(r);
  for (const f of FORBIDDEN) expect(text).not.toMatch(f);
  const shown = byTestId(r, "saved-model-response").map((n) => n.props["data-model-id"]);
  expect(shown).toEqual(["chatgpt", "claude", "grok", "perplexity"]);
  for (const answer of Object.values(ANSWERS)) expect(text).toContain(answer);
  expect(text).toMatch(/4 of 5 models returned a response/);
  // Each analysis section is named and labelled unavailable, inside the status list. Nothing is inferred.
  const sections = instText(byTestId(r, "unavailable-analysis-sections")[0]);
  for (const name of UNAVAILABLE_ANALYSIS_SECTIONS) expect(sections).toContain(`${name}: unavailable`);
  // The failed model is listed with its recorded status, and its error text is not presented as an answer.
  expect(byTestId(r, "failed-models")).toHaveLength(1);
  // The saved read normalizes a stored "error" row to its public status, "failed"; the UI shows the recorded status.
  expect(instText(byTestId(r, "failed-models")[0])).toMatch(/: failed$/);
  expect(text).not.toContain("Gemini request failed");
}

/** Text content of one rendered node. */
function instText(inst: TestRenderer.ReactTestInstance | undefined): string {
  if (!inst) return "";
  return inst.children.map((c) => (typeof c === "string" ? c : instText(c))).join("");
}

describe("P0 — saved run with model responses but no saved analysis", () => {
  it("Personal: shows all four saved responses with their models, labels the missing analysis, and makes zero calls", async () => {
    const r = await renderPersonal(savedRun());
    expectResponsesShown(r);
    expect(byTestId(r, "responses-without-analysis")[0].props["data-state"]).toBe("analysis-unavailable");
    expectNoExecutionOrSynthesisCall();
  });

  it("the state survives a refresh: a second independent read and render of the same document is identical", async () => {
    const first = textOf(await renderPersonal(savedRun()));
    const second = textOf(await renderPersonal(savedRun()));
    expect(second).toBe(first);
    expectNoExecutionOrSynthesisCall();
  });

  it("Team project research: the same document through the Team response and interpreter renders the same responses", async () => {
    const payload = await payloadFor(savedRun({ workspaceId: WS, projectId: PROJECT }), "team_member");
    const raw = { ...payload, team: { workspaceId: WS, projectId: PROJECT, project: null, assignee: null, createdAt: null, completedAt: null, origin: null, review: null } };
    const interp = interpretTeamRunDetailResponse(roundTrip(raw), { workspaceId: WS, runId: RUN_ID, projectId: PROJECT });
    expect(interp.kind).toBe("ready");
    if (interp.kind !== "ready") throw new Error("not ready");
    const r = await mount(createElement(PersistedResearchResultView, { presentation: interp.presentation, adaptiveAncillaryPresentation: { mode: "delegated_read_only" } as never }));
    expectResponsesShown(r);
    expectNoExecutionOrSynthesisCall();
  });

  it("with a saved synthesis the original comprehensive view renders unchanged, and the fallback does not appear", async () => {
    const r = await renderPersonal(savedRun({ synthesizedStructuredReport: { headline: "Saved synthesis headline" }, schemaVersion: 1, synthesizedBy: "chatgpt" }));
    expect(byTestId(r, "responses-without-analysis")).toHaveLength(0);
    // Positive: the comprehensive view itself rendered (its own headings), not merely "the fallback is absent".
    const text = textOf(r);
    expect(text).toContain("Unified Answer");
    expect(text).toContain("Trust Summary");
    expectNoExecutionOrSynthesisCall();
  });

  it("with a saved adaptive envelope the adaptive renderer is used, and the fallback does not appear", async () => {
    const env = {
      version: 1,
      schemaId: "procedural",
      classification: { queryType: "procedural", confidence: 0.7 },
      generatedAt: "2026-09-01T00:00:00.000Z",
      results: [{ modelId: "chatgpt", status: "ok", data: {} }],
      alignedClaims: [],
    };
    const r = await renderPersonal(savedRun({ legacyAdaptiveOutput: env }));
    expect(byTestId(r, "responses-without-analysis")).toHaveLength(0);
    // Positive: the adaptive renderer is the one mounted, with the saved schema.
    const adaptive = r.root.findAllByType(AdaptivePanelResponse as never);
    expect(adaptive).toHaveLength(1);
    expect((adaptive[0].props as { schema: { id: string } }).schema.id).toBe("procedural");
  });

  it("a model that succeeded with no text is listed, not hidden, and the heading counts exactly the responses shown", async () => {
    const doc = savedRun();
    (doc.runDocument as { perModel: { modelId: string; rawTextTruncated: string }[] }).perModel[3].rawTextTruncated = "";
    const r = await renderPersonal(doc);
    expect(byTestId(r, "saved-model-response").map((n) => n.props["data-model-id"])).toEqual(["chatgpt", "claude", "grok"]);
    expect(textOf(r)).toMatch(/3 of 5 models returned a response/);
    const missing = instText(byTestId(r, "failed-models")[0]);
    expect(missing).toMatch(/returned no text/);
    expect(missing).toMatch(/: failed/);
  });

  it("a governance-flagged run keeps its Team banner and org status above the saved responses", async () => {
    const r = await renderPersonal(savedRun({ teamGovernance: { governanceReviewRequired: true, blocked: true, blockMessage: "Blocked: contains regulated data", policyFlags: ["pii"] }, governanceStatus: "blocked" }));
    const text = textOf(r);
    expect(text).toContain("Blocked by your team's governance policy");
    expect(text).toContain("Blocked: contains regulated data");
    expect(instText(byTestId(r, "org-governance-status")[0])).toMatch(/blocked by your organization's governance policy/);
    expect(byTestId(r, "saved-model-response")).toHaveLength(4);
  });

  it("every model failed: says no usable response, lists every model, never invites re-running a completed run", async () => {
    const perModel = ["chatgpt", "claude", "gemini"].map((modelId) => ({ modelId, status: "error", rawTextTruncated: "", tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 1, wasTruncated: false }));
    const r = await renderPersonal(savedRun({ runDocument: { perModel } }));
    const text = textOf(r);
    for (const f of FORBIDDEN) expect(text).not.toMatch(f);
    expect(byTestId(r, "responses-without-analysis")[0].props["data-state"]).toBe("no-usable-response");
    expect(text).toMatch(/No model returned a usable response/);
    expect(byTestId(r, "saved-model-response")).toHaveLength(0);
    expect(text.match(/: failed/g)).toHaveLength(3);
  });

  it("a saved run still in progress or failed is not rendered as a result (the shells show their own state)", async () => {
    expect(interpretPersistedRunReadPayload(await payloadFor(savedRun({ status: "running" })), RUN_ID).kind).toBe("in_progress");
    expect(interpretPersistedRunReadPayload(await payloadFor(savedRun({ status: "failed" })), RUN_ID).kind).toBe("failed");
  });
});

describe("P0 — the live composer (default synthesis policy) is unchanged apart from the fallback copy", () => {
  const live = (extra: Record<string, unknown> = {}) => ({
    results: Object.entries(ANSWERS).map(([modelId, text]) => ({ modelId, status: "ok", rawTextFull: text, rawText: text, latencyMs: 1, tokenUsage: { totalTokens: 1 } })),
    synthesizedReport: null,
    onRerun: () => {},
    onAddModel: () => {},
    question: "Q?",
    runId: "run-live-1",
    synthesisReport: null,
    adaptive: null,
    ...extra,
  });

  it("while synthesis is generating, the responses are shown with the analysis marked pending", async () => {
    const r = await mount(createElement(ResultsDisplay as never, live({ synthesisStatus: "loading" }) as never));
    expect(byTestId(r, "responses-without-analysis")[0].props["data-state"]).toBe("analysis-pending");
    expect(textOf(r)).toContain("Unified Answer: pending");
    expect(byTestId(r, "saved-model-response")).toHaveLength(4);
  });

  it("idle with no report still makes exactly the one established synthesis POST (unchanged behaviour)", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const r = await mount(createElement(ResultsDisplay as never, live({ synthesisStatus: "idle" }) as never));
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    // The live page may still produce the synthesis: it must say "not available yet", never "not available for this run".
    expect(byTestId(r, "responses-without-analysis")[0].props["data-state"]).toBe("analysis-not-yet");
    expect(textOf(r)).toContain("Unified Answer: not available yet");
    expect(textOf(r)).not.toContain("exactly as they were saved");
    expect(mockedAuthedFetch.mock.calls[0][0]).toBe("/api/synthesize-panel");
  });
});
