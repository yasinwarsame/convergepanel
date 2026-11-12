/**
 * Order 40 C (owner-authorized) — the adopted result a report used is saved, and a reopened report shows it.
 *
 * THE REAL CHAIN, every unit real; only the model (runPanel's first answers and the retry connector), Firestore (the
 * codebase's transactional test double) and the per-user token counter are faked:
 *   executeOrdinaryRun (lib/runPanelExecution.ts) → completeRun (the saved first answers, unchanged) →
 *   finalizeAdaptiveRun (live validator → retryModelOnce → mergeAdaptiveRetry → the aggregate) →
 *   persistAdaptiveOutput → persistAdaptiveDisplayResults (the new writer, guarded transaction) → governance init →
 *   applyAdaptiveRetryAccounting → the stored document → JSON round trip →
 *   buildRunReadPayload (readAdoptedDisplayResults → reconstructModelResults) → interpretPersistedRunReadPayload →
 *   PersistedResearchResultView (Personal) / TeamResearchDetailShell (Team) → ModelResponsesSection → the table.
 * The authenticated read through GET /api/user/runs/[runId] (owner allowed, another user refused) is at the end.
 */
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
// A stable object: a fresh one per render would re-trigger auth-dependent effects forever.
const AUTH = { user: { uid: "owner-1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
const SECRET_KEY = "sk-test-SECRET-KEY-0000";
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  OPENAI_API_KEY: "sk-test-SECRET-KEY-0000",
  ANTHROPIC_API_KEY: "sk-test-SECRET-KEY-0000",
  XAI_API_KEY: "sk-test-SECRET-KEY-0000",
  PERPLEXITY_API_KEY: "sk-test-SECRET-KEY-0000",
  GEMINI_API_KEY: "sk-test-SECRET-KEY-0000",
  ADAPTIVE_VERIFICATION_ENABLED: false,
  PROVIDER_SEARCH_EVIDENCE_COUNTERS_ENABLED: false,
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// The model: the panel's first answers, and the one corrective-retry call per slot.
const mockedRunPanel = jest.fn();
jest.mock("@/lib/panel", () => ({ runPanel: (...a: unknown[]) => mockedRunPanel(...a) }));
jest.mock("@/lib/connectors/claude", () => ({ callClaude: jest.fn() }));
jest.mock("@/lib/connectors/chatgpt", () => ({ callChatGPT: jest.fn() }));
jest.mock("@/lib/connectors/grok", () => ({ callGrok: jest.fn() }));
jest.mock("@/lib/connectors/perplexity", () => ({ callPerplexity: jest.fn() }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn(async () => ({ tokensUsedCurrentPeriod: 0, periodStart: new Date() })) }));
jest.mock("@/lib/adaptiveSchema/analytics", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/analytics");
  return Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === "function" ? jest.fn() : actual[k]]));
});
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
  adminAuth: null,
  FIREBASE_PROJECT_ID: "test",
}));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { callClaude } from "@/lib/connectors/claude";
import { callChatGPT } from "@/lib/connectors/chatgpt";
import { callGrok } from "@/lib/connectors/grok";
import { callPerplexity } from "@/lib/connectors/perplexity";
import { callGemini } from "@/lib/connectors/gemini";
import { executeOrdinaryRun } from "@/lib/runPanelExecution";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { persistAdaptiveDisplayResults } from "@/lib/firestore/adaptiveDisplayResults";
import * as adoptedDisplay from "@/lib/adaptiveSchema/adoptedDisplayResults";
import { ADAPTIVE_DISPLAY_SLOT_MAX_BYTES, FIRESTORE_DOCUMENT_BUDGET_BYTES, FIRESTORE_DOCUMENT_LIMIT_BYTES, adaptiveDisplayDocumentBytes, firestoreFieldBytes } from "@/lib/adaptiveSchema/adoptedDisplayResults";
import { FirestoreError } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { interpretPersistedRunReadPayload } from "@/lib/research/persistedRunPresentation";
import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";
import ModelResponsesSection from "@/components/adaptive/ModelResponsesSection";
import {
  ADOPTED_RESULT_ORIGIN_LABEL,
  FIRST_ANSWER_DISCLOSURE_LABEL,
  FIRST_ANSWER_SHORTENED_NOTE,
  SAVED_COPY_RETRIED_AFTER_NAME,
  SAVED_TEXT_UNSTRUCTURED_LABEL,
} from "@/lib/adaptiveSchema/savedCopyNotice";
import { MAX_CHARS_STORAGE_PER_MODEL } from "@/lib/panel/sanitizeText";
import { FIXTURE_PROJECT_ID, FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID } from "@/lib/runs/__tests__/runReadFixtures";
import type { ModelResult } from "@/lib/types";

const schema = SCHEMA_REGISTRY.comparison_matrix;
const CLASSIFICATION = { queryType: "comparison_matrix", confidence: 0.9 } as never;
const QUESTION = "Compare carbon taxes and regulatory standards";
const RUN_ID = FIXTURE_RUN_ID;
const OWNER = "owner-1";
const SYSTEM_PROMPT = "SYSTEM PROMPT FOR THE PANEL — must never be stored with the result";
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const connectors = [callClaude, callChatGPT, callGrok, callPerplexity, callGemini] as unknown as jest.Mock[];
const claude = callClaude as unknown as jest.Mock;
const grok = callGrok as unknown as jest.Mock;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const EFF = "Effectiveness";
const answer = (who: string, extra: Record<string, unknown> = {}) => ({
  cells: [
    { subject: "Carbon Taxes", attribute: EFF, value: `${who} high`, verdict: "better" },
    { subject: "Regulatory Standards", attribute: EFF, value: `${who} moderate`, verdict: "worse" },
  ],
  directConclusion: `${who}: carbon pricing leads on cost-effectiveness.`,
  tradeoffs: [`${who}: cheaper instruments are politically harder.`],
  bestUseRecommendations: [`${who}: carbon taxes when price certainty matters.`],
  uncertainties: [],
  ...extra,
});
const bare = (who: string, extra?: Record<string, unknown>) => JSON.stringify(answer(who, extra));
const fencedJson = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
const CLAUDE_PROSE_WRAPPED = `Here is a structured comparison:\n\n${fencedJson(answer("ClaudeFirst"))}\n\nNote: effectiveness depends on design.`;
/** Valid JSON whose cells are valid but whose conclusion is the wrong type: salvage keeps the rest, the retry fills it. */
const GROK_PARTIAL = bare("GrokFirst", { directConclusion: 7 });

const ok = (modelId: string, rawText: string, status = "ok"): ModelResult =>
  ({ modelId, status, rawText, latencyMs: 5, tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) as never;
const retryOk = (modelId: string, text: string) => ({ modelId, status: "ok", rawText: text, latencyMs: 5, tokenUsage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 } });

// ─── Write path: the production executor ────────────────────────────────────

