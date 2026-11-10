/**
 * Fresh review of 0d4f6c9, MINOR-1 — legacy Team review rows (`teamRuns`, GET /api/teams/runs?version=1 →
 * LegacyReviewListItem). A research row stores `runId`; the route reads the linked `runs/{runId}` and shows the stored
 * consensus score only when its persisted per-model rows prove ≥ 2 independent executing models. Otherwise the score is
 * withheld with its reason. Claim-verification rows (`verificationId`, no `runId`) get the same rule from the linked
 * `verifications/{verificationId}` per-model rows (review of 8584211, MAJOR): never exempt.
 */
const teamRunDocs = new Map<string, Record<string, any>>();
// Path-keyed store for the enrichment reads this route now performs:
// "runs/{runId}" (governanceRecord), "runs/{runId}/humanReviewAssignment/current",
// "runs/{runId}/humanReviewPanel/current", "runs/{runId}/humanReviewVotes/{voteId}".
const pathStore = new Map<string, Record<string, any>>();
let getAllShouldThrow = false;
// Phase 1 Cross-Authority READ Guard — the route now issues an EXTRA batched
// read before enrichment, to classify each row's canonical Workspace binding.
// That read and the enrichment reads fail in opposite directions on purpose: a
// binding-read failure must EXCLUDE the row (authority unprovable), while an
// enrichment-read failure must KEEP it and merely degrade detail. This counter
// lets a test fail only the enrichment pass, so both contracts stay testable.
let getAllCallCount = 0;
let getAllSucceedForFirstCalls = 0;

function makeDocRef(path: string): any {
  return {
    __path: path,
    path,
    id: path.split("/").pop(),
    get: async () => ({ exists: pathStore.has(path), data: () => pathStore.get(path) }),
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeCollectionRef(path: string): any {
  return {
    doc: (id: string) => makeDocRef(`${path}/${id}`),
  };
}

const mockAdminDb = {
  collection: (name: string) => {
    if (name === "teamRuns") {
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => {
            const matches = [...teamRunDocs.entries()].filter(([, data]) => data[field] === value);
            return { docs: matches.map(([id, data]) => ({ id, data: () => data })) };
          },
        }),
      };
    }
    return makeCollectionRef(name);
  },
  getAll: async (...refs: Array<{ __path: string }>) => {
    getAllCallCount += 1;
    if (getAllShouldThrow && getAllCallCount > getAllSucceedForFirstCalls) throw new Error("batch read boom");
    // A real DocumentSnapshot always carries `id`; the read guard associates
    // results by identity rather than array position, so the fake must too.
    return refs.map((ref) => ({ id: ref.__path.split("/").pop(), ref: { path: ref.__path }, exists: pathStore.has(ref.__path), data: () => pathStore.get(ref.__path) }));
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
}));

// Identity resolution is already covered end-to-end by
// lib/governance/__tests__/reviewerIdentity.spec.ts (including its own
// db.getAll() batching) — mocked here so this file can assert precisely
// on WHICH uids the route collects and batches, independent of the
// resolver's own internal correctness.
const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: any[]) => mockedResolveReviewerDisplayNames(...args),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
}));

const mockedGetRequestUid = jest.fn();
const mockedLoadUserAndTeam = jest.fn();
const mockedMemberRole = jest.fn();
const mockedIsTeamAdmin = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: (...args: any[]) => mockedGetRequestUid(...args),
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
  memberRole: (...args: any[]) => mockedMemberRole(...args),
  isTeamAdmin: (...args: any[]) => mockedIsTeamAdmin(...args),
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/teams/runs/route";

const TEAM_ID = "team-1";

function fakeTimestamp(iso: string) {
  return { toMillis: () => new Date(iso).getTime() };
}

/**
 * Phase 1 Cross-Authority READ Guard — an adaptive projection only ever exists
 * for a run that was already persisted, so building one here also seeds its
 * canonical `runs/{runId}` document, bound legacy (no `workspaceId`). Without a
 * canonical run the guard correctly refuses to prove the row's authority and
 * hides it; that fail-closed behaviour, and every Workspace-bound case, is
 * covered in `crossAuthorityReadGuard.spec.ts`. These tests are about the list
 * CONTRACT, so they get an ordinary legacy run.
 */
