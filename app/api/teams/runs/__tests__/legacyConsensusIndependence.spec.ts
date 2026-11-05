/**
 * Fresh review of 0d4f6c9, MINOR-1 — legacy Team review rows (`teamRuns`, GET /api/teams/runs?version=1 →
 * LegacyReviewListItem). A research row stores `runId`; the route reads the linked `runs/{runId}` and shows the stored
 * consensus score only when its persisted per-model rows prove ≥ 2 independent executing models. Otherwise the score is
 * withheld with its reason. Claim-verification rows keep their score with no research-independence wording.
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

describe("GET /api/teams/runs?version=1 — legacy consensus score vs the linked run's independent executing models", () => {
  it("two DeepSeek substitutions / one independent model → withheld (insufficient); two independent → shown plainly", async () => {
    seedRun("r-ds2", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek")]);
    seedRun("r-one", [pm("chatgpt", "ok"), pm("claude", "failed")]);
    seedRun("r-two", [pm("chatgpt", "ok"), pm("grok", "ok")]);
    seedRun("r-mixed", [pm("chatgpt", "substituted", "deepseek"), pm("claude", "substituted", "deepseek"), pm("grok", "ok")]);
    for (const [id, runId] of [["ds2", "r-ds2"], ["one", "r-one"], ["two", "r-two"], ["mixed", "r-mixed"]]) teamRunDocs.set(id, legacyDoc({ runId, consensusScore: 72 }));
    const by = await legacyItems();
    for (const id of ["ds2", "one"]) {
      expect([id, by[id].consensusScore, by[id].consensusWithheld]).toEqual([id, null, "insufficient_independent_models"]);
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
    expect([by.old.consensusScore, by.old.consensusWithheld]).toEqual([null, "independence_unverified"]);
    expect(html(by.old)).toContain(CONSENSUS_WITHHELD_TEXT.independence_unverified);
  });

  it("run read failure during enrichment → withheld as unverified (never shown unproven)", async () => {
    seedRun("r-two", [pm("chatgpt", "ok"), pm("grok", "ok")]);
    teamRunDocs.set("two", legacyDoc({ runId: "r-two", consensusScore: 72 }));
    getAllShouldThrow = true;
    getAllSucceedForFirstCalls = 1; // the read-domain guard succeeds; enrichment reads fail
    const by = await legacyItems();
    expect([by.two.consensusScore, by.two.consensusWithheld]).toEqual([null, "independence_unverified"]);
  });

  it("claim-verification row keeps its score with no research-independence wording", async () => {
    pathStore.set("verifications/ver-1", { claimText: "c" });
    teamRunDocs.set("claim", legacyDoc({ type: "verification", runId: null, verificationId: "ver-1", consensusScore: 81 }));
    const by = await legacyItems();
    expect([by.claim.consensusScore, "consensusWithheld" in by.claim]).toEqual([81, false]);
    expect(html(by.claim)).toContain("<span>Consensus 81/100</span>");
    expect(html(by.claim)).not.toContain("independen");
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
    expect(applyLegacyConsensusIndependence({ ...base, runId: "r" }, "insufficient")).toEqual({ ...base, runId: "r", consensusScore: null, consensusWithheld: "insufficient_independent_models" });
    expect(applyLegacyConsensusIndependence({ ...base, runId: "r" }, null)).toEqual({ ...base, runId: "r", consensusScore: null, consensusWithheld: "independence_unverified" });
  });
  it("a row naming neither a run nor a verification → unverified; a claim row → unchanged", () => {
    expect(applyLegacyConsensusIndependence({ ...base }, "independent")).toEqual({ ...base, consensusScore: null, consensusWithheld: "independence_unverified" });
    expect(applyLegacyConsensusIndependence({ ...base, verificationId: "v" }, null)).toEqual({ ...base, verificationId: "v" });
  });
});