async function execute(results: ModelResult[], opts: { seed?: Record<string, unknown>; fakeTimers?: boolean; remainingMs?: number; budget?: { startedAtMonoMs: number; budgetMs: number } } = {}) {
  db.docs.clear();
  db.hooks = {};
  db.writeLog.length = 0;
  db.seed(`runs/${RUN_ID}`, { userId: OWNER, question: QUESTION, status: "running", selectedModels: results.map((r) => r.modelId), ...(opts.seed ?? {}) });
  mockedRunPanel.mockResolvedValue(results);
  const promptOverrides = Object.fromEntries(results.map((r) => [r.modelId, SYSTEM_PROMPT]));
  const run = executeOrdinaryRun({
    uid: OWNER,
    runId: RUN_ID,
    trimmedQuestion: QUESTION,
    context: null,
    selectedModels: results.map((r) => r.modelId) as never,
    adaptivePlan: { classification: CLASSIFICATION, schema, promptOverrides, routing: { kind: "active", schema } as never },
    debugRawResponseRequested: false,
    requestBudget: opts.budget ?? { startedAtMonoMs: performance.now() - (300_000 - (opts.remainingMs ?? 300_000)), budgetMs: 300_000 },
  });
  let res: Awaited<typeof run>;
  if (opts.fakeTimers) {
    let done = false;
    run.then(() => (done = true), () => (done = true));
    for (let i = 0; i < 400 && !done; i += 1) await jest.advanceTimersByTimeAsync(1_000);
    res = await run;
  } else {
    res = await run;
  }
  expect(res.status).toBe(200);
  const body = res.body as any;
  return { body, live: body.adaptive.results as any[], stored: viewOf(RUN_ID) };
}

/**
 * Order 40 C (O-2): the record is its own document, `runs/{runId}/adaptiveDisplayResults/v1`, never a run-document
 * field. A spec "view" is the run document as a reader sees it: the run's fields plus, under RECORD, the display
 * document (when it exists). readAs() splits it back into what the routes pass to buildRunReadPayload.
 */
const displayPath = (runId: string) => `runs/${runId}/adaptiveDisplayResults/v1`;
function viewOf(runId: string): Record<string, any> {
  const run = roundTrip(db.read(`runs/${runId}`)!) as Record<string, any>;
  expect(RECORD in run).toBe(false); // never a field of the run document
  const display = db.read(displayPath(runId));
  return display === undefined ? run : { ...run, [RECORD]: roundTrip(display) };
}

/**
 * An INDEPENDENT oracle of Firestore's documented storage size (never the production estimator): string = UTF-8 + 1;
 * boolean / null = 1; number, Date, Timestamp, and the fake's stored FieldValue transforms (a number once applied) = 8;
 * array = Σ values; map = Σ (key UTF-8 + 1 + value); document = name (Σ (segment UTF-8 + 1) + 16) + Σ fields + 32.
 * Anything else throws, so an unmeasured value fails the test instead of being under-counted.
 */
function oracleValueBytes(v: unknown): number {
  if (v === undefined) return 0;
  if (v === null || typeof v === "boolean") return 1;
  if (typeof v === "number") return 8;
  if (typeof v === "string") return Buffer.byteLength(v, "utf8") + 1;
  if (v instanceof Date) return 8;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + oracleValueBytes(x), 0);
  if (typeof v === "object") {
    const ctor = (v as object).constructor?.name ?? "";
    if (typeof (v as { toMillis?: unknown }).toMillis === "function" || /Transform$/.test(ctor)) return 8;
    if (ctor !== "Object" && ctor !== "") throw new Error(`oracle cannot measure a ${ctor}`);
    return Object.entries(v as Record<string, unknown>).reduce((n, [k, x]) => (x === undefined ? n : n + Buffer.byteLength(k, "utf8") + 1 + oracleValueBytes(x)), 0);
  }
  throw new Error(`oracle cannot measure ${typeof v}`);
}
function oracleDocumentBytes(path: string, data: Record<string, unknown>): number {
  const name = path.split("/").reduce((n, seg) => n + Buffer.byteLength(seg, "utf8") + 1, 0) + 16;
  return name + 32 + oracleValueBytes(data);
}
/** Makes the fake refuse, atomically, any commit that leaves a document over Firestore's 1,048,576-byte limit. */
function enforceFirestoreDocumentLimit(): { refusals: string[] } {
  const refusals: string[] = [];
  const real = db.applyWrites.bind(db);
  jest.spyOn(db, "applyWrites").mockImplementation((writes: any[], via?: any) => {
    const paths = [...new Set(writes.map((w) => w.path))];
    const before = new Map(paths.map((p) => [p, db.docs.get(p)]));
    const logLength = db.writeLog.length;
    real(writes, via);
    const over = paths.find((p) => db.docs.has(p) && oracleDocumentBytes(p, db.docs.get(p)!.data) > FIRESTORE_DOCUMENT_LIMIT_BYTES);
    if (over) {
      for (const [p, prev] of before) (prev === undefined ? db.docs.delete(p) : db.docs.set(p, prev));
      db.writeLog.length = logLength;
      refusals.push(over);
      throw new FirestoreError("INVALID_ARGUMENT", `Document ${over} exceeds the maximum allowed size of 1,048,576 bytes.`);
    }
  });
  return { refusals };
}

async function readAs(view: Record<string, unknown>, viewerRole: RunReadViewerRole = "owner", runId = RUN_ID) {
  const { [RECORD]: adaptiveDisplayResults, ...data } = view;
  return roundTrip(await buildRunReadPayload({ runId, data, viewerRole, mayReadDecisionContent: true, resolveReviewRouting: async () => "not_configured", adaptiveDisplayResults })) as any;
}
const withoutRecord = (stored: Record<string, any>) => {
  const { adaptiveDisplayResults: _r, ...rest } = stored;
  return rest;
};

