/**
 * Saved-response and comparison presentation (2026-11-11) — the customer-reported comparison report.
 *
 * Reopened from History, a comparison_matrix report showed "Raw model output (4)", "1 saved response can't be shown
 * here" for Claude, and ChatGPT's eight cells as a flat "subject · attribute: value(verdict)" list.
 *
 * ORDER A — the real path, every unit real; only the model connector (the retry call) and Firestore are faked:
 *   Claude's first answer → validateAdaptiveResponse (live) → the corrective retry (retryModelOnce → mergeAdaptiveRetry)
 *   → the aggregate (buildComparisonMatrixResult) → completeRun (the real perModel serializer: sanitize + storage cap)
 *   → persistAdaptiveOutput → applyAdaptiveRetryAccounting → the stored document → JSON round trip (Firestore)
 *   → buildRunReadPayload (reconstructModelResults + savedCopyRetryEvidence) → interpretPersistedRunReadPayload
 *   → PersistedResearchResultView (Personal) / TeamResearchDetailShell (Team) → ModelResponsesSection.
 *
 * What it establishes: the saved copy is the FIRST answer (completeRun runs before adaptive finalization, and the
 * retry's text is never written), so when the first answer did not validate, the reopened report cannot show the
 * adopted retry — whatever fed the aggregate. Display never changes the persisted result.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
const AUTH = { user: { uid: "owner-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: false }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// The model connectors: any call is recorded. The retry is the only call the write path may make; a read makes none.
jest.mock("@/lib/connectors/claude", () => ({ callClaude: jest.fn() }));
jest.mock("@/lib/connectors/chatgpt", () => ({ callChatGPT: jest.fn() }));
jest.mock("@/lib/connectors/grok", () => ({ callGrok: jest.fn() }));
jest.mock("@/lib/connectors/perplexity", () => ({ callPerplexity: jest.fn() }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { callClaude } from "@/lib/connectors/claude";
import { callChatGPT } from "@/lib/connectors/chatgpt";
import { callGrok } from "@/lib/connectors/grok";
import { callPerplexity } from "@/lib/connectors/perplexity";
import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { validateAdaptiveResponse } from "@/lib/adaptiveSchema/validator";
import { completeRun, persistAdaptiveOutput } from "@/lib/firestore/runs";
import { applyAdaptiveRetryAccounting } from "@/lib/firestore/adaptiveRetryAccounting";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import { RunSlotStatusContext } from "@/components/adaptive/RunSlotStatusContext";
import {
  SAVED_COPY_MISSING,
  SAVED_COPY_RETRIED_AFTER_NAME,
  SAVED_COPY_RETRIED_INCLUDED,
  SAVED_COPY_RETRIED_SHORTENED,
  SAVED_COPY_SHORTENED,
  SAVED_COPY_UNSTRUCTURED,
  SAVED_TEXT_SHORTENED_LABEL,
  SAVED_TEXT_UNSTRUCTURED_LABEL,
} from "@/lib/adaptiveSchema/savedCopyNotice";
import { FIXTURE_PROJECT_ID, FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID } from "@/lib/runs/__tests__/runReadFixtures";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import type { ModelResult } from "@/lib/types";

const schema = SCHEMA_REGISTRY.comparison_matrix;
const CLASSIFICATION = { queryType: "comparison_matrix", confidence: 0.9 } as never;
const QUESTION = "Compare carbon taxes, renewable subsidies, cap-and-trade and regulatory standards";
const RUN_ID = FIXTURE_RUN_ID;
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const connectors = [callClaude, callChatGPT, callGrok, callPerplexity, callGemini] as unknown as jest.Mock[];
const claude = callClaude as unknown as jest.Mock;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const EFF = "Effectiveness in reducing emissions";
const ECON = "Economic impact";
/** The customer's ChatGPT cells, verbatim (subject, attribute, value, verdict). */
const CHATGPT_CELLS = [
  ["Carbon Taxes", EFF, "High", "better"],
  ["Renewable Energy Subsidies", EFF, "Moderate", "worse"],
  ["Cap-and-Trade Programs", EFF, "High", "even"],
  ["Regulatory Standards", EFF, "Moderate", "worse"],
  ["Carbon Taxes", ECON, "Potentially negative short-term", "worse"],
  ["Renewable Energy Subsidies", ECON, "Positive", "better"],
  ["Cap-and-Trade Programs", ECON, "Mixed", "even"],
  ["Regulatory Standards", ECON, "Variable", "even"],
].map(([subject, attribute, value, verdict]) => ({ subject, attribute, value, verdict }));

