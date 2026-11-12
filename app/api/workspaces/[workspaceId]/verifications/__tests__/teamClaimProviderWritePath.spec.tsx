/**
 * Order 33 (owner ruling A) — REAL write path of a Team claim verification, end to end.
 *
 * Only the provider SDKs / `fetch` (network boundary), the Workspace authorization decisions and an in-memory Firestore
 * are doubled. The real Team POST route, the real claim dispatch and connectors, buildClaimModelEvidence and the real
 * saveTeamClaimVerification (its transaction create is captured) run; the created document is read back through the
 * real Team detail GET and rendered through the result view, the Team list summary → parser → row and the memo wiring.
 */
jest.mock("server-only", () => ({}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "pro", governanceAssignedReviewerEmail: null }) }));
const mockedGenerateMemo = jest.fn((..._a: unknown[]) => "MEMO");
jest.mock("@/lib/verification/generateMemo", () => {
  const actual = jest.requireActual("@/lib/verification/generateMemo");
  return { ...actual, generateVerificationMemo: (...a: unknown[]) => mockedGenerateMemo(...a), downloadTextFile: jest.fn() };
});

const mockOpenAICreate = jest.fn();
jest.mock("openai", () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockOpenAICreate(...a) } } })) }));
const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ messages: { create: (...a: unknown[]) => mockAnthropicCreate(...a) } })) }));