async function settle(el: ReturnType<typeof createElement>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  for (let i = 0; i < 5; i += 1) await act(async () => void (await new Promise((res) => setImmediate(res))));
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
function tableText(t: TestRenderer.ReactTestInstance): string[] {
  const rows = t.findAllByType("tr").map((tr) => tr.findAll((n) => n.type === "th" || n.type === "td").map(text).join(" | "));
  return [text(t.findByType("caption")), ...rows];
}
/** A structured card's own content: each field section's text, without the saved-record label and the disclosure. */
function structuredContent(c: TestRenderer.ReactTestInstance): string[] {
  return c.children
    .filter((x): x is TestRenderer.ReactTestInstance => typeof x !== "string")
    .filter((x) => byTestId(x, "saved-result-origin").length === 0 && byTestId(x, "original-response").length === 0)
    .map(text);
}
function expectNoProviderOrWrite(before: number) {
  for (const c of connectors) expect(c).not.toHaveBeenCalled();
  expect(db.writeLog.length).toBe(before);
}

jest.setTimeout(60_000);

beforeEach(() => {
  for (const c of connectors) c.mockReset();
  mockedAuthedFetch.mockReset();
  mockedRunPanel.mockReset();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const RECORD = "adaptiveDisplayResults";

// ─── The write site ─────────────────────────────────────────────────────────

describe("write site (lib/runPanelExecution.ts)", () => {
  const src = readFileSync(join(process.cwd(), "lib/runPanelExecution.ts"), "utf8");
  it("O-2: captured only when the adaptive output saved and completeRun succeeded; written once, LAST — after governance initialization, automated governance and retry accounting", () => {
    const persist = src.indexOf("await persistAdaptiveOutput(runId, adaptiveOutput.persistedOutput)");
    const capture = src.indexOf("pendingDisplayResults = {");
    const init = src.indexOf("initializeAdaptiveGovernanceRecord({");
    const automated = src.indexOf("await persistAutomatedGovernanceUpdate(");
    const accounting = src.indexOf("await applyAdaptiveRetryAccounting({");
    const call = src.indexOf("persistAdaptiveDisplayResults(pendingDisplayResults)");
    expect(src.split("persistAdaptiveDisplayResults(").length - 1).toBe(1);
    expect(src.split("pendingDisplayResults = {").length - 1).toBe(1);
    for (const i of [persist, capture, init, automated, accounting, call]) expect(i).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(persist);
    expect(call).toBeGreaterThan(init);
    expect(call).toBeGreaterThan(automated);
    expect(call).toBeGreaterThan(accounting);
    const gate = src.slice(src.lastIndexOf("if (", capture), capture);
    expect(gate).toContain('adaptivePayload.persistenceStatus === "saved"');
    expect(gate).toContain("completeRunSucceeded");
    const outerGate = src.lastIndexOf("if (pendingDisplayResults && adaptivePayload)", call);
    expect(outerGate).toBeGreaterThan(accounting);
    const gated = src.slice(outerGate, call);
    // Review of O-2, finding 1: never while accounting may still be in flight, never without budget, always bounded.
    expect(gated).toContain('retryAccountingStatus === "foreground_wait_expired" || retryAccountingStatus === "skipped_insufficient_budget"');
    expect(gated).toContain("computeAdaptiveDisplayWriteWaitMs({ budget: requestBudget");
    expect(gated).toContain("displayWaitMs >= ADAPTIVE_DISPLAY_WRITE_MIN_WAIT_MS");
    expect(src.slice(call, call + 900)).toContain("Promise.race([write, expired])");
  });
});

// ─── Cases ──────────────────────────────────────────────────────────────────

describe("the saved record of what the report used", () => {
  it("original valid: saved as original_accepted; reopened shows the same table as live, the first answer behind the disclosure", async () => {
    const { live, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", bare("Claude"))]);
    expect(stored[RECORD].bySlot.chatgpt).toMatchObject({ availability: "available", origin: "original_accepted", retryOutcome: null, slotIndex: 0, executedStatus: "ok" });
    const before = db.writeLog.length;
    const reopened = await renderPersonal(stored);
    const liveR = TestRenderer.create(createElement(ModelResponsesSection, { schema, results: live }));
    for (const m of ["chatgpt", "claude"]) {
      const a = card(liveR, "structured-model-response", m)[0];
      const b = card(reopened, "structured-model-response", m)[0];
      expect(structuredContent(b)).toEqual(structuredContent(a));
      expect(tableText(b.findByType("table"))).toEqual(tableText(a.findByType("table")));
      expect(text(byTestId(b, "saved-result-origin")[0])).toBe(ADOPTED_RESULT_ORIGIN_LABEL.original_accepted);
      const disclosure = byTestId(b, "original-response")[0];
      expect(text(disclosure.findByType("summary"))).toBe("Show original response");
      expect(text(byTestId(disclosure, "original-response-label")[0])).toBe(FIRST_ANSWER_DISCLOSURE_LABEL);
    }
    expect(text(byTestId(card(reopened, "structured-model-response", "chatgpt")[0], "original-response")[0].findByType("pre"))).toBe(bare("ChatGPT"));
    expect(counts(reopened)).toEqual([["2 models requested · 2 answered", "2 structured responses shown"]]);
    expectNoProviderOrWrite(before);
  });

  it("adopted full retry: the reopened report shows the RETRY's table, labelled; the first answer stays behind the disclosure, labelled as the first answer", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { live, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(live.find((r) => r.modelId === "claude").retryOutcome).toBe("adopted_full");
    // The first answer is still the saved copy, unchanged.
    const savedClaude = stored.runDocument.perModel.find((p: any) => p.modelId === "claude");
    expect(savedClaude.rawTextTruncated).toBe(CLAUDE_PROSE_WRAPPED);
    expect(stored[RECORD].bySlot.claude).toMatchObject({ origin: "retry_adopted_full", retryOutcome: "adopted_full" });
    claude.mockReset();
    const before = db.writeLog.length;
    for (const r of [await renderPersonal(stored), await renderTeam(stored), await renderTeam(stored, "team_reviewer")]) {
      const c = card(r, "structured-model-response", "claude");
      expect(c).toHaveLength(1);
      expect(tableText(c[0].findByType("table")).slice(2)).toEqual(["Carbon Taxes | ClaudeRetry high (Better)", "Regulatory Standards | ClaudeRetry moderate (Worse)"]);
      expect(text(byTestId(c[0], "saved-result-origin")[0])).toBe(ADOPTED_RESULT_ORIGIN_LABEL.retry_adopted_full);
      const disclosure = byTestId(c[0], "original-response")[0];
      expect(text(disclosure.findByType("summary"))).toBe("Show original response");
      expect(text(byTestId(disclosure, "original-response-label")[0])).toBe(FIRST_ANSWER_DISCLOSURE_LABEL);
      expect(text(disclosure.findByType("pre"))).toBe(CLAUDE_PROSE_WRAPPED);
      // #312's "not preserved" notice is gone for this slot: the adopted result IS preserved now.
      expect(text(r)).not.toContain(SAVED_COPY_RETRIED_AFTER_NAME);
      expect(card(r, "saved-text-model-response", "claude")).toHaveLength(0);
      expect(counts(r)).toEqual([["2 models requested · 2 answered", "2 structured responses shown"]]);
    }
    // Live and reopened show the same Claude content.
    const liveR = TestRenderer.create(createElement(ModelResponsesSection, { schema, results: live }));
    const reopened = await renderPersonal(stored);
    expect(structuredContent(card(reopened, "structured-model-response", "claude")[0])).toEqual(structuredContent(card(liveR, "structured-model-response", "claude")[0]));
    expectNoProviderOrWrite(before);
  });

  it("adopted partial retry: the merged validated data is shown, and said to be the report's final data, not one call's verbatim output", async () => {
    grok.mockResolvedValueOnce(retryOk("grok", bare("GrokRetry")));
    const { live, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("grok", GROK_PARTIAL)]);
    const liveGrok = live.find((r) => r.modelId === "grok");
    expect(liveGrok.retryOutcome).toBe("adopted_partial");
    expect(stored[RECORD].bySlot.grok).toMatchObject({ origin: "retry_adopted_partial", retryOutcome: "adopted_partial" });
    expect(stored[RECORD].bySlot.grok.data.cells[0].value).toBe("GrokFirst high");
    expect(stored[RECORD].bySlot.grok.data.directConclusion).toBe("GrokRetry: carbon pricing leads on cost-effectiveness.");
    grok.mockReset();
    const r = await renderPersonal(stored);
    const c = card(r, "structured-model-response", "grok")[0];
    expect(text(byTestId(c, "saved-result-origin")[0])).toBe(ADOPTED_RESULT_ORIGIN_LABEL.retry_adopted_partial);
    expect(ADOPTED_RESULT_ORIGIN_LABEL.retry_adopted_partial).toMatch(/validated final data the report used/);
    expect(ADOPTED_RESULT_ORIGIN_LABEL.retry_adopted_partial).toMatch(/not the verbatim output of a single call/);
    expect(tableText(c.findByType("table")).slice(2)).toEqual(["Carbon Taxes | GrokFirst high (Better)", "Regulatory Standards | GrokFirst moderate (Worse)"]);
    expect(text(c)).toContain("GrokRetry: carbon pricing leads on cost-effectiveness.");
    expect(text(byTestId(c, "original-response")[0].findByType("pre"))).toBe(GROK_PARTIAL);
    const liveR = TestRenderer.create(createElement(ModelResponsesSection, { schema, results: live }));
    expect(structuredContent(c)).toEqual(structuredContent(card(liveR, "structured-model-response", "grok")[0]));
  });

  it("retry failure: recorded as unavailable with failed_call; the reopened report is exactly #312's (saved first answer as saved text)", async () => {
    claude.mockResolvedValueOnce({ modelId: "claude", status: "error", rawText: null, errorMessage: "overloaded", latencyMs: 5 });
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(stored[RECORD].bySlot.claude).toEqual({ availability: "unavailable", reason: "no_validated_data", slotIndex: 1, executedStatus: "ok", retryOutcome: "failed_call" });
    claude.mockReset();
    const r = await renderPersonal(stored);
    const saved = card(r, "saved-text-model-response", "claude");
    expect(saved).toHaveLength(1);
    expect(text(saved[0])).toContain(SAVED_TEXT_UNSTRUCTURED_LABEL);
    // Same Claude card as without the record.
    const fallback = await renderPersonal(withoutRecord(stored));
    expect(text(card(r, "saved-text-model-response", "claude")[0])).toBe(text(card(fallback, "saved-text-model-response", "claude")[0]));
  });

  it("retry attempted but not adopted (no usable field): recorded as unavailable with no_change; #312's presentation", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", "still not json"));
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(stored[RECORD].bySlot.claude).toMatchObject({ availability: "unavailable", reason: "no_validated_data", retryOutcome: "no_change" });
    claude.mockReset();
    const r = await renderPersonal(stored);
    expect(card(r, "saved-text-model-response", "claude")).toHaveLength(1);
  });

  it("retry timed out at the real guard (fake clock): failed_call, unavailable; #312's presentation", async () => {
    jest.useFakeTimers({ doNotFake: ["performance", "nextTick", "setImmediate", "queueMicrotask"] });
    claude.mockImplementationOnce(() => new Promise(() => {})); // never resolves: only the guard can end the call
    const { live, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)], { fakeTimers: true });
    jest.useRealTimers();
    expect(live.find((r) => r.modelId === "claude").retryOutcome).toBe("failed_call");
    expect(stored[RECORD].bySlot.claude).toMatchObject({ availability: "unavailable", retryOutcome: "failed_call" });
    expect(stored.adaptiveRetryUsage.byModel.claude.usageUnavailableCalls).toBe(1);
    claude.mockReset();
    expect(card(await renderPersonal(stored), "saved-text-model-response", "claude")).toHaveLength(1);
  });

  it("first call timed out (no answer): recorded with its status; the slot did not respond", async () => {
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), { modelId: "grok", status: "timeout", rawText: "", latencyMs: 9 } as never]);
    expect(stored[RECORD].bySlot.grok).toEqual({ availability: "unavailable", reason: "no_validated_data", slotIndex: 1, executedStatus: "timeout", retryOutcome: null });
    const r = await renderPersonal(stored);
    expect(counts(r)).toEqual([["2 models requested · 1 answered · 1 did not respond", "1 structured response shown"]]);
  });

  it("shortened original: a first answer that validated live but was shortened for storage is shown from the record, the shortened copy labelled", async () => {
    // One long token in a field the aggregate never fuzzy-deduplicates (no word cap applies): shortened for storage, still
    // valid live. (Three long uncertainties would also work but cost ~40 s in the pre-existing full-matrix Levenshtein of
    // lib/adaptiveSchema/textSimilarity.ts — tracked separately.)
    const long = bare("ChatGPT", { directConclusion: "x".repeat(MAX_CHARS_STORAGE_PER_MODEL + 100) });
    expect(long.length).toBeGreaterThan(MAX_CHARS_STORAGE_PER_MODEL);
    const { live, stored } = await execute([ok("chatgpt", long), ok("claude", bare("Claude"))]);
    expect(live.find((r) => r.modelId === "chatgpt").ok).toBe(true);
    expect(stored.runDocument.perModel[0].wasTruncated).toBe(true);
    expect(stored[RECORD].bySlot.chatgpt).toMatchObject({ availability: "available", origin: "original_accepted" });
    const r = await renderPersonal(stored);
    const c = card(r, "structured-model-response", "chatgpt")[0];
    expect(tableText(c.findByType("table")).slice(2)).toEqual(["Carbon Taxes | ChatGPT high (Better)", "Regulatory Standards | ChatGPT moderate (Worse)"]);
    expect(text(byTestId(c, "original-response-label")[0])).toBe(`${FIRST_ANSWER_DISCLOSURE_LABEL} ${FIRST_ANSWER_SHORTENED_NOTE}`);
    expect(text(byTestId(c, "original-response")[0].findByType("pre"))).toBe(stored.runDocument.perModel[0].rawTextTruncated);
    // Without the record, #312's shortened saved text.
    expect(card(await renderPersonal(withoutRecord(stored)), "saved-text-model-response", "chatgpt")).toHaveLength(1);
  });

  it("substituted executing provider: the substitute's validated answer is saved as an accepted original, never as a retry", async () => {
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", bare("DeepSeekSub"), "substituted")]);
    expect(stored[RECORD].bySlot.claude).toMatchObject({ availability: "available", executedStatus: "substituted", origin: "original_accepted", retryOutcome: null });
    const r = await renderPersonal(stored);
    expect(tableText(card(r, "structured-model-response", "claude")[0].findByType("table")).slice(2)).toEqual(["Carbon Taxes | DeepSeekSub high (Better)", "Regulatory Standards | DeepSeekSub moderate (Worse)"]);
    expect(counts(r)).toEqual([["2 models requested · 2 answered (1 by a substitute model)", "2 structured responses shown"]]);
    // An invalid substituted answer is never retried: recorded ineligible, unavailable.
    const { stored: s2 } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", "not json", "substituted")]);
    expect(s2[RECORD].bySlot.claude).toMatchObject({ availability: "unavailable", retryOutcome: "ineligible_substituted", executedStatus: "substituted" });
    for (const c of connectors) expect(c).not.toHaveBeenCalled();
  });

  it("duplicate model slots: marked duplicate_slot, never bound; the reopened report is #312's", async () => {
    claude.mockResolvedValue(retryOk("claude", bare("ClaudeRetry")));
    const { stored } = await execute([ok("claude", CLAUDE_PROSE_WRAPPED), ok("claude", bare("ClaudeB")), ok("grok", bare("Grok"))]);
    expect(stored[RECORD].bySlot.claude).toEqual({ availability: "unavailable", reason: "duplicate_slot" });
    claude.mockReset();
    const a = await readAs(stored);
    const b = await readAs(withoutRecord(stored));
    expect(a.adaptive.modelResults.filter((m: any) => m.modelId === "claude")).toEqual(b.adaptive.modelResults.filter((m: any) => m.modelId === "claude"));
  });
});