const answer = (cells: unknown[], who: string) => ({
  cells,
  directConclusion: `${who}: carbon pricing leads on cost-effectiveness.`,
  tradeoffs: [`${who}: cheaper instruments are politically harder.`],
  bestUseRecommendations: [`${who}: carbon taxes when price certainty matters.`],
  uncertainties: [],
});
const cellsFor = (who: string) => [
  { subject: "Carbon Taxes", attribute: EFF, value: `${who} high`, verdict: "better" },
  { subject: "Regulatory Standards", attribute: EFF, value: `${who} moderate`, verdict: "worse" },
];
const CHATGPT_TEXT = JSON.stringify(answer(CHATGPT_CELLS, "ChatGPT"));
const bare = (who: string) => JSON.stringify(answer(cellsFor(who), who));
const fencedJson = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
const CLAUDE_RETRY = { ...answer(cellsFor("ClaudeRetry"), "ClaudeRetry") };
/** A plausible Claude first answer that is not valid JSON: commentary around a fenced block (stripJsonFences only strips a fence spanning the whole text). */
const CLAUDE_PROSE_WRAPPED = `Here is a structured comparison of the four policy approaches:\n\n${fencedJson(answer(cellsFor("ClaudeFirst"), "ClaudeFirst"))}\n\nNote: effectiveness depends heavily on design and enforcement.`;
/** A plausible Claude first answer cut off by the provider's output cap (stop_reason=max_tokens): valid JSON prefix, unterminated. */
const CLAUDE_CUT_OFF = bare("ClaudeFirst").slice(0, 140);
/** Valid JSON, wrong field types: every field fails, so salvage keeps nothing. */
const CLAUDE_WRONG_TYPES = JSON.stringify({ cells: "Carbon taxes: high", directConclusion: 7, tradeoffs: "x", bestUseRecommendations: {}, uncertainties: 3 });

