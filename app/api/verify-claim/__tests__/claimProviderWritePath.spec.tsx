/**
 * Order 33 (owner ruling A) — REAL write path of a Personal claim verification, end to end.
 *
 * Only the provider SDKs (`openai`, `@anthropic-ai/sdk`) and `fetch` (xAI) are mocked — the network boundary — plus an
 * in-memory Firestore. The real POST /api/verify-claim route, the real claim dispatch (runClaimVerificationPanel →
 * CONNECTOR_MAP), the real connectors, buildClaimModelEvidence and the real saveClaimVerification run; the record the
 * route hands to the Firestore write is captured, read back through the real GET /api/user/verifications/{id} and
 * GET /api/user/panel-history routes and the real governance queue GET, and rendered through the claim result view,
 * History open, the Team list summary → parser → row, the queue row and the memo export wiring.
 */
jest.mock("server-only", () => ({}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "pro", governanceAssignedReviewerEmail: null }) }));
const mockedGenerateMemo = jest.fn((..._a: unknown[]) => "MEMO");
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return { ...actual, generateVerificationMemo: (...a: unknown[]) => mockedGenerateMemo(...a), downloadTextFile: jest.fn() };
});

// ── network / SDK boundary ──────────────────────────────────────────────────────────────────────────────────────
const mockOpenAICreate = jest.fn();
jest.mock("openai", () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } })) }));
const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ messages: { create: (...a: unknown[]) => mockAnthropicCreate(...a) } })) }));

// ── platform doubles (auth, billing, governance side effects) ───────────────────────────────────────────────────
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  XAI_API_KEY: "xai-test",
  PERPLEXITY_API_KEY: "",
  GEMINI_API_KEY: "",
  GROK_MODEL: "grok-test",
  WORKSPACES_ENABLED: true,
  ADMIN_EMAILS: "",
}));
jest.mock("@/lib/firebase/auth-helpers", () => ({ verifySessionCookie: jest.fn().mockResolvedValue({ uid: "uid-1", isAdmin: false }) }));
jest.mock("@/lib/firebase/auth", () => ({ verifyIdToken: jest.fn() }));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: jest.fn().mockResolvedValue({ status: "authenticated", uid: "uid-1", source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }) }));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({ validateUserSubscription: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: jest.fn().mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" }),
}));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() }) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({ applyTeamGovernancePipeline: jest.fn().mockResolvedValue({}), mergeGovernanceIntoBody: (b: unknown) => b }));
jest.mock("@/lib/governance/authCheck", () => ({ resolveGovernanceRequestUser: jest.fn().mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" }) }));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: jest.fn().mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" }),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrityBatch", () => ({ createRunWorkspaceIntegrityBatch: () => async () => ({ classification: "legacy" }) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

let store: ReturnType<typeof import("./claimWritePathHarness").createStore>;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return store.adminDb;
  },
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/verify-claim/route";
import { GET as GET_DETAIL } from "@/app/api/user/verifications/[verificationId]/route";
import { GET as GET_HISTORY } from "@/app/api/user/panel-history/route";
import { GET as GET_QUEUE } from "@/app/api/governance/queue/route";
import ClaimVerificationResultView from "@/components/verification/ClaimVerificationResultView";
import ClaimVerificationResult from "@/components/ClaimVerificationResult";
import { VerificationActions } from "@/components/VerificationActions";
import { FragmentRow } from "@/components/governance/GovernanceDashboard";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { parseTeamClaimListPageResponse } from "@/hooks/useTeamClaimVerificationList";
import { resolveClaimHistoryPayload } from "@/lib/verification/cachedClaimProvenance";
import { claimHistoryConsensusSuffix, CONSENSUS_WITHHELD_TEXT } from "@/lib/verification/claimConsensusPresentation";
import { STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";
import { anthropicResponder, createStore, grokFetchResponse, openAIResponder, silence, verdictJson, type Behaviour } from "./claimWritePathHarness";

const { generateVerificationMemo: realMemo } = jest.requireActual("@/lib/verification/generateMemo");
const WITHHELD = CONSENSUS_WITHHELD_TEXT.independence_unverified;
const NO_CONSENSUS = CONSENSUS_WITHHELD_TEXT.insufficient_independent_models;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

type Case = {
  name: string;
  chatgpt: Behaviour;
  claude: Behaviour;
  grok: Behaviour;
  /** Stored row providers, in slot order chatgpt, claude, grok (undefined = no provider written). */
  providers: Array<string | undefined>;
  statuses: string[];
  independence: "independent" | "insufficient" | "unverified";
  k: number | null;
};
const A = (v = "accurate", extra: Record<string, unknown> = {}): Behaviour => ({ kind: "answer", text: verdictJson(v, extra) });

const CASES: Case[] = [
  { name: "three genuine own-provider successes", chatgpt: A(), claude: A(), grok: A(), providers: ["openai", "anthropic", "xai"], statuses: ["ok", "ok", "ok"], independence: "independent", k: 3 },
  { name: "two genuine successes + a timeout", chatgpt: { kind: "timeout" }, claude: A(), grok: A(), providers: [undefined, "anthropic", "xai"], statuses: ["failed", "ok", "ok"], independence: "independent", k: 2 },
  { name: "two genuine successes + a provider failure", chatgpt: A(), claude: { kind: "http500" }, grok: A("inaccurate"), providers: ["openai", undefined, "xai"], statuses: ["ok", "failed", "ok"], independence: "independent", k: 2 },
  { name: "two genuine successes + a refusal (429)", chatgpt: A(), claude: A(), grok: { kind: "refuse429" }, providers: ["openai", "anthropic", undefined], statuses: ["ok", "ok", "failed"], independence: "independent", k: 2 },
  { name: "two genuine successes + an unparseable answer", chatgpt: A(), claude: A(), grok: { kind: "answer", text: "not json at all" }, providers: ["openai", "anthropic", undefined], statuses: ["ok", "ok", "parse_error"], independence: "independent", k: 2 },
  { name: "one success, two failures", chatgpt: A(), claude: { kind: "timeout" }, grok: { kind: "http500" }, providers: ["openai", undefined, undefined], statuses: ["ok", "failed", "failed"], independence: "insufficient", k: 1 },
  { name: "every provider failed", chatgpt: { kind: "timeout" }, claude: { kind: "http500" }, grok: { kind: "timeout" }, providers: [undefined, undefined, undefined], statuses: ["failed", "failed", "failed"], independence: "unverified", k: null },
  {
    name: "a stored placeholder literal answer (D-5 INVALID_MOCK)",
    chatgpt: { kind: "answer", text: STORED_PLACEHOLDER_LITERALS.chatgpt },
    claude: A(),
    grok: A(),
    providers: [undefined, "anthropic", "xai"],
    statuses: ["parse_error", "ok", "ok"],
    independence: "independent",
    k: 2,
  },
  {
    name: "an answer whose validity cannot be established (D-5 VALIDITY_UNKNOWN) — no provider, record unverified",
    chatgpt: A("accurate", { summary: "This is a mock response used for testing." }),
    claude: A(),
    grok: A(),
    providers: [undefined, "anthropic", "xai"],
    statuses: ["ok", "ok", "ok"],
    independence: "unverified",
    k: null,
  },
];

async function verify(c: Case) {
  mockOpenAICreate.mockImplementation(() => openAIResponder(c.chatgpt));
  mockAnthropicCreate.mockImplementation(() => anthropicResponder(c.claude));
  jest.spyOn(global, "fetch").mockImplementation((() => grokFetchResponse(c.grok)) as never);
  const res = await POST(
    new NextRequest("http://localhost/api/verify-claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "__session=valid" },
      // A request-supplied provider is never read (only the server dispatch stamps one).
      body: JSON.stringify({ claim: "The Eiffel Tower was completed in 1889.", models: ["chatgpt", "claude", "grok"], provider: "openai", modelResults: [{ modelId: "grok", provider: "openai" }] }),
    })
  );
  return { res, body: await res.json() };
}