describe("historical, malformed and unavailable records fall back to #312", () => {
  async function adoptedRun() {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const out = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    claude.mockReset();
    return out;
  }

  it.each([
    ["absent (a historical run)", (_r: any) => undefined],
    ["null", () => null],
    ["a future version", (r: any) => ({ ...r, schemaVersion: 2 })],
    ["a string", () => "corrupt"],
    ["missing bySlot", (r: any) => ({ ...r, bySlot: undefined })],
    ["another run's record", (r: any) => ({ ...r, runId: "someone-elses-run" })],
    ["another schema", (r: any) => ({ ...r, schemaId: "ranked_enumeration" })],
    ["slot data tampered (not what the validator accepts)", (r: any) => ({ ...r, bySlot: { ...r.bySlot, claude: { ...r.bySlot.claude, data: { ...r.bySlot.claude.data, cells: "x" } } } })],
    ["slot bound to the wrong index", (r: any) => ({ ...r, bySlot: { ...r.bySlot, claude: { ...r.bySlot.claude, slotIndex: 0 } } })],
    ["slot marked unavailable (size limit)", (r: any) => ({ ...r, bySlot: { ...r.bySlot, claude: { availability: "unavailable", reason: "size_limit", slotIndex: 1, executedStatus: "ok", retryOutcome: "adopted_full" } } })],
  ])("%s: never crashes; the Claude slot reads exactly as without a record", async (_l, mutate) => {
    const { stored } = await adoptedRun();
    const next = mutate(stored[RECORD]);
    const doc = next === undefined ? withoutRecord(stored) : { ...stored, [RECORD]: next };
    const a = await readAs(doc);
    const b = await readAs(withoutRecord(stored));
    expect(a.adaptive.modelResults.find((m: any) => m.modelId === "claude")).toEqual(b.adaptive.modelResults.find((m: any) => m.modelId === "claude"));
    const r = await renderPersonal(doc);
    expect(text(r)).toContain(`Claude${SAVED_COPY_RETRIED_AFTER_NAME}`);
  });
});