const ok = (modelId: string, rawText: string): ModelResult => ({ modelId, status: "ok", rawText, latencyMs: 5, tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) as never;
const panel = (claudeFirst: string): ModelResult[] => [
  ok("chatgpt", CHATGPT_TEXT),
  ok("claude", claudeFirst),
  ok("grok", bare("Grok")),
  ok("perplexity", bare("Perplexity")),
  ok("gemini", fencedJson(answer(cellsFor("Gemini"), "Gemini"))),
];

// ─── The write path ─────────────────────────────────────────────────────────

/**
 * The run-panel write sequence for an adaptive run (runPanelExecution.ts): completeRun (the saved perModel rows), then
 * finalizeAdaptiveRun (validation + one corrective retry), persistAdaptiveOutput, applyAdaptiveRetryAccounting.
 */
async function executeAndSave(results: ModelResult[], opts: { accounting?: boolean } = {}) {
  db.docs.clear();
  db.seed(`runs/${RUN_ID}`, { userId: "owner-1", question: QUESTION, status: "running", selectedModels: results.map((r) => r.modelId) });
  await completeRun({
    runId: RUN_ID,
    userId: "owner-1",
    results,
    question: QUESTION,
    selectedModels: results.map((r) => r.modelId),
    tokenUsageByModel: results.map((r) => ({ modelId: r.modelId, tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })) as never,
    tokenTotals: { promptTokens: results.length, completionTokens: results.length, totalTokens: 2 * results.length } as never,
  });
  const sink = new AdaptiveRetryUsageSink();
  const promptOverrides = Object.fromEntries(results.map((r) => [r.modelId, "BASE PROMPT"]));
  const live = await finalizeAdaptiveRun(
    schema,
    results,
    QUESTION,
    { apiKeys: { claude: "k" }, promptOverrides, context: null, budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, usageSink: sink, now: () => 1_000 } as never,
    CLASSIFICATION
  );
  await persistAdaptiveOutput(RUN_ID, live.persistedOutput!);
  if (opts.accounting !== false) {
    await applyAdaptiveRetryAccounting({ runId: RUN_ID, uid: "owner-1", usage: sink.freeze(), gates: { completeRunSucceeded: true, primaryUserAccountingSucceeded: true }, foregroundWaitMs: 10_000 });
  }
  return { live, stored: roundTrip(db.read(`runs/${RUN_ID}`)!) as Record<string, any> };
}

async function readAs(stored: Record<string, unknown>, viewerRole: RunReadViewerRole = "owner") {
  return roundTrip(await buildRunReadPayload({ runId: RUN_ID, data: stored, viewerRole, mayReadDecisionContent: true, resolveReviewRouting: async () => "not_configured" })) as any;
}

async function settle(el: ReturnType<typeof createElement>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  for (let i = 0; i < 5; i += 1) await act(async () => void (await new Promise((res) => setTimeout(res, 0))));
  return r;
}
async function renderPersonal(stored: Record<string, unknown>) {
  const interp = interpretPersistedRunReadPayload(await readAs(stored), RUN_ID);
  if (interp.kind !== "ready") throw new Error(`not ready: ${interp.kind}`);
  return settle(createElement(PersistedResearchResultView, { presentation: interp.presentation }));
}
const TEAM_PROPS = { workspaceId: FIXTURE_WORKSPACE_ID, workspaceName: "Acme Team", runId: RUN_ID, project: { id: FIXTURE_PROJECT_ID, name: "Climate" }, showMembers: true, showAudit: false };
async function renderTeam(stored: Record<string, unknown>, viewerRole: RunReadViewerRole = "team_member") {
  const team = { workspaceId: FIXTURE_WORKSPACE_ID, projectId: FIXTURE_PROJECT_ID, project: { id: FIXTURE_PROJECT_ID, name: "Climate", status: "active" }, assignee: null, createdAt: null, completedAt: null, origin: null, review: null };
  const body = { ...(await readAs(stored, viewerRole)), team };
  mockedAuthedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
  return settle(createElement(TeamResearchDetailShell, TEAM_PROPS));
}

function text(n: TestRenderer.ReactTestInstance | TestRenderer.ReactTestRenderer): string {
  const root = "root" in n ? n.root : n;
  const out: string[] = [];
  const walk = (x: TestRenderer.ReactTestInstance | string) => (typeof x === "string" ? out.push(x) : x.children.forEach(walk));
  walk(root);
  return out.join("");
}
const byTestId = (r: TestRenderer.ReactTestRenderer | TestRenderer.ReactTestInstance, id: string) =>
  ("root" in r ? r.root : r).findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);
const card = (r: TestRenderer.ReactTestRenderer, id: string, modelId: string) => byTestId(r, id).filter((n) => n.props["data-model-id"] === modelId);
const counts = (r: TestRenderer.ReactTestRenderer) => byTestId(r, "model-response-counts").map((n) => n.findAllByType("p").map(text));

/** The exact table a reader sees: caption, header row, then each body row, cell texts joined by " | ". */
function tableText(t: TestRenderer.ReactTestInstance): string[] {
  const rows = t.findAllByType("tr").map((tr) => tr.findAll((n) => n.type === "th" || n.type === "td").map(text).join(" | "));
  return [text(t.findByType("caption")), ...rows];
}

function expectNoProviderOrWrite() {
  for (const c of connectors) expect(c).not.toHaveBeenCalled();
  for (const [url, init] of mockedAuthedFetch.mock.calls as [string, { method?: string } | undefined][]) {
    expect(init?.method ?? "GET").toBe("GET");
    expect(String(url)).not.toMatch(/\/api\/(synthesize-panel|run-panel)/);
  }
}

// Each case runs the whole write and read path; allow for a loaded broad run.
jest.setTimeout(30_000);

