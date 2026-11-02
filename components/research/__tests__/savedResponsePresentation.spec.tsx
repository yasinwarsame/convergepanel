/**
 * Team research presentation fix (owner directive 2026-11-02).
 *
 * Production symptom (owner screenshots, Team project research): saved ChatGPT / Claude / Grok / Perplexity responses
 * shown as raw JSON blocks, Gemini failed, every combined-analysis section unavailable, and a title ending in the
 * product's former empty-state sentence twice.
 *
 * Root cause: a saved run with no persisted analysis envelope (every generic run saved before #274, while Gemini
 * classification failed) is rendered by ResponsesWithoutAnalysis, which printed each response's text verbatim. Generic
 * answers are structured JSON, so the reader saw JSON. The same view serves Individual and Team.
 *
 * Chain under test (all real except I/O seams): Firestore-shaped run → buildRunReadPayload → Team endpoint body →
 * TeamResearchDetailShell (Team) / interpretPersistedRunReadPayload → PersistedResearchResultView (Individual) →
 * ResultsDisplay → ResponsesWithoutAnalysis. Assertions are on visible text.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
const PLAN = { plan: "full", loading: false };
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => PLAN }));
const AUTH = { user: { uid: "uid-team" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";
import { WorkspaceRunCard } from "@/components/workspace/WorkspaceRunCard";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import { FIXTURE_PROJECT_ID, FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID, fullTeamRunData } from "@/lib/runs/__tests__/runReadFixtures";
import {
  LEGACY_EMPTY_STATE_SENTENCE,
  MAX_STRUCTURED_DEPTH,
  MAX_STRUCTURED_PARSE_CHARS,
  displayResearchQuestion,
  parseStructuredResponse,
} from "@/lib/research/savedResponseDisplay";

const QUESTION = "Is a billion-dollar solo company possible?";
const POLLUTED = `${QUESTION} ${LEGACY_EMPTY_STATE_SENTENCE} ${LEGACY_EMPTY_STATE_SENTENCE}`;

/** A generic-schema answer exactly as a model returns it. */
const genericAnswer = (who: string) => ({
  summary: `${who} summary: possible with heavy automation.`,
  keyClaims: [{ claim: `${who} claim: AI agents replace early hires.`, confidence: "majority_view", evidence: `${who} evidence: small-team exits.` }],
  uncertainties: [`${who} uncertainty: valuation versus revenue.`],
  followUps: [`${who} follow-up: which sectors?`],
  camps: [{ position: `${who} camp: plausible within a decade`, models: [who] }],
});
const fenced = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

const PLAIN = "Perplexity plain answer: unlikely before 2035.";
const MALFORMED = '{"summary": "Grok cut-off answer", "keyClaims": [';

function perModel(rows: [string, string, string][]) {
  return rows.map(([modelId, status, text]) => ({ modelId, status, rawTextTruncated: text, tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 10, wasTruncated: false }));
}
const SCREENSHOT_ROWS: [string, string, string][] = [
  ["chatgpt", "ok", JSON.stringify(genericAnswer("ChatGPT"))],
  ["claude", "ok", fenced(genericAnswer("Claude"))],
  ["grok", "ok", MALFORMED],
  ["perplexity", "ok", PLAIN],
  ["gemini", "error", "Gemini request failed. Please try again."],
];

/** A historical generic run: no analysis envelope, no synthesis, no governance record. */
function historicalRun(rows = SCREENSHOT_ROWS, question = POLLUTED): Record<string, unknown> {
  return {
    ...fullTeamRunData({ question, runDocument: { perModel: perModel(rows) }, selectedModels: rows.map((r) => r[0]) }),
    adaptiveOutput: undefined,
    legacyAdaptiveOutput: undefined,
    governanceRecord: undefined,
    synthesizedStructuredReport: undefined,
    schemaVersion: undefined,
    synthesizedBy: undefined,
    synthesisConsensusSummary: undefined,
  };
}

async function body(data: Record<string, unknown>, viewerRole: RunReadViewerRole = "team_member") {
  const payload = await buildRunReadPayload({ runId: FIXTURE_RUN_ID, data, viewerRole, mayReadDecisionContent: true, resolveReviewRouting: async () => "not_configured" });
  const team = { workspaceId: FIXTURE_WORKSPACE_ID, projectId: FIXTURE_PROJECT_ID, project: { id: FIXTURE_PROJECT_ID, name: "First Sept Project", status: "active" }, assignee: null, createdAt: null, completedAt: null, origin: null, review: null };
  return JSON.parse(JSON.stringify({ ...payload, team }));
}