describe("persistence: failure, repetition, concurrency, size, deletion", () => {
  it("a failed commit leaves no record: the run does not appear to have a saved adopted copy; the response is unaffected", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    db.docs.clear();
    const results = [ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)];
    db.seed(`runs/${RUN_ID}`, { userId: OWNER, question: QUESTION, status: "running", selectedModels: ["chatgpt", "claude"] });
    mockedRunPanel.mockResolvedValue(results);
    let failing = true;
    db.hooks = {};
    // Fail exactly the transaction that writes the record (recognized by its own field in the buffered writes).
    const realRun = db.runTransaction.bind(db);
    jest.spyOn(db, "runTransaction").mockImplementation(async (fn: any) => {
      return realRun(async (tx: any) => {
        const out = await fn(tx);
        if (failing && tx.writes.some((w: any) => w.path === displayPath(RUN_ID))) throw new Error("UNAVAILABLE: injected commit failure");
        return out;
      });
    });
    const res = await executeOrdinaryRun({
      uid: OWNER,
      runId: RUN_ID,
      trimmedQuestion: QUESTION,
      context: null,
      selectedModels: ["chatgpt", "claude"] as never,
      adaptivePlan: { classification: CLASSIFICATION, schema, promptOverrides: { chatgpt: SYSTEM_PROMPT, claude: SYSTEM_PROMPT }, routing: { kind: "active", schema } as never },
      debugRawResponseRequested: false,
      requestBudget: { startedAtMonoMs: performance.now(), budgetMs: 300_000 },
    });
    failing = false;
    expect(res.status).toBe(200);
    expect((res.body as any).adaptive.persistenceStatus).toBe("saved");
    const stored = viewOf(RUN_ID);
    expect(RECORD in stored).toBe(false);
    expect(db.read(displayPath(RUN_ID))).toBeUndefined();
    expect(stored.adaptiveOutput).toBeDefined();
    // Every mandatory write before it committed (case 8: the optional write's failure blocks nothing).
    expect(stored.governanceRecord).toBeDefined();
    expect(stored.governanceRecord.automatedGovernance).toBeDefined();
    expect(stored.adaptiveRetryUsage).toBeDefined();
    expect((res.body as any).adaptive.governanceInitializationStatus).toBe("created");
    claude.mockReset();
    const r = await renderPersonal(stored);
    expect(text(r)).toContain(`Claude${SAVED_COPY_RETRIED_AFTER_NAME}`);
    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.warn).toHaveBeenCalledWith("[adaptiveDisplayResults] Not written: write failed", expect.objectContaining({ runId: RUN_ID }));
  });

  it("when the adaptive output did not save, the record is not written either (no adopted copy without its report)", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const realRun = db.runTransaction.bind(db);
    jest.spyOn(db, "runTransaction").mockImplementation(async (fn: any) =>
      realRun(async (tx: any) => {
        const out = await fn(tx);
        if (tx.writes.some((w: any) => "adaptiveOutput" in w.data)) throw new Error("UNAVAILABLE: injected adaptiveOutput failure");
        return out;
      })
    );
    const { body, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(body.adaptive.persistenceStatus).toBe("failed");
    expect("adaptiveOutput" in stored).toBe(false);
    expect(RECORD in stored).toBe(false);
    expect(db.read(displayPath(RUN_ID))).toBeUndefined();
  });

  it("a repeated write is a no-op: the first record stays byte-identical", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { stored, live } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const again = await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }], adaptiveResults: live.map((r) => ({ ...r, data: { directConclusion: "DIFFERENT" } })) });
    expect(again).toEqual({ status: "already_exists" });
    expect(viewOf(RUN_ID)).toEqual(stored);
  });

  it("concurrent writers: exactly one record commits; the loser re-runs, sees it, and writes nothing", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { live } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    db.docs.delete(displayPath(RUN_ID));
    const rows = [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }];
    const variant = live.map((r) => (r.modelId === "chatgpt" ? { ...r, data: { ...r.data, directConclusion: "competitor" } } : r));
    let injected = false;
    db.hooks.afterTxReads = async () => {
      if (injected) return;
      injected = true;
      expect(await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: variant })).toMatchObject({ status: "saved" });
    };
    const first = await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: live });
    db.hooks = {};
    expect(first).toEqual({ status: "already_exists" });
    expect((db.read(displayPath(RUN_ID)) as any).bySlot.chatgpt.data.directConclusion).toBe("competitor");
  });

  it("the display document's own boundary (950,000 bytes, Firestore's size rules): exactly at it is saved; one byte over is not written; the run document is never touched", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { live } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const rows = [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }];
    const runBefore = db.read(`runs/${RUN_ID}`);
    // A record of a chosen exact document size (the builder's own 256 KiB bound cannot reach 950,000, so the ceiling is
    // defence in depth; it is exercised here with a builder stand-in). Measured by an independent oracle, too.
    const record = (pad: number) => ({ schemaVersion: 1, runId: RUN_ID, schemaId: "comparison_matrix", bySlot: { chatgpt: { availability: "unavailable", reason: "size_limit", pad: "p".repeat(pad) } } });
    const base = adaptiveDisplayDocumentBytes(RUN_ID, record(0));
    const atLimit = record(FIRESTORE_DOCUMENT_BUDGET_BYTES - base);
    expect(oracleDocumentBytes(displayPath(RUN_ID), atLimit)).toBe(FIRESTORE_DOCUMENT_BUDGET_BYTES);
    const spy = jest.spyOn(adoptedDisplay, "buildAdaptiveDisplayResultsRecord");

    db.docs.delete(displayPath(RUN_ID));
    spy.mockReturnValueOnce({ ok: true, record: atLimit as never, bytes: 0, omittedForSize: 0 });
    expect(await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: live })).toEqual({ status: "saved", slots: 1, omittedForSize: 0, documentBytes: FIRESTORE_DOCUMENT_BUDGET_BYTES });
    expect(db.read(displayPath(RUN_ID))).toEqual(atLimit);

    db.docs.delete(displayPath(RUN_ID));
    const overLimit = record(FIRESTORE_DOCUMENT_BUDGET_BYTES - base + 1);
    expect(oracleDocumentBytes(displayPath(RUN_ID), overLimit)).toBe(FIRESTORE_DOCUMENT_BUDGET_BYTES + 1);
    spy.mockReturnValueOnce({ ok: true, record: overLimit as never, bytes: 0, omittedForSize: 0 });
    expect(await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: live })).toEqual({ status: "not_written", reason: "oversized" });
    expect(db.read(displayPath(RUN_ID))).toBeUndefined();
    // Truthful fallback: without the record the reopened slot is #312's saved first answer, never a truncated record.
    const r = await renderPersonal(viewOf(RUN_ID));
    expect(text(r)).toContain(`Claude${SAVED_COPY_RETRIED_AFTER_NAME}`);
    expect(db.read(`runs/${RUN_ID}`)).toEqual(runBefore);
  });

  it("the record bound itself: a record at the 256 KiB record bound is kept whole; one byte less omits a slot, never truncating it", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { stored, live } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const rows = [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }];
    const fullBytes = firestoreFieldBytes(RECORD, stored[RECORD]);
    const whole = adoptedDisplay.buildAdaptiveDisplayResultsRecord({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: live as never, maxRecordBytes: fullBytes });
    expect(whole).toMatchObject({ ok: true, omittedForSize: 0 });
    const less = adoptedDisplay.buildAdaptiveDisplayResultsRecord({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: live as never, maxRecordBytes: fullBytes - 1 });
    expect(less).toMatchObject({ ok: true, omittedForSize: 1 });
    const slots = Object.values((less as any).record.bySlot) as any[];
    for (const x of slots) {
      if (x.availability === "available") expect(x.data).toEqual(live[x.slotIndex].data);
      else expect([x.reason, "data" in x]).toEqual(["size_limit", false]);
    }
  });

  it("a validated slot larger than the per-slot bound is omitted and marked; the other slot is saved whole; the reopened slot falls back", async () => {
    const huge = bare("ChatGPT", { directConclusion: "x".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES + 10) }); // one long token: no word cap applies
    const { stored, live } = await execute([ok("chatgpt", huge), ok("claude", bare("Claude"))]);
    expect(live[0].ok).toBe(true);
    expect(stored[RECORD].bySlot.chatgpt).toEqual({ availability: "unavailable", reason: "size_limit", slotIndex: 0, executedStatus: "ok", retryOutcome: null });
    expect(stored[RECORD].bySlot.claude).toMatchObject({ availability: "available", origin: "original_accepted" });
    const a = await readAs(stored);
    const b = await readAs(withoutRecord(stored));
    expect(a.adaptive.modelResults[0]).toEqual(b.adaptive.modelResults[0]);
  });

  it("a run whose deletion started is never written (deletion barrier)", async () => {
    const { stored, live } = await execute([ok("chatgpt", bare("ChatGPT"))]);
    db.docs.delete(displayPath(RUN_ID));
    const doc = db.read(`runs/${RUN_ID}`)!;
    db.seed(`runs/${RUN_ID}`, { ...doc, deletion: { requestedAt: "x" } });
    expect(await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: [{ modelId: "chatgpt", status: "ok" }], adaptiveResults: live })).toEqual({ status: "refused", reason: "deleting" });
    db.docs.delete(`runs/${RUN_ID}`);
    expect(await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: [{ modelId: "chatgpt", status: "ok" }], adaptiveResults: live })).toEqual({ status: "refused", reason: "missing" });
    expect(db.docs.has(`runs/${RUN_ID}`)).toBe(false);
    expect(db.docs.has(displayPath(RUN_ID))).toBe(false);
    void stored;
  });
});