beforeEach(() => {
  for (const c of connectors) c.mockReset();
  mockedAuthedFetch.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const EXPECTED_CHATGPT_TABLE = [
  "ChatGPT's own comparison: this model's judgment, not verified findings or the panel's combined result.",
  `Compared | ${EFF} | ${ECON}`,
  "Carbon Taxes | High (Better) | Potentially negative short-term (Worse)",
  "Renewable Energy Subsidies | Moderate (Worse) | Positive (Better)",
  "Cap-and-Trade Programs | High (Even) | Mixed (Even)",
  "Regulatory Standards | Moderate (Worse) | Variable (Even)",
];

// ─── ORDER A: the reproduced path ───────────────────────────────────────────

describe("ORDER A — Claude's invalid first answer, its retry, and what is saved", () => {
  it.each([
    ["commentary around a fenced block (not valid JSON)", CLAUDE_PROSE_WRAPPED, /^Invalid JSON/],
    ["cut off by the provider's output cap (not valid JSON)", CLAUDE_CUT_OFF, /^Invalid JSON/],
    ["valid JSON with every field the wrong type", CLAUDE_WRONG_TYPES, /^Schema validation failed/],
  ])("%s: the live validator rejects it in full (A/B), so the retry runs", (_l, first, error) => {
    const v = validateAdaptiveResponse("claude" as never, schema, first, { silent: true });
    expect([v.ok, v.data]).toEqual([false, null]);
    expect(v.parseError).toMatch(error);
  });

  it("retry adopted: the aggregate holds the RETRY's cells; the saved copy is the FIRST answer; reopen says the corrected response was not preserved", async () => {
    claude.mockResolvedValueOnce({ modelId: "claude", status: "ok", rawText: JSON.stringify(CLAUDE_RETRY), latencyMs: 5, tokenUsage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 } });
    const { live, stored } = await executeAndSave(panel(CLAUDE_PROSE_WRAPPED));
    expect(claude).toHaveBeenCalledTimes(1); // the one corrective retry, on the write path
    const liveClaude = live.adaptiveResults.find((r) => r.modelId === "claude")!;
    expect([liveClaude.ok, liveClaude.retryOutcome]).toEqual([true, "adopted_full"]);
    // What fed the aggregate: Claude's retry, never its first answer.
    const claudeValues = live.comparisonMatrix!.cells.map((c) => c.valuesByModel["claude" as never]).filter(Boolean);
    expect(claudeValues).toEqual(["ClaudeRetry high", "ClaudeRetry moderate"]);
    expect(JSON.stringify(live.comparisonMatrix)).not.toContain("ClaudeFirst");
    // What was saved: the first answer (completeRun ran first), not the retry. The retry text is nowhere in the document.
    const savedClaude = stored.runDocument.perModel.find((p: any) => p.modelId === "claude");
    expect(savedClaude.rawTextTruncated).toBe(CLAUDE_PROSE_WRAPPED);
    expect(savedClaude.wasTruncated).toBe(false);
    expect(JSON.stringify(stored.runDocument)).not.toContain("ClaudeRetry");
    expect(stored.adaptiveRetryUsage.byModel.claude.calls).toBe(1);

    // Read: case 4 — the record establishes the retry succeeded and was included.
    claude.mockReset();
    const payload = await readAs(stored);
    const rebuilt = payload.adaptive.modelResults.find((r: any) => r.modelId === "claude");
    expect([rebuilt.ok, rebuilt.parseError, rebuilt.savedResponseText]).toEqual([false, SAVED_COPY_RETRIED_INCLUDED, undefined]);
    // Display never changes the persisted result: the read payload carries the stored envelope unchanged.
    expect(payload.adaptive.output).toEqual(roundTrip(live.persistedOutput));

    const r = await renderPersonal(stored);
    expect(counts(r)).toEqual([["5 models requested · 5 answered", "4 structured responses shown · 1 saved copy can't be shown"]]);
    expect(text(r)).toContain(`Claude${SAVED_COPY_RETRIED_AFTER_NAME}`);
    expect(card(r, "structured-model-response", "claude")).toHaveLength(0);
    expect(card(r, "saved-text-model-response", "claude")).toHaveLength(0);
    expect(text(r)).not.toContain("ClaudeFirst");
    // The notice appears once, not again as a heading.
    expect(text(r).split("can't be shown here").length - 1).toBe(0);
    expectNoProviderOrWrite();
  });

  it("retry fails: Claude is absent from the aggregate; reopen shows its saved first answer as saved text, labelled, never as included", async () => {
    claude.mockResolvedValueOnce({ modelId: "claude", status: "error", rawText: null, errorMessage: "overloaded", latencyMs: 5 });
    const { live, stored } = await executeAndSave(panel(CLAUDE_PROSE_WRAPPED));
    expect(live.adaptiveResults.find((r) => r.modelId === "claude")!.retryOutcome).toBe("failed_call");
    expect(live.comparisonMatrix!.cells.some((c) => "claude" in c.valuesByModel)).toBe(false);
    claude.mockReset();
    const r = await renderPersonal(stored);
    const saved = card(r, "saved-text-model-response", "claude");
    expect(saved).toHaveLength(1);
    expect(text(saved[0])).toContain(SAVED_TEXT_UNSTRUCTURED_LABEL);
    expect(text(saved[0])).toContain("Here is a structured comparison of the four policy approaches:");
    expect(text(r)).not.toContain("successfully retried");
    expect(counts(r)).toEqual([["5 models requested · 5 answered", "4 structured responses shown · 1 shown as saved text"]]);
    expectNoProviderOrWrite();
  });

  it("live render of the same run shows Claude's ADOPTED retry (the live results), with the comparison table", async () => {
    claude.mockResolvedValueOnce({ modelId: "claude", status: "ok", rawText: JSON.stringify(CLAUDE_RETRY), latencyMs: 5 });
    const { live } = await executeAndSave(panel(CLAUDE_PROSE_WRAPPED));
    const r = TestRenderer.create(createElement(ModelResponsesSection, { schema, results: live.adaptiveResults }));
    const claudeCard = card(r, "structured-model-response", "claude");
    expect(claudeCard).toHaveLength(1);
    expect(tableText(claudeCard[0].findByType("table")).slice(2)).toEqual(["Carbon Taxes | ClaudeRetry high (Better)", "Regulatory Standards | ClaudeRetry moderate (Worse)"]);
    // Live results carry no saved copy, so there is no "original response" disclosure to mislabel the first answer.
    expect(byTestId(claudeCard[0], "original-response")).toHaveLength(0);
  });
});

// ─── ORDER C: the comparison table (the eight-cell example) ─────────────────

describe("ORDER C — ChatGPT's eight cells as a table, live and reopened, Personal and Team", () => {
  const healthy = () => {
    claude.mockResolvedValue({ modelId: "claude", status: "ok", rawText: bare("ClaudeRetry"), latencyMs: 5 });
    return executeAndSave(panel(bare("Claude")));
  };

  it("reopened, Personal: the exact table, every cell and verdict, with the original response one keyboard step away", async () => {
    const { stored } = await healthy();
    claude.mockReset();
    const r = await renderPersonal(stored);
    const chatgpt = card(r, "structured-model-response", "chatgpt");
    expect(chatgpt).toHaveLength(1);
    const table = chatgpt[0].findByType("table");
    expect(tableText(table)).toEqual(EXPECTED_CHATGPT_TABLE);
    // Accessible structure.
    expect(table.findAll((n) => n.type === "th" && n.props.scope === "col")).toHaveLength(3);
    expect(table.findAll((n) => n.type === "th" && n.props.scope === "row")).toHaveLength(4);
    const region = chatgpt[0].findAll((n) => n.props.role === "region");
    expect(region).toHaveLength(1);
    expect(region[0].props.className).toContain("overflow-x-auto");
    expect(region[0].props.tabIndex).toBe(0);
    // Human field names, no JSON keys.
    const labels = chatgpt[0].findAllByType("h4").map(text);
    expect(labels).toEqual(["Comparison", "Conclusion", "Trade-offs", "Best for"]);
    const visible = chatgpt[0].children.filter((c) => typeof c === "string" || c.findAll((n) => n.type === "details").length === 0).map((c) => (typeof c === "string" ? c : text(c))).join("");
    expect(visible).not.toMatch(/directConclusion|bestUseRecommendations|"cells"|[{}]/);
    // The saved copy, exactly as stored, in a native disclosure.
    const disclosure = byTestId(chatgpt[0], "original-response");
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0].type).toBe("details");
    expect(text(disclosure[0].findByType("summary"))).toBe("Show original response");
    expect(text(disclosure[0].findByType("pre"))).toBe(CHATGPT_TEXT);
    expect(counts(r)).toEqual([["5 models requested · 5 answered", "5 structured responses shown"]]);
    expectNoProviderOrWrite();
  });

  it.each(["team_member", "team_reviewer"] as const)("reopened, Team (%s): the same table", async (role) => {
    const { stored } = await healthy();
    claude.mockReset();
    const r = await renderTeam(stored, role);
    const chatgpt = card(r, "structured-model-response", "chatgpt");
    expect(chatgpt).toHaveLength(1);
    expect(tableText(chatgpt[0].findByType("table"))).toEqual(EXPECTED_CHATGPT_TABLE);
    expectNoProviderOrWrite();
  });

  it("live: the same table from the live result", async () => {
    const { live } = await healthy();
    const r = TestRenderer.create(createElement(ModelResponsesSection, { schema, results: live.adaptiveResults }));
    expect(tableText(card(r, "structured-model-response", "chatgpt")[0].findByType("table"))).toEqual(EXPECTED_CHATGPT_TABLE);
  });
});