async function settle(el: ReturnType<typeof createElement>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  for (let i = 0; i < 5; i += 1) await act(async () => void (await new Promise((res) => setTimeout(res, 0))));
  return r;
}
const TEAM_PROPS = { workspaceId: FIXTURE_WORKSPACE_ID, workspaceName: "Acme Team", runId: FIXTURE_RUN_ID, project: { id: FIXTURE_PROJECT_ID, name: "First Sept Project" }, showMembers: true, showAudit: false };
async function renderTeam(responseBody: unknown, status = 200) {
  mockedAuthedFetch.mockResolvedValue({ ok: status === 200, status, json: async () => responseBody });
  return settle(createElement(TeamResearchDetailShell, TEAM_PROPS));
}
async function renderIndividual(data: Record<string, unknown>) {
  const p = await buildRunReadPayload({ runId: FIXTURE_RUN_ID, data, viewerRole: "owner", mayReadDecisionContent: true, resolveReviewRouting: async () => "not_configured" });
  const interp = interpretPersistedRunReadPayload(JSON.parse(JSON.stringify(p)), FIXTURE_RUN_ID);
  if (interp.kind !== "ready") throw new Error(`not ready: ${interp.kind}`);
  return settle(createElement(PersistedResearchResultView, { presentation: interp.presentation }));
}

function text(n: TestRenderer.ReactTestInstance | TestRenderer.ReactTestRenderer): string {
  const root = "root" in n ? n.root : n;
  const out: string[] = [];
  const walk = (x: TestRenderer.ReactTestInstance | string) => (typeof x === "string" ? out.push(x) : x.children.forEach(walk));
  walk(root);
  return out.join("");
}
const byId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);
const responseOf = (r: TestRenderer.ReactTestRenderer, modelId: string) => {
  const hits = byId(r, "saved-model-response").filter((n) => n.props["data-model-id"] === modelId);
  expect(hits).toHaveLength(1);
  return hits[0];
};
/** Visible text of a response, excluding the collapsed "saved text exactly as returned" disclosure. */
const visibleOf = (inst: TestRenderer.ReactTestInstance) => {
  const structured = inst.findAll((n) => n.props["data-testid"] === "saved-response-structured");
  const plain = inst.findAll((n) => n.props["data-testid"] === "saved-response-text");
  return [...structured, ...plain].map(text).join("\n");
};