const UID = "member-1";
const WS_ID = "ws-team-1";
jest.mock("@/lib/env", () => ({
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  XAI_API_KEY: "xai-test",
  PERPLEXITY_API_KEY: "",
  GEMINI_API_KEY: "",
  GROK_MODEL: "grok-test",
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: jest.fn().mockResolvedValue({ status: "authenticated", uid: "member-1" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() }) }));
jest.mock("@/lib/workspaces/teamWorkspacesRollout", () => ({ resolveTeamWorkspacesMode: () => ({ enabled: true, source: "global" }) }));
jest.mock("@/lib/firestore/teamClaimVerifications", () => {
  const actual = jest.requireActual("@/lib/firestore/teamClaimVerifications");
  // Gate 1 (pre-execution admission) is an authorization decision, not persistence: doubled. Gate 2 / the write is real.
  return { ...actual, authorizeTeamClaimVerificationAdmission: jest.fn().mockResolvedValue({ status: "authorized", workspaceId: "ws-team-1", projectId: null }) };
});
jest.mock("@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction", () => ({
  authorizeTeamWorkspaceMutationInTransaction: jest.fn().mockResolvedValue({ ok: true, membership: { role: "owner" } }),
}));
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: jest.fn().mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] }),
}));
jest.mock("@/lib/stripe/subscriptionValidation", () => ({ validateUserSubscription: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/stripe/usageCheck", () => ({
  checkAndIncrementUsageForRun: jest.fn().mockResolvedValue({ allowed: true, runsThisMonth: 1, maxRunsPerMonth: 100, maxModelsPerRun: 5, plan: "full" }),
}));
jest.mock("@/lib/firestore/userTokens", () => ({ incrementUserTokenUsage: jest.fn().mockResolvedValue({ tokensUsedCurrentPeriod: 0, periodStart: new Date() }) }));
jest.mock("@/lib/governance/evaluateAndStore", () => ({ evaluateAndStoreGovernance: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/governance/teamGovernancePipeline", () => ({ applyTeamGovernancePipeline: jest.fn().mockResolvedValue({}), mergeGovernanceIntoBody: (b: unknown) => b }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

let store: ReturnType<typeof import("@/app/api/verify-claim/__tests__/claimWritePathHarness").createStore>;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return store.adminDb;
  },
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/verifications/route";
import { GET as GET_DETAIL } from "@/app/api/workspaces/[workspaceId]/verifications/[verificationId]/route";
import ClaimVerificationResultView from "@/components/verification/ClaimVerificationResultView";
import ClaimVerificationResult from "@/components/ClaimVerificationResult";
import { VerificationActions } from "@/components/VerificationActions";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import { toTeamClaimVerificationSummary } from "@/lib/workspaces/teamClaimVerificationSummary";
import { parseTeamClaimListPageResponse } from "@/hooks/useTeamClaimVerificationList";
import { CONSENSUS_WITHHELD_TEXT } from "@/lib/verification/claimConsensusPresentation";
import { anthropicResponder, createStore, grokFetchResponse, openAIResponder, silence, verdictJson, type Behaviour } from "@/app/api/verify-claim/__tests__/claimWritePathHarness";

const { generateVerificationMemo: realMemo } = jest.requireActual("@/lib/verification/generateMemo");
const WITHHELD = CONSENSUS_WITHHELD_TEXT.independence_unverified;
const NO_CONSENSUS = CONSENSUS_WITHHELD_TEXT.insufficient_independent_models;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const A = (v = "accurate"): Behaviour => ({ kind: "answer", text: verdictJson(v) });

const CASES: Array<{ name: string; b: [Behaviour, Behaviour, Behaviour]; providers: Array<string | undefined>; independence: string; k: number | null }> = [
  { name: "three genuine own-provider successes", b: [A(), A(), A()], providers: ["openai", "anthropic", "xai"], independence: "independent", k: 3 },
  { name: "two genuine successes + a timeout", b: [A(), { kind: "timeout" }, A()], providers: ["openai", undefined, "xai"], independence: "independent", k: 2 },
  { name: "one success + two failures", b: [{ kind: "http500" }, { kind: "timeout" }, A()], providers: [undefined, undefined, "xai"], independence: "insufficient", k: 1 },
  { name: "every provider failed", b: [{ kind: "timeout" }, { kind: "http500" }, { kind: "refuse429" }], providers: [undefined, undefined, undefined], independence: "unverified", k: null },
];

beforeEach(() => {
  jest.clearAllMocks();
  silence();
  store = createStore({ users: { [UID]: { email: "member@example.com" } } });
});
afterEach(() => jest.restoreAllMocks());

describe("Team claim write path → created document → Team read surfaces", () => {
  it.each(CASES)("$name", async (c) => {
    mockOpenAICreate.mockImplementation(() => openAIResponder(c.b[0]));
    mockAnthropicCreate.mockImplementation(() => anthropicResponder(c.b[1]));
    jest.spyOn(global, "fetch").mockImplementation((() => grokFetchResponse(c.b[2])) as never);
    const res = await POST(
      new NextRequest(`http://localhost/api/workspaces/${WS_ID}/verifications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: "The Eiffel Tower was completed in 1889.", models: ["chatgpt", "claude", "grok"] }),
      }),
      { params: { workspaceId: WS_ID } } as never
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.modelIndependence).toBe(c.independence);

    const created = store.writes.filter((w) => w.collection === "verifications" && w.op === "create");
    expect(created).toHaveLength(1);
    const { id, doc } = created[0];
    expect(id).toBe(body.verificationId);
    const rows = doc.modelResults as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.provider)).toEqual(c.providers);
    for (const r of rows) if (r.status !== "ok") expect("provider" in r).toBe(false);
    expect(doc.workspaceId).toBe(WS_ID);

    const detailRes = await GET_DETAIL(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/verifications/${id}`), { params: { workspaceId: WS_ID, verificationId: id } });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    const payload = detail.payload ?? detail.verification ?? detail;
    expect(payload.modelIndependence).toBe(c.independence);
    const score = doc.consensusScore as number;

    const view = html(createElement(ClaimVerificationResultView, { data: payload }));
    if (c.independence === "independent") {
      expect(view).toContain(`>${score}</p>`);
      if (doc.verdict === "confirmed") expect(view).toContain(`This claim is supported by ${c.k}/${c.k} models`);
    } else expect(view).toContain(c.independence === "insufficient" ? NO_CONSENSUS : WITHHELD);

    const summary = toTeamClaimVerificationSummary({ verificationId: id, data: doc, workspaceId: WS_ID, projectId: null, project: null });
    const parsed = parseTeamClaimListPageResponse({ ok: true, status: 200, body: { ok: true, scope: "all", items: [summary], hasMore: false }, address: { kind: "workspace", workspaceId: WS_ID, scope: "all" } });
    if (!parsed.ok) throw new Error(parsed.errorCode);
    const row = html(createElement("ul", null, createElement(TeamClaimListRow, { workspaceId: WS_ID, item: parsed.page.items[0], showProject: false })));
    expect(row).toContain(c.independence === "independent" ? `${score}/100 consensus` : c.independence === "insufficient" ? NO_CONSENSUS : WITHHELD);

    mockedGenerateMemo.mockClear();
    let tr!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tr = TestRenderer.create(createElement(ClaimVerificationResult, { data: payload, onVerifyAnother: () => {} }));
    });
    await act(async () => tr.root.findByType(VerificationActions).props.onExportMemo());
    tr.unmount();
    const input = mockedGenerateMemo.mock.calls[0][0] as Record<string, unknown>;
    const memo: string = realMemo(input);
    if (c.independence === "independent") expect(memo).toContain(`CONSENSUS SCORE: ${score}/100`);
    else expect(memo).not.toContain(`CONSENSUS SCORE: ${score}/100`);
  });
});