// ─── ORDER B: historical records, cases 1–5 ─────────────────────────────────

const row = (modelId: string, status: string, text: string, wasTruncated = false) => ({
  modelId,
  status,
  rawTextTruncated: text,
  tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 1,
  wasTruncated,
});
/** A historical document built from a real envelope: only the saved rows (and optionally the retry record) differ. */
async function historical(rows: ReturnType<typeof row>[], extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  claude.mockResolvedValue({ modelId: "claude", status: "ok", rawText: bare("ClaudeRetry"), latencyMs: 5 });
  const { stored } = await executeAndSave(panel(bare("Claude")), { accounting: false });
  claude.mockReset();
  return { ...stored, runDocument: { ...stored.runDocument, perModel: rows }, ...extra };
}
const retryRecord = (byModel: Record<string, number>) => ({
  schemaVersion: 1,
  calls: Object.values(byModel).reduce((a, b) => a + b, 0),
  usageUnavailableCalls: 0,
  totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  byModel: Object.fromEntries(Object.entries(byModel).map(([m, calls]) => [m, { calls, usageUnavailableCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }])),
  userCounter: "no_reported_usage",
});

describe("ORDER B — historical records", () => {
  it("case 1: a saved copy that validates is rendered (fenced JSON too)", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", fencedJson(answer(cellsFor("Claude"), "Claude")))]));
    expect(card(r, "structured-model-response", "claude")).toHaveLength(1);
    expect(tableText(card(r, "structured-model-response", "claude")[0].findByType("table")).slice(2)).toEqual(["Carbon Taxes | Claude high (Better)", "Regulatory Standards | Claude moderate (Worse)"]);
    expectNoProviderOrWrite();
  });

  it.each([
    ["malformed JSON", CLAUDE_CUT_OFF],
    ["commentary around JSON", CLAUDE_PROSE_WRAPPED],
    ["valid JSON, wrong field types", CLAUDE_WRONG_TYPES],
  ])("case 2 (%s): authentic but unstructurable → the saved text, clearly labelled; no structure invented", async (_l, saved) => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", saved)]));
    const c = card(r, "saved-text-model-response", "claude");
    expect(c).toHaveLength(1);
    expect(text(c[0])).toContain(SAVED_TEXT_UNSTRUCTURED_LABEL);
    expect(c[0].findAllByType("table")).toHaveLength(0);
    expect(card(r, "structured-model-response", "claude")).toHaveLength(0);
    // Review D2: plain preformatted text, byte for byte; never parsed into sections, no second disclosure.
    expect(byTestId(c[0], "saved-response-structured")).toHaveLength(0);
    const plain = byTestId(c[0], "saved-text-plain");
    expect(plain).toHaveLength(1);
    expect(plain[0].type).toBe("pre");
    expect(plain[0].props.className).toContain("whitespace-pre-wrap");
    expect(plain[0].props.className).toContain("break-words");
    expect(text(plain[0])).toBe(saved);
    expect(c[0].findAllByType("details")).toHaveLength(0);
    expect(text(r)).not.toContain(SAVED_COPY_UNSTRUCTURED);
    expectNoProviderOrWrite();
  });

  it("case 3: shortened for storage → the saved text, visibly labelled as shortened", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", CLAUDE_CUT_OFF, true)]));
    const c = card(r, "saved-text-model-response", "claude");
    expect(c).toHaveLength(1);
    expect(text(c[0])).toContain(SAVED_TEXT_SHORTENED_LABEL);
    expect(text(c[0])).toContain(CLAUDE_CUT_OFF);
    expect(text(c[0])).toContain("It is the model's first answer and may differ from what the report used.");
    expect(text(byTestId(c[0], "saved-text-plain")[0])).toBe(CLAUDE_CUT_OFF);
    const payload = await readAs(await historical([row("claude", "ok", CLAUDE_CUT_OFF, true)]));
    expect(payload.adaptive.modelResults[0].parseError).toBe(SAVED_COPY_SHORTENED);
  });

  it("case 3 + retry record (review D1): the recorded retry outranks the shortened first answer, which is not shown", async () => {
    const stored = await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", CLAUDE_CUT_OFF, true)], { adaptiveRetryUsage: retryRecord({ claude: 1 }) });
    const r = await renderPersonal(stored);
    expect(text(r)).toContain(`Claude: ${SAVED_COPY_RETRIED_SHORTENED}`);
    expect(card(r, "saved-text-model-response", "claude")).toHaveLength(0);
    expect(text(r)).not.toContain(CLAUDE_CUT_OFF);
    expect(text(r)).not.toContain("successfully retried");
    const rebuilt = (await readAs(stored)).adaptive.modelResults.find((m: any) => m.modelId === "claude");
    expect([rebuilt.parseError, rebuilt.savedResponseText]).toEqual([SAVED_COPY_RETRIED_SHORTENED, undefined]);
    expect(counts(r)).toEqual([["2 models requested · 2 answered", "1 structured response shown · 1 saved copy can't be shown"]]);
  });

  it("case 3 + a retry record for ANOTHER slot: the shortened first answer is still shown, with the first-answer caveat", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", CLAUDE_CUT_OFF, true)], { adaptiveRetryUsage: retryRecord({ chatgpt: 1 }) }));
    const c = card(r, "saved-text-model-response", "claude");
    expect(c).toHaveLength(1);
    expect(text(c[0])).toContain(SAVED_TEXT_SHORTENED_LABEL);
  });

  it("case 4: verified included retry, adopted text not saved → the corrected response can't be recovered separately", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", CLAUDE_PROSE_WRAPPED)], { adaptiveRetryUsage: retryRecord({ claude: 1 }) }));
    expect(text(r)).toContain(`Claude${SAVED_COPY_RETRIED_AFTER_NAME}`);
    expect(card(r, "saved-text-model-response", "claude")).toHaveLength(0);
  });

  it("case 4 needs the record: a retry with no cells attributed to the slot is not 'included' (falls to case 2)", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("perplexity", "ok", CLAUDE_PROSE_WRAPPED)], { adaptiveRetryUsage: retryRecord({ perplexity: 1 }) }));
    // The envelope here attributes cells to every slot; strip perplexity's to model a failed retry.
    expect(text(r)).toContain("successfully retried");
    const stored = await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("perplexity", "ok", CLAUDE_PROSE_WRAPPED)], { adaptiveRetryUsage: retryRecord({ perplexity: 1 }) });
    for (const cell of stored.adaptiveOutput.result.cells) delete cell.valuesByModel.perplexity;
    const r2 = await renderPersonal(stored);
    expect(text(r2)).not.toContain("successfully retried");
    expect(card(r2, "saved-text-model-response", "perplexity")).toHaveLength(1);
  });

  it("case 5: an answered slot with no saved text → neither inclusion nor exclusion is claimed", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", "")]));
    expect(text(r)).toContain(`Claude: ${SAVED_COPY_MISSING}`);
    expect(text(r)).not.toMatch(/reflected in the report|was included|was excluded/);
    expect(counts(r)).toEqual([["2 models requested · 2 answered", "1 structured response shown · 1 saved copy can't be shown"]]);
  });

  it("a historical record without any retry outcome or record reads exactly as case 2 (no retry claimed)", async () => {
    const stored = await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", CLAUDE_PROSE_WRAPPED)]);
    expect("adaptiveRetryUsage" in stored).toBe(false);
    const r = await renderPersonal(stored);
    expect(card(r, "saved-text-model-response", "claude")).toHaveLength(1);
    expect(text(r)).not.toContain("retried");
  });
});