function adaptiveDoc(overrides: Record<string, unknown> = {}) {
  const runId = typeof overrides.runId === "string" ? overrides.runId : "run-1";
  if (!pathStore.has(`runs/${runId}`)) pathStore.set(`runs/${runId}`, { userId: "owner-uid" });
  return {
    teamId: TEAM_ID,
    userId: "owner-uid",
    projectionVersion: 1,
    adaptive: true,
    runId: "run-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "The panel recommends option A.",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Phase 1 Cross-Authority READ Guard — a classic `teamRuns` row always names
 * exactly one canonical artifact (`teamGovernancePipeline.ts` writes both
 * `runId` and `verificationId`, one of them null), so a row naming NEITHER is
 * not a product shape and is no longer readable. These contract tests give the
 * row a run linkage and seed its canonical run, bound legacy; the Workspace-bound
 * and unlinked cases live in `crossAuthorityReadGuard.spec.ts`.
 */
let legacyRunSeq = 0;
function legacyDoc(overrides: Record<string, unknown> = {}) {
  const runId = typeof overrides.runId === "string" ? overrides.runId : `legacy-run-${++legacyRunSeq}`;
  if (!pathStore.has(`runs/${runId}`)) pathStore.set(`runs/${runId}`, { userId: "owner-uid" });
  return {
    runId,
    teamId: TEAM_ID,
    userId: "owner-uid",
    userEmail: "owner@test.com",
    type: "research",
    query: "What is the best CRM for a 20-person sales team?",
    consensusScore: 40,
    policyFlags: ["weak_evidence"],
    timestamp: fakeTimestamp("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

function buildRequest(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/teams/runs?version=1${qs}`);
}

beforeEach(() => {
  teamRunDocs.clear();
  pathStore.clear();
  getAllShouldThrow = false;
  legacyRunSeq = 0;
  getAllCallCount = 0;
  getAllSucceedForFirstCalls = 0;
  mockLoggerWarn.mockClear();
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedResolveReviewerDisplayNames.mockReset();

  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "caller@test.com" }, team: { id: TEAM_ID, members: [] } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((uid) => [uid, `Name-${uid}`])));
});

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import LegacyReviewListItem from "@/components/teamGovernance/LegacyReviewListItem";
import { CONSENSUS_WITHHELD_TEXT } from "@/lib/panel/independentVoices";

const pm = (modelId: string, status: string, provider?: string) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...(provider ? { provider } : {}) });
function seedRun(runId: string, perModel: unknown[] | undefined) {
  pathStore.set(`runs/${runId}`, { userId: "owner-uid", ...(perModel ? { runDocument: { perModel } } : {}) });
}
async function legacyItems(): Promise<Record<string, any>> {
  const body = await (await GET(buildRequest(""))).json();
  return Object.fromEntries(body.items.filter((i: any) => i.kind === "legacy").map((i: any) => [i.teamRunId, i]));
}
const html = (item: unknown) => renderToStaticMarkup(createElement(LegacyReviewListItem, { item } as never)).replace(/<!-- -->/g, "");

// Phase 0 (L16, O15 = yes; owner Option C): the Team review queue is governance-queue metadata, so the DTO keeps the
// STORED consensusScore (35933c8); `consensusWithheld` is additive and LegacyReviewListItem presents the reason instead
// of the number (legacyConsensusText). Every "withheld" case below asserts the stored score AND the additive reason.
describe("GET /api/teams/runs?version=1 — legacy consensus score vs the linked run's independent executing models", () => {
  it("two DeepSeek substitutions / one independent model → withheld (insufficient); two independent → shown plainly", async () => {
    seedRun("r-ds2", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek")]);
    seedRun("r-one", [pm("chatgpt", "ok"), pm("claude", "failed")]);
    seedRun("r-two", [pm("chatgpt", "ok"), pm("grok", "ok")]);
    seedRun("r-mixed", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek"), pm("grok", "ok")]);
    for (const [id, runId] of [["ds2", "r-ds2"], ["one", "r-one"], ["two", "r-two"], ["mixed", "r-mixed"]]) teamRunDocs.set(id, legacyDoc({ runId, consensusScore: 72 }));
    const by = await legacyItems();
    for (const id of ["ds2", "one"]) {
      expect([id, by[id].consensusScore, by[id].consensusWithheld]).toEqual([id, 72, "insufficient_independent_models"]);
      expect(html(by[id])).toContain(CONSENSUS_WITHHELD_TEXT.insufficient_independent_models);
      expect(html(by[id])).not.toMatch(/Consensus \d+\/100/);
    }
    for (const id of ["two", "mixed"]) {
      expect([id, by[id].consensusScore, "consensusWithheld" in by[id]]).toEqual([id, 72, false]);
      expect(html(by[id])).toContain("<span>Consensus 72/100</span>");
      expect(html(by[id])).not.toContain("independence");
    }
  });

  it("missing provenance (run without persisted rows) → withheld as unverified", async () => {
    seedRun("r-old", undefined);
    teamRunDocs.set("old", legacyDoc({ runId: "r-old", consensusScore: 64 }));
    const by = await legacyItems();
    expect([by.old.consensusScore, by.old.consensusWithheld]).toEqual([64, "independence_unverified"]);
    expect(html(by.old)).toContain(CONSENSUS_WITHHELD_TEXT.independence_unverified);
  });

  it("run read failure during enrichment → withheld as unverified (never shown unproven)", async () => {
    seedRun("r-two", [pm("chatgpt", "ok"), pm("grok", "ok")]);
    teamRunDocs.set("two", legacyDoc({ runId: "r-two", consensusScore: 72 }));
    getAllShouldThrow = true;
    getAllSucceedForFirstCalls = 1; // the read-domain guard succeeds; enrichment reads fail
    const by = await legacyItems();
    expect([by.two.consensusScore, by.two.consensusWithheld]).toEqual([72, "independence_unverified"]);
  });

  // Review of 8584211, MAJOR — claim-verification rows are judged from `verifications/{verificationId}`.
  const vrow = (modelId: string, status: "ok" | "parse_error" | "failed", extra: Record<string, unknown> = {}) => ({
    modelId,
    status,
    verdict: status === "ok" ? "accurate" : status,
    confidence: "high",
    summary: `${modelId} summary`,
    correctParts: [],
    incorrectParts: [],
    unverifiableParts: [],
    ...extra,
  });
  function seedVerification(id: string, modelResults: unknown[] | undefined, selectedModels?: string[]) {
    pathStore.set(`verifications/${id}`, {
      userId: "owner-uid",
      claim: "c",
      consensusScore: 92,
      ...(modelResults ? { modelResults } : {}),
      ...(selectedModels ? { selectedModels } : {}),
    });
  }
  const claimDoc = (verificationId: string) => legacyDoc({ type: "verification", runId: null, verificationId, consensusScore: 92 });

  it("claim row: three requested models, one answered → no consensus score (insufficient), never 'Consensus 92/100'", async () => {
    // C-b (CB-01): the answering row records its provider (the shared gate verifies it).
    seedVerification("v-one", [vrow("chatgpt", "ok", { provider: "openai" }), vrow("claude", "failed"), vrow("grok", "parse_error")], ["chatgpt", "claude", "grok"]);
    teamRunDocs.set("claim-one", claimDoc("v-one"));
    const by = await legacyItems();
    expect([by["claim-one"].consensusScore, by["claim-one"].consensusWithheld]).toEqual([92, "insufficient_independent_models"]);
    expect(html(by["claim-one"])).toContain(CONSENSUS_WITHHELD_TEXT.insufficient_independent_models);
    expect(html(by["claim-one"])).not.toMatch(/Consensus \d+\/100/);
  });

  it("claim row: slots answered by one substitute provider (DeepSeek) are one model → insufficient", async () => {
    seedVerification(
      "v-ds",
      [vrow("chatgpt", "ok", { substituted: true, provider: "deepseek" }), vrow("claude", "ok", { substituted: true, provider: "deepseek" }), vrow("grok", "failed")],
      ["chatgpt", "claude", "grok"]
    );
    teamRunDocs.set("claim-ds", claimDoc("v-ds"));
    const by = await legacyItems();
    expect([by["claim-ds"].consensusScore, by["claim-ds"].consensusWithheld]).toEqual([92, "insufficient_independent_models"]);
  });

  it("claim row: two independent executing models answered → score shown plainly", async () => {
    seedVerification("v-two", [vrow("chatgpt", "ok", { provider: "openai" }), vrow("claude", "ok", { provider: "anthropic" }), vrow("grok", "failed")], ["chatgpt", "claude", "grok"]);
    teamRunDocs.set("claim-two", claimDoc("v-two"));
    const by = await legacyItems();
    expect([by["claim-two"].consensusScore, "consensusWithheld" in by["claim-two"]]).toEqual([92, false]);
    expect(html(by["claim-two"])).toContain("<span>Consensus 92/100</span>");
  });

  it("claim row: missing / incomplete executing attribution → unverified (never presumed independent)", async () => {
    seedVerification("v-none", undefined);
    seedVerification("v-partial", [vrow("chatgpt", "ok"), vrow("claude", "ok")], ["chatgpt", "claude", "grok"]);
    seedVerification("v-unknown", [vrow("chatgpt", "ok"), vrow("mystery-model", "ok")]);
    seedVerification("v-nostatus", [vrow("chatgpt", "ok"), { ...vrow("claude", "ok"), status: undefined }]);
    // C-b (CB-01): own-provider rows without a recorded provider (every stored own-provider claim row) are unverified.
    seedVerification("v-providerless", [vrow("chatgpt", "ok"), vrow("claude", "ok"), vrow("grok", "failed")], ["chatgpt", "claude", "grok"]);
    const ids = ["v-none", "v-partial", "v-unknown", "v-nostatus", "v-providerless"];
    for (const id of ids) teamRunDocs.set(id, claimDoc(id));
    const by = await legacyItems();
    for (const id of ids) {
      expect([id, by[id].consensusScore, by[id].consensusWithheld]).toEqual([id, 92, "independence_unverified"]);
      expect(html(by[id])).toContain(CONSENSUS_WITHHELD_TEXT.independence_unverified);
    }
  });

  it("claim row: verification document absent, or its read fails → unverified", async () => {
    teamRunDocs.set("claim-missing", claimDoc("v-missing"));
    let by = await legacyItems();
    // The read-domain guard hides a row whose canonical verification is absent (never listed, so never scored).
    expect(by["claim-missing"]).toBeUndefined();
    seedVerification("v-two", [vrow("chatgpt", "ok"), vrow("claude", "ok")], ["chatgpt", "claude"]);
    teamRunDocs.clear();
    teamRunDocs.set("claim-two", claimDoc("v-two"));
    getAllShouldThrow = true;
    getAllSucceedForFirstCalls = 1; // the read-domain guard succeeds; enrichment reads fail
    getAllCallCount = 0;
    by = await legacyItems();
    expect([by["claim-two"].consensusScore, by["claim-two"].consensusWithheld]).toEqual([92, "independence_unverified"]);
  });

  it("claim rows are read in one batched verifications read (no per-row reads)", async () => {
    for (const n of [1, 2, 3]) {
      seedVerification(`v-b${n}`, [vrow("chatgpt", "ok"), vrow("claude", "ok")], ["chatgpt", "claude"]);
      teamRunDocs.set(`b${n}`, claimDoc(`v-b${n}`));
    }
    const spy = jest.spyOn(mockAdminDb, "getAll");
    await legacyItems();
    const verificationCalls = spy.mock.calls.filter((args: any[]) => args.some((r: any) => String(r.__path).startsWith("verifications/") ));
    // One read-domain call (guard) + one enrichment call — each carrying all three refs.
    for (const call of verificationCalls) expect(call.filter((r: any) => String(r.__path).startsWith("verifications/"))).toHaveLength(3);
    expect(verificationCalls.length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });

  it("no stored score: nothing withheld, no run read needed", async () => {
    seedRun("r-ds2", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek")]);
    teamRunDocs.set("none", legacyDoc({ runId: "r-ds2", consensusScore: null }));
    const by = await legacyItems();
    expect([by.none.consensusScore, "consensusWithheld" in by.none]).toEqual([null, false]);
    expect(html(by.none)).toContain("No consensus score");
  });
});

describe("applyLegacyConsensusIndependence (pure)", () => {
  const { applyLegacyConsensusIndependence } = jest.requireActual("@/lib/governance/teamReviewQueueEnrichment");
  const base = { kind: "legacy", teamRunId: "t", createdAt: "x", policyFlags: [], blockedByPolicy: false, governanceReviewRequired: false, consensusScore: 70 };
  it("research row: shown only when independent; null independence (unreadable run) → unverified", () => {
    expect(applyLegacyConsensusIndependence({ ...base, runId: "r" }, "independent")).toEqual({ ...base, runId: "r" });
    expect(applyLegacyConsensusIndependence({ ...base, runId: "r" }, "insufficient")).toEqual({ ...base, runId: "r", consensusWithheld: "insufficient_independent_models" });
    expect(applyLegacyConsensusIndependence({ ...base, runId: "r" }, null)).toEqual({ ...base, runId: "r", consensusWithheld: "independence_unverified" });
  });
  it("a row naming neither a run nor a verification → unverified; a claim row is judged like a research row", () => {
    expect(applyLegacyConsensusIndependence({ ...base }, "independent")).toEqual({ ...base, consensusWithheld: "independence_unverified" });
    expect(applyLegacyConsensusIndependence({ ...base, verificationId: "v" }, null)).toEqual({ ...base, verificationId: "v", consensusWithheld: "independence_unverified" });
    expect(applyLegacyConsensusIndependence({ ...base, verificationId: "v" }, "insufficient")).toEqual({ ...base, verificationId: "v", consensusWithheld: "insufficient_independent_models" });
    expect(applyLegacyConsensusIndependence({ ...base, verificationId: "v" }, "independent")).toEqual({ ...base, verificationId: "v" });
  });
});
