/**
 * Track C-c (Order 34) — list / queue / history surfaces judged by the ONE shared presentation gate, end to end on the
 * real code: the governance-queue GET + the real FragmentRow, the panel-history GET, the run summariser and its status
 * line, the Team review list item. Presentation only — stored records, scoring, the verification gate and the live
 * decision primitives (EXCL-01/02/03) are untouched.
 *
 * Adversarial stored runs: provider-less (pre-6.2a) ok rows, registry-rejected provider tokens, a substitute in two
 * slots, all slots timed out, one answer with stored count 5, a stored placeholder beside one answer, genuine 2+3 and
 * 5/5, and providerless video rows (PQ-2 (a) strict).
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));
jest.mock("@/lib/governance/authCheck", () => ({ resolveGovernanceRequestUser: jest.fn().mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" }) }));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: jest.fn().mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" }),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: jest.fn().mockResolvedValue({ status: "authenticated", uid: "owner-a" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrityBatch", () => ({ createRunWorkspaceIntegrityBatch: () => async () => ({ classification: "legacy" }) }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const docs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = { runs: [], verifications: [], videoVerifications: [] };
jest.mock("@/lib/firebase/admin", () => {
  const chain = (name: string): any => {
    const c: any = {};
    for (const m of ["where", "orderBy", "limit", "select", "offset", "startAfter"]) c[m] = () => c;
    c.get = async () => ({ docs: (docs[name] ?? []).map((r) => ({ id: r.id, data: () => r.data })) });
    c.doc = () => ({ get: async () => ({ exists: false }) });
    return c;
  };
  return { adminDb: { collection: (n: string) => chain(n), getAll: async (...refs: unknown[]) => refs.map(() => ({ exists: false, data: () => undefined })) } };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET as GET_QUEUE } from "@/app/api/governance/queue/route";
import { GET as GET_HISTORY } from "@/app/api/user/panel-history/route";
import { FragmentRow, queueResearchDisagreementLines } from "@/components/governance/GovernanceDashboard";
import { toRunSummaryBase } from "@/lib/runs/runSummary";
import { workspaceRunStatusLine } from "@/components/workspace/WorkspaceRunCard";
import LegacyReviewListItem from "@/components/teamGovernance/LegacyReviewListItem";
import { CONSENSUS_WITHHELD_TEXT, storedRunConsensusIndependence } from "@/lib/panel/independentVoices";
import { storedRunIndependenceContext } from "@/lib/panel/storedDisagreementIndependence";
import { crossModelDisagreements } from "@/lib/verificationGate/panelVerdict";
import { STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";

const WITHHELD = CONSENSUS_WITHHELD_TEXT.independence_unverified;
const NO_CONSENSUS = CONSENSUS_WITHHELD_TEXT.insufficient_independent_models;
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", gemini: "google", perplexity: "perplexity" };
type Row = Record<string, unknown>;
const ok = (m: string, provider: string | null = OWN[m]): Row => ({ modelId: m, status: "ok", rawTextTruncated: `${m} answer`, ...(provider !== null ? { provider } : {}) });
const ds = (m: string, provider: string | null = "deepseek"): Row => ({ modelId: m, status: "substituted", rawTextTruncated: `${m} via substitute`, ...(provider !== null ? { provider } : {}) });
const to = (m: string): Row => ({ modelId: m, status: "timeout", rawTextTruncated: "" });
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

const FIVE = ["chatgpt", "claude", "grok", "gemini", "perplexity"];
const DIS = [
  { topic: "Founding date", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "ChatGPT says 1789, Claude says 1792" },
  { topic: "Founder", positionsByModel: { chatgpt: "A", grok: "B" }, whyTheyDiffer: "Different sources" },
];

type Fixture = { name: string; rows: Row[] | undefined; independence: "independent" | "insufficient" | "unverified" };
const FIXTURES: Fixture[] = [
  { name: "genuine 5/5", rows: FIVE.map((m) => ok(m)), independence: "independent" },
  { name: "genuine 2+3 (DeepSeek in three slots, two own providers)", rows: [ok("chatgpt"), ok("grok"), ds("claude"), ds("gemini"), ds("perplexity")], independence: "independent" },
  { name: "provider-less (pre-6.2a) ok rows", rows: [ok("chatgpt", null), ok("claude", null), ok("grok", null)], independence: "unverified" },
  { name: "registry-rejected provider tokens", rows: [ok("chatgpt", "None"), ok("claude", "n/a"), ok("grok", "grok")], independence: "unverified" },
  { name: "a substitute in two slots (recorded)", rows: [ds("chatgpt"), ds("claude")], independence: "insufficient" },
  { name: "a substitute in two slots (unrecorded)", rows: [ds("chatgpt", null), ds("claude", null), ok("grok")], independence: "unverified" },
  { name: "all slots timed out", rows: ["chatgpt", "claude", "grok"].map(to), independence: "unverified" },
  { name: "one answer with stored count 5", rows: [ok("chatgpt"), ...["claude", "grok", "gemini", "perplexity"].map(to)], independence: "insufficient" },
  {
    name: "a stored placeholder beside one answer",
    rows: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: STORED_PLACEHOLDER_LITERALS.chatgpt }, ok("grok")],
    independence: "insufficient",
  },
  { name: "no persisted rows", rows: undefined, independence: "unverified" },
];

const runDoc = (id: string, rows: Row[] | undefined): { id: string; data: Record<string, unknown> } => ({
  id,
  data: {
    userId: "owner-a",
    question: id,
    selectedModels: FIVE,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    createdAt: { toMillis: () => Date.now() - 1_000 },
    synthesisConsensusSummary: { overallConsensusScore: 87, lowEvidenceClaims: 0, aggregateSupportRatio: 1 },
    policyConsensusSummary: { evidenceQuality: "strong" },
    synthesizedStructuredReport: { keyFindings: [{ claim: "Founded in the 1790s." }], disagreements: DIS },
    ...(rows ? { runDocument: { perModel: rows } } : {}),
  },
});

function renderRow(row: Record<string, unknown>) {
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
  docs.runs = [];
  docs.verifications = [];
  docs.videoVerifications = [];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("CC-01: storedRunConsensusIndependence is the shared gate", () => {
  it.each(FIXTURES)("$name → $independence", ({ rows, independence }) => {
    const d = runDoc("r", rows).data;
    const before = JSON.stringify(d);
    expect(storedRunConsensusIndependence(d)).toBe(independence);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("resultsCompact rows are judged the same way; runDocument wins", () => {
    expect(storedRunConsensusIndependence({ resultsCompact: { perModel: [ok("chatgpt"), ok("grok")] } })).toBe("independent");
    expect(storedRunConsensusIndependence({ resultsCompact: { perModel: [ok("chatgpt", null), ok("grok", null)] } })).toBe("unverified");
    expect(storedRunConsensusIndependence({ runDocument: { perModel: [ds("chatgpt"), ds("claude")] }, resultsCompact: { perModel: [ok("chatgpt"), ok("grok")] } })).toBe("insufficient");
  });
});

describe("CC-02 / CC-03 (LISTS): run summary and status line", () => {
  it.each(FIXTURES)("$name", ({ rows, independence }) => {
    const s = toRunSummaryBase("r", runDoc("r", rows).data);
    if (independence === "independent") {
      expect([s.synthesisConsensusScore, "synthesisConsensusWithheld" in s]).toEqual([87, false]);
      expect(workspaceRunStatusLine(s)).toContain("Synthesis 87/100");
    } else {
      expect(s.synthesisConsensusScore).toBeUndefined();
      expect(s.synthesisConsensusWithheld).toBe(independence === "insufficient" ? "insufficient_independent_models" : "independence_unverified");
      expect(workspaceRunStatusLine(s)).not.toMatch(/Synthesis \d+\/100/);
    }
  });
});

describe("CC-05 / CC-07 (HIST): the real panel-history GET", () => {
  it("research rows by the gate; video rows withheld (PQ-2 strict); stored docs unchanged", async () => {
    docs.runs = FIXTURES.map((f, i) => runDoc(`run-${i}`, f.rows));
    docs.videoVerifications = [
      { id: "vid-3", data: { userId: "owner-a", type: "video_verification", fileName: "a.mp4", verdict: "authentic_captured", consensusScore: 100, timestamp: { toMillis: () => 2_000 }, metadata: { duration: 3 }, modelResults: [{ modelId: "chatgpt", status: "ok" }, { modelId: "claude", status: "ok" }, { modelId: "gemini", status: "ok" }] } },
      { id: "vid-none", data: { userId: "owner-a", type: "video_verification", fileName: "b.mp4", verdict: "inconclusive", consensusScore: 40, timestamp: { toMillis: () => 3_000 } } },
    ];
    const before = JSON.stringify(docs);
    const body = await (await GET_HISTORY(new NextRequest("http://localhost/api/user/panel-history?limit=50"))).json();
    const by = Object.fromEntries(body.items.map((i: { id: string }) => [i.id, i]));
    FIXTURES.forEach((f, i) => {
      const it = by[`run-${i}`];
      if (f.independence === "independent") expect([f.name, it.synthesisConsensusScore, "synthesisConsensusWithheld" in it]).toEqual([f.name, 87, false]);
      else expect([f.name, it.synthesisConsensusScore, it.synthesisConsensusWithheld]).toEqual([f.name, undefined, f.independence === "insufficient" ? "insufficient_independent_models" : "independence_unverified"]);
    });
    for (const id of ["vid-3", "vid-none"]) {
      expect([id, "consensusScore" in by[id], by[id].consensusWithheld]).toEqual([id, false, "independence_unverified"]);
    }
    expect(JSON.stringify(docs)).toBe(before);
  });
});

describe("CC-10 / CC-14 / CC-15 (QUEUE): the real queue GET and the real FragmentRow", () => {
  it.each(FIXTURES)("$name", async ({ rows, independence }) => {
    docs.runs = [runDoc("q", rows)];
    const q = (await (await GET_QUEUE(new NextRequest("http://localhost/api/governance/queue"))).json()).runs.find((r: { runId: string }) => r.runId === "q");
    expect(q.consensusScore).toBe(87); // the stored score stays in the DTO (35933c8 base key)
    const out = renderRow(q);
    if (independence === "independent") {
      expect(["consensusWithheld" in q, "modelIndependence" in q]).toEqual([false, false]);
      expect(out).toContain(">87</td>");
      expect(out).toContain("Founder: Different sources");
    } else {
      expect(q.modelIndependence).toBe(independence);
      expect(q.consensusWithheld).toBe(independence === "insufficient" ? "insufficient_independent_models" : "independence_unverified");
      expect(out).not.toContain(">87</td>");
      expect(out).toContain(independence === "insufficient" ? NO_CONSENSUS : WITHHELD);
      expect(queueResearchDisagreementLines(q.disagreements, q)).toEqual([]);
    }
  });

  it("fail closed on independence alone: an unverified / insufficient row shows no stored line even without its qualified list", async () => {
    docs.runs = [runDoc("uv", [ok("chatgpt", null), ok("grok", null)]), runDoc("one", [ok("chatgpt"), to("grok")])];
    const all = (await (await GET_QUEUE(new NextRequest("http://localhost/api/governance/queue"))).json()).runs;
    for (const id of ["uv", "one"]) {
      const q = { ...all.find((r: { runId: string }) => r.runId === id) };
      delete q.qualifiedDisagreements;
      expect(q.disagreements.length).toBeGreaterThan(0);
      expect([id, queueResearchDisagreementLines(q.disagreements, q), queueResearchDisagreementLines(q.disagreementPoints, q)]).toEqual([id, [], []]);
    }
  });

  it("genuine 2+3: the DeepSeek-vs-DeepSeek line is qualified, the genuine one stays (one rule with the live panel)", async () => {
    const rows = [ds("chatgpt"), ds("claude"), ok("grok"), ok("gemini")];
    docs.runs = [runDoc("mix", rows)];
    const q = (await (await GET_QUEUE(new NextRequest("http://localhost/api/governance/queue"))).json()).runs[0];
    expect(queueResearchDisagreementLines(q.disagreements, q)).toEqual(["Founder: Different sources"]);
    const live = crossModelDisagreements(DIS as never, rows.map((r) => ({ modelId: r.modelId, status: r.status, provider: r.provider, rawText: r.rawTextTruncated })) as never, true);
    expect(live.map((d) => (d as { topic?: string }).topic)).toEqual(["Founder"]);
    expect(storedRunIndependenceContext(runDoc("mix", rows).data).collapsed).toBe(true);
  });

  it("CC-12 (PQ-2 strict): a video row with three ok model rows is unverified; the stored score stays in the DTO", async () => {
    docs.videoVerifications = [
      { id: "v", data: { userId: "owner-a", type: "video_verification", fileName: "a.mp4", verdict: "authentic", consensusScore: 100, evidenceQuality: "strong", governanceStatus: "needs_review", governanceReasons: ["r"], timestamp: { toMillis: () => Date.now() }, modelResults: ["chatgpt", "claude", "gemini"].map((m) => ({ modelId: m, status: "ok", verdict: "authentic", confidence: "high" })) } },
    ];
    const q = (await (await GET_QUEUE(new NextRequest("http://localhost/api/governance/queue"))).json()).runs.find((r: { runId: string }) => r.runId === "v");
    expect([q.consensusScore, q.consensusWithheld, q.modelIndependence]).toEqual([100, "independence_unverified", "unverified"]);
    const out = renderRow(q);
    expect(out).toContain(WITHHELD);
    expect(out).not.toContain(">100</td>");
    expect(out).not.toMatch(/\d+\/\d+ models (say|rate)/);
  });
});

describe("CC-18 (TEAMQ render): the legacy Team review item shows the reason, never the number", () => {
  it.each(["insufficient_independent_models", "independence_unverified"] as const)("%s", (reason) => {
    const item = { kind: "legacy", teamRunId: "t", createdAt: "2026-11-01T00:00:00.000Z", querySummary: "q", policyFlags: [], blockedByPolicy: false, governanceReviewRequired: false, runId: "r", consensusScore: 87, consensusWithheld: reason };
    const out = html(createElement(LegacyReviewListItem, { item } as never));
    expect(out).toContain(CONSENSUS_WITHHELD_TEXT[reason]);
    expect(out).not.toMatch(/Consensus \d+\/100/);
  });
});