beforeEach(() => {
  mockedAuthedFetch.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function expectReadableReport(r: TestRenderer.ReactTestRenderer) {
  // Structured JSON (bare and fenced) becomes readable sections; no JSON syntax in what the reader sees.
  for (const [modelId, who] of [["chatgpt", "ChatGPT"], ["claude", "Claude"]] as const) {
    const inst = responseOf(r, modelId);
    expect(inst.findAll((n) => n.props["data-testid"] === "saved-response-structured")).toHaveLength(1);
    const visible = visibleOf(inst);
    const a = genericAnswer(who);
    for (const heading of ["Summary", "Key claims", "Claim", "Confidence", "Evidence", "Uncertainties", "Follow ups", "Camps", "Position"]) expect(visible).toContain(heading);
    // Every saved value is displayed: nothing dropped, nothing reworded.
    for (const v of [a.summary, a.keyClaims[0].claim, a.keyClaims[0].confidence, a.keyClaims[0].evidence, a.uncertainties[0], a.followUps[0], a.camps[0].position]) expect(visible).toContain(v);
    expect(visible).not.toMatch(/[{}]|"summary"|```/);
    // The exact saved text stays available, collapsed.
    const details = inst.findAll((n) => n.type === "details");
    expect(details).toHaveLength(1);
    expect(details[0].props.open).toBeFalsy(); // collapsed by default
    expect(text(details[0].findByType("summary"))).toBe("Show the saved text exactly as stored");
    // Byte-for-byte the saved text: ChatGPT saved bare JSON, Claude saved a fenced block.
    expect(text(details[0].findByType("pre"))).toBe(modelId === "chatgpt" ? JSON.stringify(a) : fenced(a));
  }
  // Malformed structured text and plain text are shown exactly as saved, never dropped.
  expect(visibleOf(responseOf(r, "grok"))).toBe(MALFORMED);
  expect(visibleOf(responseOf(r, "perplexity"))).toBe(PLAIN);
  // Accurate counts and the failed provider.
  const all = text(r);
  expect(all).toContain("4 of 5 models returned a response");
  expect(byId(r, "saved-model-response")).toHaveLength(4);
  const failed = text(byId(r, "failed-models")[0]);
  expect(failed).toMatch(/: did not respond$/);
  expect(failed).not.toMatch(/incompatible format/);
  expect(all).not.toContain("Gemini request failed");
  // Combined analysis is labelled unavailable; nothing is presented as panel consensus.
  for (const name of ["Unified Answer", "Consensus", "Agreement / Disagreement Map", "Synthesis Report"]) expect(all).toContain(`${name}: unavailable`);
  expect(all).not.toMatch(/Trust Summary|Strong consensus|Panel verdict/);
}

function expectNoWriteOrModelCall() {
  for (const [url, init] of mockedAuthedFetch.mock.calls as [string, { method?: string } | undefined][]) {
    expect(init?.method ?? "GET").toBe("GET");
    expect(String(url)).not.toMatch(/\/api\/(synthesize-panel|run-panel)|\/runs$/);
  }
}

describe("Team project research: historical generic run (the screenshot shape)", () => {
  it("renders readable sections, accurate counts, the failed model, and a clean title once; the project link is kept", async () => {
    const r = await renderTeam(await body(historicalRun()));
    expectReadableReport(r);
    const h1 = r.root.findAll((n) => n.type === "h1");
    expect(h1).toHaveLength(1);
    expect(text(h1[0])).toBe(QUESTION);
    expect(text(r)).not.toContain("Run the panel to generate");
    expect(text(r)).toContain("First Sept Project");
    expect(r.root.findAll((n) => n.type === "a" && n.props.href === `/workspace/team/${FIXTURE_WORKSPACE_ID}/projects/${FIXTURE_PROJECT_ID}`).length).toBeGreaterThan(0);
    expectNoWriteOrModelCall();
  });

  it("refresh / reopen: a second independent read renders identically", async () => {
    const first = text(await renderTeam(await body(historicalRun())));
    const second = text(await renderTeam(await body(historicalRun())));
    expect(second).toBe(first);
  });

  it("team_reviewer sees the same readable responses", async () => {
    expectReadableReport(await renderTeam(await body(historicalRun(), "team_reviewer")));
  });

  it("unauthorized workspace access shows the unavailable state and no saved content", async () => {
    const r = await renderTeam({ ok: false, errorCode: "insufficient_capability" }, 403);
    const all = text(r);
    expect(all).toContain("This research isn't available");
    expect(all).not.toContain("ChatGPT summary");
    expect(byId(r, "saved-model-response")).toHaveLength(0);
  });
});

describe("Individual research: the same shared view", () => {
  it("the same document renders the same readable report", async () => {
    expectReadableReport(await renderIndividual(historicalRun()));
  });

  it("the Individual page (real shell) shows the question once as its heading, and the readable report", async () => {
    const p = await buildRunReadPayload({ runId: FIXTURE_RUN_ID, data: historicalRun(), viewerRole: "owner", mayReadDecisionContent: true, resolveReviewRouting: async () => "not_configured" });
    mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(p)) });
    const r = await settle(createElement(PersonalResearchDetailShell, { runId: FIXTURE_RUN_ID }));
    const h1 = r.root.findAll((n) => n.type === "h1");
    expect(h1.map((h) => text(h))).toEqual([QUESTION]);
    expect(text(r)).not.toContain("Run the panel to generate");
    expectReadableReport(r);
  });

  it("the Individual workspace list card shows the cleaned question", async () => {
    const item = { id: "run-1", at: "2026-01-01T00:00:00.000Z", question: POLLUTED, selectedModels: [], status: "complete", modelsOk: 4, modelsTotal: 5 } as never;
    const r = await settle(createElement("ul", null, createElement(WorkspaceRunCard, { item })));
    expect(text(r)).toContain(QUESTION);
    expect(text(r)).not.toContain("Run the panel to generate");
  });
});

describe("only one model responded (review M1): the single-response view is readable too", () => {
  const ONE_OF_FOUR: [string, string, string][] = [
    ["chatgpt", "ok", fenced(genericAnswer("ChatGPT"))],
    ["claude", "error", ""],
    ["grok", "timeout", ""],
    ["gemini", "error", "Gemini request failed. Please try again."],
  ];
  for (const surface of ["Team", "Individual"] as const) {
    it(`${surface}: readable sections, saved text kept, failures read "did not respond", read-only`, async () => {
      const r = surface === "Team" ? await renderTeam(await body(historicalRun(ONE_OF_FOUR))) : await renderIndividual(historicalRun(ONE_OF_FOUR));
      const one = byId(r, "single-model-response");
      expect(one.map((n) => n.props["data-model-id"])).toEqual(["chatgpt"]);
      const visible = text(one[0].findAll((n) => n.props["data-testid"] === "saved-response-structured")[0]);
      const a = genericAnswer("ChatGPT");
      for (const v of [a.summary, a.keyClaims[0].claim, a.keyClaims[0].evidence, a.uncertainties[0], a.followUps[0], a.camps[0].position]) expect(visible).toContain(v);
      expect(visible).not.toMatch(/[{}]|```/);
      const all = text(r);
      expect(all).toMatch(/Claude[^\n]*: did not respond/);
      // The saved read reports every non-response as "failed" (its public status), so a stored timeout also reads "did not respond".
      expect(all).toMatch(/Failed ModelsClaude[^:]*: did not respondGrok[^:]*: did not respondGemini[^:]*: did not respond/);
      expect(all).not.toMatch(/: failed|: timeout|incompatible format|Gemini request failed|Re-run Same Panel/);
      expectNoWriteOrModelCall();
    });
  }
});