describe("O-2: storage order and capacity (owner ruling, Order 40)", () => {
  const idx = (pred: (w: { path: string; data: Record<string, unknown> }) => boolean) => db.writeLog.findIndex(pred);
  const runPath = `runs/${RUN_ID}`;
  const isDisplay = (w: { path: string }) => w.path === displayPath(RUN_ID);

  it("order at run time: the display document is written after governanceRecord, automated governance and retry accounting", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const display = idx(isDisplay);
    const governance = idx((w) => w.path === runPath && "governanceRecord" in w.data);
    const automated = idx((w) => w.path === runPath && "governanceRecord.automatedGovernance" in w.data);
    const accounting = idx((w) => w.path === runPath && "adaptiveRetryUsage" in w.data);
    for (const i of [display, governance, automated, accounting]) expect(i).toBeGreaterThan(-1);
    expect(display).toBeGreaterThan(Math.max(governance, automated, accounting));
    expect(display).toBe(db.writeLog.length - 1);
  });

  it("a large run at Firestore's real limit: governance initializes, accounting applies, the record is saved in its own document, and the run document is exactly what it would be without the feature", async () => {
    // Learn the final run-document size with no bulk.
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const probe = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const finalRun = db.docs.get(runPath)!.data;
    const finalBytes = oracleDocumentBytes(runPath, finalRun);
    const record = probe.stored[RECORD];
    // Bulk that leaves the finished run document 100 bytes under 1,048,576.
    const bulkLen = FIRESTORE_DOCUMENT_LIMIT_BYTES - 100 - finalBytes - (Buffer.byteLength("bulk") + 1) - 1;
    const enforced = enforceFirestoreDocumentLimit();
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { body, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)], { seed: { bulk: "b".repeat(bulkLen) } });
    expect(enforced.refusals).toEqual([]);
    expect(body.adaptive.governanceInitializationStatus).toBe("created");
    expect(stored.governanceRecord.automatedGovernance).toBeDefined();
    expect(stored.adaptiveRetryUsage).toBeDefined();
    expect(stored[RECORD]).toEqual(record);
    const runBytes = oracleDocumentBytes(runPath, db.docs.get(runPath)!.data);
    expect(runBytes).toBe(FIRESTORE_DOCUMENT_LIMIT_BYTES - 100);
    // The counterfactual: had the record been a field of this run document (the pre-correction design), it could not fit.
    expect(runBytes + firestoreFieldBytes(RECORD, record)).toBeGreaterThan(FIRESTORE_DOCUMENT_LIMIT_BYTES);
    expect(oracleDocumentBytes(displayPath(RUN_ID), record)).toBeLessThanOrEqual(FIRESTORE_DOCUMENT_BUDGET_BYTES);
  });

  it("no remaining capacity in the run document: the record still saves in its own document; the run document is byte-identical before and after the display write", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { live } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    db.docs.delete(displayPath(RUN_ID));
    const run = db.docs.get(runPath)!.data;
    db.seed(runPath, { ...run, bulk: "b".repeat(FIRESTORE_DOCUMENT_LIMIT_BYTES - oracleDocumentBytes(runPath, run) - (Buffer.byteLength("bulk") + 1) - 1) });
    expect(oracleDocumentBytes(runPath, db.docs.get(runPath)!.data)).toBe(FIRESTORE_DOCUMENT_LIMIT_BYTES);
    const before = db.read(runPath);
    const enforced = enforceFirestoreDocumentLimit();
    const rows = [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }];
    expect(await persistAdaptiveDisplayResults({ runId: RUN_ID, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: live })).toMatchObject({ status: "saved", slots: 2 });
    expect(enforced.refusals).toEqual([]);
    expect(db.read(runPath)).toEqual(before);
  });

  it("governance initialization failure: the optional write neither causes it nor depends on it; the record is still saved", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const realRun = db.runTransaction.bind(db);
    jest.spyOn(db, "runTransaction").mockImplementation(async (fn: any) =>
      realRun(async (tx: any) => {
        const out = await fn(tx);
        if (tx.writes.some((w: any) => w.path === runPath && "governanceRecord" in w.data)) throw new Error("UNAVAILABLE: injected governance failure");
        return out;
      })
    );
    const { body, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(body.adaptive.governanceInitializationStatus).toBe("failed");
    expect(stored.governanceRecord).toBeUndefined();
    expect(stored[RECORD].bySlot.claude).toMatchObject({ origin: "retry_adopted_full" });
  });

  it("retry-accounting failure: the record is still saved after it; accounting is reported failed in the logs, the response is 200", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const realRun = db.runTransaction.bind(db);
    jest.spyOn(db, "runTransaction").mockImplementation(async (fn: any) =>
      realRun(async (tx: any) => {
        const out = await fn(tx);
        if (tx.writes.some((w: any) => "adaptiveRetryUsage" in w.data)) throw new Error("UNAVAILABLE: injected accounting failure");
        return out;
      })
    );
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    expect(stored.adaptiveRetryUsage).toBeUndefined();
    expect(stored.governanceRecord).toBeDefined();
    expect(stored[RECORD].bySlot.claude).toMatchObject({ origin: "retry_adopted_full" });
    const { logger } = jest.requireMock("@/lib/logger");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Supplemental retry accounting FAILED"), expect.objectContaining({ runId: RUN_ID }));
  });

  it.each([
    ["deletion started", (run: Record<string, unknown>) => db.seed(runPath, { ...run, deletion: { state: "pending", requestedAt: "x" } }), "deleting"],
    ["run removed", () => db.docs.delete(runPath), "missing"],
  ] as const)("run deleted between stages (%s, after retry accounting, before the display write): never written", async (_l, del, reason) => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const realRun = db.runTransaction.bind(db);
    jest.spyOn(db, "runTransaction").mockImplementation(async (fn: any) => {
      let accounting = false;
      const out = await realRun(async (tx: any) => {
        const r = await fn(tx);
        accounting = tx.writes.some((w: any) => "adaptiveRetryUsage" in w.data);
        return r;
      });
      if (accounting) del(db.read(runPath)!);
      return out;
    });
    const spy = jest.spyOn(jest.requireMock("@/lib/logger").logger, "warn");
    db.docs.clear();
    db.hooks = {};
    db.seed(runPath, { userId: OWNER, question: QUESTION, status: "running", selectedModels: ["chatgpt", "claude"] });
    mockedRunPanel.mockResolvedValue([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const res = await executeOrdinaryRun({
      uid: OWNER, runId: RUN_ID, trimmedQuestion: QUESTION, context: null, selectedModels: ["chatgpt", "claude"] as never,
      adaptivePlan: { classification: CLASSIFICATION, schema, promptOverrides: { chatgpt: SYSTEM_PROMPT, claude: SYSTEM_PROMPT }, routing: { kind: "active", schema } as never },
      debugRawResponseRequested: false, requestBudget: { startedAtMonoMs: performance.now(), budgetMs: 300_000 },
    });
    expect(res.status).toBe(200);
    expect(db.read(displayPath(RUN_ID))).toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[adaptiveDisplayResults] Not written: research write refused", expect.objectContaining({ runId: RUN_ID, refusal: reason }));
  });

  describe("the optional write yields to accounting and to the request budget (review of O-2, finding 1)", () => {
    const delayCommitOf = (pred: (tx: any) => boolean, ms: number, onGovernance?: () => void) => {
      const realRun = db.runTransaction.bind(db);
      jest.spyOn(db, "runTransaction").mockImplementation(async (fn: any) =>
        realRun(async (tx: any) => {
          const out = await fn(tx);
          if (onGovernance && tx.writes.some((w: any) => w.path === `runs/${RUN_ID}` && "governanceRecord" in w.data)) onGovernance();
          if (pred(tx)) await new Promise((r) => setTimeout(r, ms));
          return out;
        })
      );
    };
    /** A request that ran late: once governance commits, only `remainingMs` of the live budget is left. */
    const lateAfterGovernance = (remainingMs: number) => {
      const budget = { startedAtMonoMs: performance.now(), budgetMs: 300_000 };
      return { budget, shrink: () => void (budget.budgetMs = performance.now() - budget.startedAtMonoMs + remainingMs) };
    };
    const warned = (msg: string) => (jest.requireMock("@/lib/logger").logger.warn as jest.Mock).mock.calls.some((c: any[]) => String(c[0]).startsWith(msg));

    it("retry accounting's foreground wait expired (it may still commit): the display record is not written; the response is 200", async () => {
      claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
      // 7 s left at accounting → 2 s accounting wait; its commit takes 3 s.
      const late = lateAfterGovernance(7_000);
      delayCommitOf((tx) => tx.writes.some((w: any) => "adaptiveRetryUsage" in w.data), 3_000, late.shrink);
      const { body } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)], { budget: late.budget });
      expect(body.adaptive.persistenceStatus).toBe("saved");
      expect(warned("[adaptiveRetryAccounting] Supplemental retry accounting foreground wait expired")).toBe(true);
      expect(warned("[run-panel] adaptiveDisplayResults not written: retry accounting did not settle in the foreground")).toBe(true);
      expect(db.read(displayPath(RUN_ID))).toBeUndefined();
      await new Promise((r) => setTimeout(r, 1_500)); // the abandoned accounting commits; the record still never appears
      expect(db.read(`runs/${RUN_ID}`)!.adaptiveRetryUsage).toBeDefined();
      expect(db.read(displayPath(RUN_ID))).toBeUndefined();
    });

    it("too little budget for accounting (skipped_insufficient_budget): the display record is not written either", async () => {
      claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
      const late = lateAfterGovernance(5_500);
      delayCommitOf(() => false, 0, late.shrink);
      const { body, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)], { budget: late.budget });
      expect(body.adaptive.persistenceStatus).toBe("saved");
      expect(stored.adaptiveRetryUsage).toBeUndefined();
      expect(warned("[adaptiveRetryAccounting] Supplemental retry accounting not attempted: request budget exhausted")).toBe(true);
      expect(RECORD in stored).toBe(false);
      expect(warned("[run-panel] adaptiveDisplayResults not written: retry accounting did not settle in the foreground")).toBe(true);
    });

    it("no retry, but the budget is nearly spent: the display write is not started", async () => {
      const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", bare("Claude"))], { remainingMs: 5_800 });
      expect(RECORD in stored).toBe(false);
      expect(warned("[run-panel] adaptiveDisplayResults not written: request budget exhausted")).toBe(true);
    });

    it("a slow display write is bounded by its own wait, keeping the response-return reserve free", async () => {
      // 8 s left → 3 s display wait; the display commit takes 6 s.
      delayCommitOf((tx) => tx.writes.some((w: any) => w.path === displayPath(RUN_ID)), 6_000);
      const t0 = Date.now();
      const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", bare("Claude"))], { remainingMs: 8_000 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(5_500);
      expect(RECORD in stored).toBe(false);
      expect(warned("[run-panel] adaptiveDisplayResults foreground wait expired")).toBe(true);
      await new Promise((r) => setTimeout(r, 4_000)); // the write-once transaction commits later, at most once
      expect(db.writeLog.filter((w) => w.path === displayPath(RUN_ID))).toHaveLength(1);
    });

    it("computeAdaptiveDisplayWriteWaitMs: min(10 s, remaining − 5 s reserve)", () => {
      const at = (remainingMs: number) => adoptedDisplay.computeAdaptiveDisplayWriteWaitMs({ budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, nowMonoMs: 300_000 - remainingMs });
      expect(at(300_000)).toBe(10_000);
      expect(at(15_000)).toBe(10_000);
      expect(at(8_000)).toBe(3_000);
      expect(at(6_000)).toBe(1_000);
      expect(at(5_999)).toBeLessThan(adoptedDisplay.ADAPTIVE_DISPLAY_WRITE_MIN_WAIT_MS);
    });
  });

  it("later required writes stay safe at the largest display record: a maximum review write to the run document fits exactly as it would without the feature", async () => {
    // The largest record the builder can produce: two slots near the per-slot bound (record bound 256 KiB).
    const big = (who: string) => bare(who, { directConclusion: "x".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES - 1_200) });
    await execute([ok("chatgpt", big("ChatGPT")), ok("claude", big("Claude"))]);
    const display = db.read(displayPath(RUN_ID))!;
    expect(Object.values((display as any).bySlot).every((x: any) => x.availability === "available")).toBe(true);
    expect(oracleDocumentBytes(displayPath(RUN_ID), display)).toBeGreaterThan(100_000);
    // Run document filled so that a 45,000-byte review write lands exactly at the limit.
    const run = db.docs.get(runPath)!.data;
    const REVIEW = 45_000;
    const reviewValue = "r".repeat(REVIEW - (Buffer.byteLength("laterReview") + 1) - 1);
    db.seed(runPath, { ...run, bulk: "b".repeat(FIRESTORE_DOCUMENT_LIMIT_BYTES - REVIEW - oracleDocumentBytes(runPath, run) - (Buffer.byteLength("bulk") + 1) - 1) });
    const enforced = enforceFirestoreDocumentLimit();
    await db.doc(runPath).set({ laterReview: reviewValue }, { merge: true });
    expect(enforced.refusals).toEqual([]);
    expect(oracleDocumentBytes(runPath, db.docs.get(runPath)!.data)).toBe(FIRESTORE_DOCUMENT_LIMIT_BYTES);
    // Control: the enforcement is real — one byte more is refused.
    await expect(db.doc(runPath).set({ laterReview: reviewValue + "r" }, { merge: true })).rejects.toThrow("exceeds the maximum allowed size");
    // The display document was never involved.
    expect(db.read(displayPath(RUN_ID))).toEqual(display);
  });
});