// ─── ORDER D: counts ────────────────────────────────────────────────────────

describe("ORDER D — counts", () => {
  it("four renderable responses plus one unavailable: requested, answered, shown and unavailable are each stated once", async () => {
    const r = await renderPersonal(
      await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", CLAUDE_PROSE_WRAPPED), row("grok", "ok", bare("Grok")), row("perplexity", "ok", bare("Perplexity")), row("gemini", "ok", bare("Gemini"))], {
        adaptiveRetryUsage: retryRecord({ claude: 1 }),
      })
    );
    expect(counts(r)).toEqual([["5 models requested · 5 answered", "4 structured responses shown · 1 saved copy can't be shown"]]);
    expect(card(r, "structured-model-response", "chatgpt").length + card(r, "structured-model-response", "grok").length).toBe(2);
    expect(text(r)).not.toMatch(/Raw model output \(/);
  });

  it("one failed provider plus valid others: the failure is a non-response, not a saved-copy problem and not an answer", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", bare("Claude")), row("gemini", "error", "Gemini request failed. Please try again.")]));
    expect(counts(r)).toEqual([["3 models requested · 2 answered · 1 did not respond", "2 structured responses shown"]]);
    expect(text(r)).toContain("Gemini did not respond");
    expect(text(r)).not.toContain("Gemini request failed");
  });

  it("a timed-out provider is a non-response", async () => {
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("grok", "timeout", "")]));
    expect(counts(r)).toEqual([["2 models requested · 1 answered · 1 did not respond", "1 structured response shown"]]);
  });

  it("every provider valid", async () => {
    const r = await renderPersonal(
      await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", bare("Claude")), row("grok", "ok", bare("Grok")), row("perplexity", "ok", bare("Perplexity")), row("gemini", "ok", bare("Gemini"))])
    );
    expect(counts(r)).toEqual([["5 models requested · 5 answered", "5 structured responses shown"]]);
  });

  it("one provider serving several requested slots: counted per slot, the substitution stated", async () => {
    const r = await renderPersonal(
      await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "substituted", bare("DeepSeekA")), row("grok", "substituted", bare("DeepSeekB"))])
    );
    expect(counts(r)).toEqual([["3 models requested · 3 answered (2 by a substitute model)", "3 structured responses shown"]]);
  });

  it("a genuine response that mentions 'mock response' is an ordinary answer", async () => {
    const mention = JSON.stringify(answer([{ subject: "Mock response tooling", attribute: "Cost", value: "Low — a mock response server is cheap", verdict: "better" }], "Claude"));
    const r = await renderPersonal(await historical([row("chatgpt", "ok", CHATGPT_TEXT), row("claude", "ok", mention)]));
    expect(counts(r)).toEqual([["2 models requested · 2 answered", "2 structured responses shown"]]);
    expect(tableText(card(r, "structured-model-response", "claude")[0].findByType("table")).slice(2)).toEqual(["Mock response tooling | Low — a mock response server is cheap (Better)"]);
  });
});

// ─── Safety ─────────────────────────────────────────────────────────────────

describe("markup and script-like model text is inert", () => {
  const HOSTILE = '<script>window.__pwned=1</script><img src=x onerror="alert(1)">';
  it("in table cells, headers and the saved-text fallback, it renders as escaped text", async () => {
    const hostile = JSON.stringify(answer([{ subject: HOSTILE, attribute: "<b>attr</b>", value: HOSTILE, verdict: "even" }], "x"));
    const results = [
      validateAdaptiveResponse("chatgpt" as never, schema, hostile, { silent: true }),
      { modelId: "claude", schemaId: "comparison_matrix", ok: false, data: null, parseError: SAVED_COPY_UNSTRUCTURED, savedResponseText: HOSTILE } as AdaptiveModelResult,
    ].map((r, i) => (i === 0 ? { ...r, savedResponseText: hostile } : r));
    const html = renderToStaticMarkup(
      createElement(RunSlotStatusContext.Provider, { value: new Map([["chatgpt", "ok"], ["claude", "ok"]]) }, createElement(ModelResponsesSection, { schema, results: results as AdaptiveModelResult[] }))
    );
    expect(html).not.toMatch(/<script|<img|<b>attr/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;attr&lt;/b&gt;");
  });
});