describe("runs WITH persisted analysis are unaffected", () => {
  it("a run with a saved synthesis renders the comprehensive report (Unified Answer, Trust Summary) and never the without-analysis view", async () => {
    const r = await renderTeam(await body({ ...fullTeamRunData({ question: QUESTION }), adaptiveOutput: undefined, legacyAdaptiveOutput: undefined, governanceRecord: undefined }));
    expect(byId(r, "responses-without-analysis")).toHaveLength(0);
    expect(byId(r, "saved-response-structured")).toHaveLength(0);
    const all = text(r);
    expect(all).toContain("Unified Answer");
    expect(all).toContain("Trust Summary");
  });
});

describe("parseStructuredResponse: bounded, safe parsing", () => {
  it("bare object, bare array and fenced JSON parse; plain text, malformed and scalars do not", () => {
    expect(parseStructuredResponse('{"a":1}')).toEqual({ a: 1 });
    expect(parseStructuredResponse("[1,2]")).toEqual([1, 2]);
    expect(parseStructuredResponse(fenced({ b: 2 }))).toEqual({ b: 2 });
    expect(parseStructuredResponse("```\n{\"c\":3}\n```")).toEqual({ c: 3 });
    for (const t of [PLAIN, MALFORMED, '"just a string"', "42", "null", "", "Answer: {not json}"]) expect(parseStructuredResponse(t)).toBeNull();
  });

  it("oversized input is not parsed (shown as saved text)", () => {
    const big = JSON.stringify({ summary: "x".repeat(MAX_STRUCTURED_PARSE_CHARS) });
    expect(big.length).toBeGreaterThan(MAX_STRUCTURED_PARSE_CHARS);
    expect(parseStructuredResponse(big)).toBeNull();
    const fits = JSON.stringify({ summary: "x".repeat(MAX_STRUCTURED_PARSE_CHARS - 20) });
    expect(parseStructuredResponse(fits)).not.toBeNull();
  });

  it("nesting beyond the depth bound is not parsed; at the bound it is", () => {
    const nest = (d: number): unknown => (d === 0 ? "leaf" : { k: nest(d - 1) });
    expect(parseStructuredResponse(JSON.stringify(nest(MAX_STRUCTURED_DEPTH)))).not.toBeNull();
    expect(parseStructuredResponse(JSON.stringify(nest(MAX_STRUCTURED_DEPTH + 1)))).toBeNull();
  });

  it("model-provided markup is displayed as text, never as elements", async () => {
    const hostile = JSON.stringify({ summary: '<img src=x onerror="alert(1)"><script>alert(2)</script>' });
    const r = await renderIndividual(historicalRun([["chatgpt", "ok", hostile], ["claude", "ok", PLAIN]], QUESTION));
    expect(r.root.findAll((n) => n.type === "script" || n.type === "img")).toHaveLength(0);
    expect(visibleOf(responseOf(r, "chatgpt"))).toContain("<script>alert(2)</script>");
  });
});

describe("displayResearchQuestion: display-only, exact legacy copy only", () => {
  it.each([
    [`${QUESTION} ${LEGACY_EMPTY_STATE_SENTENCE}`, QUESTION],
    [POLLUTED, QUESTION],
    [`${QUESTION}\nNo unified answer yet\n${LEGACY_EMPTY_STATE_SENTENCE}`, QUESTION],
    [`${QUESTION} No unified answer yet ${LEGACY_EMPTY_STATE_SENTENCE} No unified answer yet ${LEGACY_EMPTY_STATE_SENTENCE}  `, QUESTION],
  ])("strips the trailing legacy copy: %j", (input, expected) => {
    expect(displayResearchQuestion(input)).toBe(expected);
  });

  it.each([
    QUESTION,
    "Should we run the panel to generate a trust summary for our board?",
    `Why does the app say "${LEGACY_EMPTY_STATE_SENTENCE}" before a run?`,
    `${LEGACY_EMPTY_STATE_SENTENCE} Is that copy clear?`,
    "Run the panel to generate the trust summary, Agreement / Disagreement Map and panel responses.",
    "Why is there no unified answer yet",
  ])("leaves legitimate questions unchanged: %j", (q) => {
    expect(displayResearchQuestion(q)).toBe(q);
  });

  it("a question made only of the legacy copy is not displayed as empty", () => {
    expect(displayResearchQuestion(LEGACY_EMPTY_STATE_SENTENCE)).toBe(LEGACY_EMPTY_STATE_SENTENCE);
  });

  it("the stored record is untouched: the read payload still carries the original question", async () => {
    const b = await body(historicalRun());
    expect(b.question).toBe(POLLUTED);
  });
});