describe("nothing else changes", () => {
  it("the writer writes only its own document, once, by create; never the run document; no prompt, key, retry text or provider payload is stored in it", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    const writes = db.writeLog.filter((w) => w.path === displayPath(RUN_ID));
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].data)).toEqual(["schemaVersion", "runId", "schemaId", "bySlot"]);
    expect(writes[0].kind).toBe("create");
    expect(db.writeLog.filter((w) => w.path === `runs/${RUN_ID}`).every((w) => !Object.keys(w.data).some((k) => k.split(".")[0] === RECORD))).toBe(true);
    const json = JSON.stringify(stored[RECORD]);
    for (const banned of [SYSTEM_PROMPT, SECRET_KEY, "previous response failed validation", "Here is a structured comparison", "tokenUsage", "rawText", "parseError"]) {
      expect(json).not.toContain(banned);
    }
  });

  it("parity: with or without the record, the read payload differs ONLY in adaptive.modelResults; the persisted output, governance and every other field are identical", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { body, stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    for (const role of ["owner", "personal_reviewer", "team_member", "team_reviewer"] as const) {
      const a = await readAs(stored, role);
      const b = await readAs(withoutRecord(stored), role);
      const strip = (p: any) => ({ ...p, adaptive: { ...p.adaptive, modelResults: "<compared separately>" } });
      expect(strip(a)).toEqual(strip(b));
      expect(a.adaptive.output).toEqual(roundTrip(body.adaptive.adaptiveOutput));
      expect(a.adaptive.modelResults.find((m: any) => m.modelId === "chatgpt").data).toEqual(b.adaptive.modelResults.find((m: any) => m.modelId === "chatgpt").data);
    }
    // The write path: the persisted aggregate, the saved first answers and the response are what they were without the writer.
    const writerFree = roundTrip(withoutRecord(stored));
    expect(writerFree.adaptiveOutput).toEqual(roundTrip(body.adaptive.adaptiveOutput));
    expect(writerFree.runDocument.perModel.map((p: any) => p.rawTextTruncated)).toEqual([bare("ChatGPT"), CLAUDE_PROSE_WRAPPED]);
    expect(Object.keys(body.adaptive)).not.toContain(RECORD);
    expect(JSON.stringify(body)).not.toContain(RECORD);
  });
});