async function exportMemo(payload: unknown) {
  mockedGenerateMemo.mockClear();
  let tr!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tr = TestRenderer.create(createElement(ClaimVerificationResult, { data: payload as never, onVerifyAnother: () => {} }));
  });
  await act(async () => tr.root.findByType(VerificationActions).props.onExportMemo());
  tr.unmount();
  const input = mockedGenerateMemo.mock.calls[0][0] as Record<string, unknown>;
  return { input, memo: realMemo(input) as string };
}

function renderQueueRow(row: Record<string, unknown>) {
  const noop = () => {};
  return html(
    createElement("table", null,
      createElement("tbody", null,
        createElement(FragmentRow as never, {
          row, chip: { wrap: "", label: "Review" }, mh: { text: "", cls: "", title: "" }, ev: { text: "", cls: "" }, exp: true, firstReason: "", more: "",
          consensusColor: () => "", expanded: new Set<string>(), setExpanded: noop, reviewBusyKey: null, onApprove: noop, onBlock: noop, onChanges: noop,
        } as never)))
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  silence();
  store = createStore({ users: { "uid-1": { email: "user@example.com" } } });
});
afterEach(() => jest.restoreAllMocks());

describe("Personal claim write path → stored record → every read surface", () => {
  it.each(CASES)("$name", async (c) => {
    const { res, body } = await verify(c);
    expect(res.status).toBe(200);
    expect(body.modelIndependence).toBe(c.independence);

    // 1. The record the route handed to the Firestore write.
    const writes = store.writes.filter((w) => w.collection === "verifications");
    expect(writes).toHaveLength(1);
    const { id, doc } = writes[0];
    expect(id).toBe(body.verificationId);
    const rows = doc.modelResults as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.modelId)).toEqual(["chatgpt", "claude", "grok"]);
    expect(rows.map((r) => r.status)).toEqual(c.statuses);
    expect(rows.map((r) => r.provider)).toEqual(c.providers);
    for (const r of rows) {
      expect("substituted" in r).toBe(false); // own-provider answers: the requested slot and the executing provider stay separate fields
      if (r.status !== "ok") expect("provider" in r).toBe(false);
    }
    expect("modelIndependence" in doc).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('"provider":"openai","modelId":"grok"');

    // 2. Read back through the real detail GET.
    const detailRes = await GET_DETAIL(new NextRequest(`http://localhost/api/user/verifications/${id}`), { params: Promise.resolve({ verificationId: id }) } as never);
    const detail = await detailRes.json();
    expect(detailRes.status).toBe(200);
    const payload = detail.payload;
    expect(payload.modelIndependence).toBe(c.independence);
    expect(payload.consensusScore).toBe(doc.consensusScore);
    const score = doc.consensusScore as number;

    // 3. Result view (live response and saved payload render the same independence).
    for (const data of [body, payload]) {
      const view = html(createElement(ClaimVerificationResultView, { data }));
      if (c.independence === "independent") {
        expect(view).toContain(`>${score}</p>`);
        expect(view).not.toContain(WITHHELD);
      } else {
        expect(view).not.toContain(`>${score}</p>`);
        expect(view).toContain(c.independence === "insufficient" ? NO_CONSENSUS : WITHHELD);
      }
    }
    if (c.independence === "independent" && (doc.verdict as string) === "confirmed") {
      expect(html(createElement(ClaimVerificationResultView, { data: payload }))).toContain(`This claim is supported by ${c.k}/${c.k} models`);
    }

    // 4. History: the real panel-history row and History open (a cached payload without independence reads the record).
    const histRes = await GET_HISTORY(new NextRequest("http://localhost/api/user/panel-history"));
    const hist = await histRes.json();
    const item = hist.items.find((i: { id: string }) => i.id === id);
    expect(item.modelIndependence).toBe(c.independence);
    const suffix = claimHistoryConsensusSuffix(item);
    expect(suffix).toBe(c.independence === "independent" ? ` · ${score} consensus` : ` · ${c.independence === "insufficient" ? NO_CONSENSUS : WITHHELD}`);
    const { modelIndependence: _drop, ...cached } = body;
    void _drop;
    const opened = await resolveClaimHistoryPayload(id, cached, async () => payload);
    expect(opened.payload?.modelIndependence).toBe(c.independence);

    // 5. Team list row from the same record shape (summary → client parser → row).
    const summary = toTeamClaimVerificationSummary({ verificationId: id, data: { ...doc, workspaceId: "w" }, workspaceId: "w", projectId: null, project: null });
    const parsed = parseTeamClaimListPageResponse({ ok: true, status: 200, body: { ok: true, scope: "all", items: [summary], hasMore: false }, address: { kind: "workspace", workspaceId: "w", scope: "all" } });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    const teamRow = html(createElement("ul", null, createElement(TeamClaimListRow, { workspaceId: "w", item: parsed.page.items[0], showProject: false })));
    expect(teamRow).toContain(c.independence === "independent" ? `${score}/100 consensus` : c.independence === "insufficient" ? NO_CONSENSUS : WITHHELD);

    // 6. Governance queue row (real GET over the stored record) and its expanded render.
    (doc as Record<string, unknown>).governanceStatus = "needs_review";
    (doc as Record<string, unknown>).governanceReasons = ["r"];
    const qRes = await GET_QUEUE(new NextRequest("http://localhost/api/governance/queue"));
    const q = (await qRes.json()).runs.find((r: { runId: string }) => r.runId === id);
    expect(q).toBeDefined();
    if (c.independence === "independent") {
      expect(["consensusWithheld" in q, "modelIndependence" in q]).toEqual([false, false]);
      expect(renderQueueRow(q)).toContain(`>${score}</td>`);
    } else {
      expect(q.modelIndependence).toBe(c.independence);
      const out = renderQueueRow(q);
      expect(out).not.toContain(`>${score}</td>`);
      expect(out).toContain(c.independence === "insufficient" ? NO_CONSENSUS : WITHHELD);
    }

    // 7. Memo export (the Personal wrapper's wiring → the real generator).
    const { input, memo } = await exportMemo(payload);
    expect(input.claimModelIndependence).toBe(c.independence);
    if (c.independence === "independent") {
      expect(input.claimExecution).toEqual({ independentModels: c.k, answeredSlots: c.k });
      expect(memo).toContain(`CONSENSUS SCORE: ${score}/100`);
      expect(memo).toContain(`${c.k} AI models evaluated this claim independently.`);
    } else {
      expect(memo).not.toContain(`CONSENSUS SCORE: ${score}/100`);
    }
  });
});