// ─── Authenticated read: tenant and run isolation ───────────────────────────

describe("authenticated read (GET /api/user/runs/[runId])", () => {
  async function get(uid: string, runId = RUN_ID) {
    mockedIdentity.mockResolvedValue({ status: "authenticated", uid, source: "session_cookie" });
    const { GET } = await import("@/app/api/user/runs/[runId]/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`http://localhost/api/user/runs/${runId}`), { params: Promise.resolve({ runId }) });
    return { status: res.status, body: await res.json() };
  }

  it("the owner reads the adopted result; another user is refused and receives none of it; another run never carries it", async () => {
    claude.mockResolvedValueOnce(retryOk("claude", bare("ClaudeRetry")));
    const { stored } = await execute([ok("chatgpt", bare("ChatGPT")), ok("claude", CLAUDE_PROSE_WRAPPED)]);
    claude.mockReset();
    const owner = await get(OWNER);
    expect(owner.status).toBe(200);
    const c = owner.body.adaptive.modelResults.find((m: any) => m.modelId === "claude");
    expect([c.ok, c.savedResultOrigin, c.data.directConclusion]).toEqual([true, "retry_adopted_full", "ClaudeRetry: carbon pricing leads on cost-effectiveness."]);
    expect(JSON.stringify(owner.body)).not.toContain(RECORD);

    const intruder = await get("intruder-9");
    expect([403, 404]).toContain(intruder.status);
    expect(JSON.stringify(intruder.body)).not.toMatch(/ClaudeRetry|ClaudeFirst|ChatGPT high/);

    // The same record copied onto ANOTHER run of the same owner is not that run's adopted copy.
    db.seed(`runs/run-other-2`, { ...withoutRecord(stored), runDocument: { ...stored.runDocument, runId: "run-other-2" } });
    db.seed(displayPath("run-other-2"), stored[RECORD]);
    const otherRead = await get(OWNER, "run-other-2");
    expect(otherRead.status).toBe(200);
    const oc = otherRead.body.adaptive.modelResults.find((m: any) => m.modelId === "claude");
    expect(oc.savedResultOrigin).toBeUndefined();
    expect(JSON.stringify(otherRead.body.adaptive.modelResults)).not.toContain("ClaudeRetry");
    for (const conn of connectors) expect(conn).not.toHaveBeenCalled();
  });
});
