/**
 * Evidence Workspace, Phase 11A.5C — resolveTeamSourceResearchLink()
 * tests. Mocks `resolveTeamRunWorkspaceAccess()` (the exact authoritative
 * Team access resolver the route itself uses) directly, and
 * `adminDb.collection("runs")` only — this helper never reads any other
 * collection, and never writes anything at all.
 */

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

type StoredDoc = Record<string, unknown>;
const runsStore = new Map<string, StoredDoc>();

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") {
      throw new Error(`resolveTeamSourceResearchLink must never read collection "${name}"`);
    }
    return {
      doc: (docId: string) => ({
        get: async () => {
          const data = runsStore.get(docId);
          return { exists: data !== undefined, data: () => data, id: docId };
        },
        set: () => {
          throw new Error("resolveTeamSourceResearchLink must never write");
        },
        update: () => {
          throw new Error("resolveTeamSourceResearchLink must never write");
        },
        delete: () => {
          throw new Error("resolveTeamSourceResearchLink must never write");
        },
      }),
    };
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { resolveTeamSourceResearchLink } from "@/lib/verification/resolveTeamSourceResearchLink";
import { buildDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";

const CALLER_UID = "member-1";
const WS_A = "ws-team-a";
const WS_B = "ws-team-b";
const RUN_ID = "run-1";

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "finding-1",
    title: "A label",
    summary: "A stable finding summary.",
    category: "general",
    evidenceStrength: "moderate",
    sourceBacked: true,
    coverageCount: 3,
    totalModels: 4,
    coverageRatio: 0.75,
    contributingModels: ["claude", "chatgpt", "gemini"],
    ...overrides,
  };
}

function deepResearchOutput(findings: unknown[] = [finding()], lowConfidenceFindings: unknown[] = []) {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    classification: { queryType: "deep_research" },
    meta: {},
    generatedAt: "2026-01-01T00:00:00.000Z",
    result: {
      executiveSummary: "x",
      findings,
      lowConfidenceFindings,
      disagreements: [],
      evidenceGaps: [],
      openQuestions: [],
      panelBlindSpots: [],
      researchBoundaries: [],
      recommendedNextSteps: [],
      sourceCoverage: { findingsWithSources: 1, totalFindings: 1, coverageRatio: 1 },
      totalModels: 4,
    },
  };
}

function seedRun(overrides: Record<string, unknown> = {}, runId = RUN_ID) {
  runsStore.set(runId, { workspaceId: WS_A, userId: "creator-uid", adaptiveOutput: deepResearchOutput(), ...overrides });
}

function selectorFor(runId: string, f: ReturnType<typeof finding>, section: "findings" | "lowConfidenceFindings" = "findings", index = 0): string {
  const id = buildDeepResearchClaimId({ runId, section, index, finding: f });
  if (id === null) throw new Error("test setup: expected a valid selector");
  return id;
}

function grantedAccess(capabilities: string[] = ["research.read"]) {
  return { granted: true, workspace: {}, membership: {}, capabilities };
}

beforeEach(() => {
  runsStore.clear();
  jest.clearAllMocks();
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess());
});

describe("resolveTeamSourceResearchLink", () => {
  it("valid origin + current Team access + source run in the expected Workspace -> exact type/runId/claimId", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: CALLER_UID, workspaceId: WS_A });
  });

  it("origin absent -> null, no access check performed (short-circuits before any I/O)", async () => {
    const result = await resolveTeamSourceResearchLink({ origin: undefined, callerUid: CALLER_UID, expectedWorkspaceId: WS_A });
    expect(result).toBeNull();
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("malformed origin (missing claimId) -> null, no crash", async () => {
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
  });

  it("unsupported origin type -> null", async () => {
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "something_else", runId: RUN_ID, claimId: "v1:findings:0:" + "a".repeat(43) },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
  });

  it("current Team access denied (e.g. membership_removed) -> null, run never even read (a genuinely resolvable run/claimId is seeded, so the access check is the only thing that can be blocking)", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const getSpy = jest.fn();
    const originalCollection = mockAdminDb.collection;
    mockAdminDb.collection = (name: string) => {
      const inner = originalCollection(name);
      return { doc: (id: string) => { getSpy(); return inner.doc(id); } };
    };
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
    mockAdminDb.collection = originalCollection;
  });

  it("current Team access granted but missing research.read capability -> null, even though the run is genuinely valid and resolvable", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ adaptiveOutput: deepResearchOutput([f]) });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess(["projects.read"]));
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
  });

  it("source run missing entirely -> null", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: "nonexistent-run", claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
  });

  describe("CRITICAL — provenance containment (Workspace boundary)", () => {
    it("source run bound to a DIFFERENT Workspace than the verification -> null (caller only authorized for A)", async () => {
      const f = finding();
      const claimId = selectorFor(RUN_ID, f);
      seedRun({ workspaceId: WS_B }); // run actually lives in B
      const result = await resolveTeamSourceResearchLink({
        origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
        callerUid: CALLER_UID,
        expectedWorkspaceId: WS_A, // verification belongs to A
      });
      expect(result).toBeNull();
    });

    it("CRITICAL: caller is authorized in BOTH Workspace A and Workspace B, but origin's run lives in B while the verification belongs to A -> STILL null", async () => {
      const f = finding();
      const claimId = selectorFor(RUN_ID, f);
      seedRun({ workspaceId: WS_B });
      // Simulate the caller having research.read in EITHER workspace —
      // the mock always grants, which is the worst case: even maximal
      // caller access must not let a cross-Workspace forged/corrupted
      // origin resolve, because this function only ever authorizes
      // against expectedWorkspaceId (A) and never separately checks or
      // trusts the caller's standing in B.
      mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess());
      const result = await resolveTeamSourceResearchLink({
        origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
        callerUid: CALLER_UID,
        expectedWorkspaceId: WS_A,
      });
      expect(result).toBeNull();
      // Only ever authorized against A — B's access was never checked or
      // needed, proving containment doesn't depend on the caller's B
      // standing at all.
      expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: CALLER_UID, workspaceId: WS_A });
      expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalledWith({ uid: CALLER_UID, workspaceId: WS_B });
    });

    it("source run is Personal-bound (no workspaceId at all) -> null, never treated as Team-containable", async () => {
      const f = finding();
      const claimId = selectorFor(RUN_ID, f);
      seedRun({ workspaceId: undefined });
      runsStore.set(RUN_ID, { userId: "someone", adaptiveOutput: deepResearchOutput([f]) }); // no workspaceId field at all
      const result = await resolveTeamSourceResearchLink({
        origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
        callerUid: CALLER_UID,
        expectedWorkspaceId: WS_A,
      });
      expect(result).toBeNull();
    });
  });

  it("source run is not deep_research -> null", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    seedRun({
      adaptiveOutput: {
        version: 1,
        schemaId: "causal_explanation",
        answerShape: "causal_map",
        classification: { queryType: "causal_explanation" },
        meta: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        result: { directAnswer: "x", factors: [], interpretations: [], totalModels: 3 },
      },
    });
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
  });

  it("malformed persisted adaptive output -> null, no uncontrolled exception", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    seedRun({
      adaptiveOutput: { version: 1, schemaId: "deep_research", answerShape: "deep_research_view", classification: {}, meta: {}, generatedAt: "x", result: { executiveSummary: "x" } },
    });
    await expect(
      resolveTeamSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID, expectedWorkspaceId: WS_A })
    ).resolves.toBeNull();
  });

  it("stale/forged fingerprint claimId -> null", async () => {
    seedRun();
    const forged = "v1:findings:0:" + "z".repeat(43);
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId: forged },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toBeNull();
  });

  it("valid fingerprint -> exact runId/claimId", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
  });

  it("verification/source projectId drift does not block resolution (no projectId equality required)", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ projectId: "proj-currently-assigned-elsewhere" });
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(result).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
  });

  it("returned object never contains projectId or workspaceId", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    const result = await resolveTeamSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
      expectedWorkspaceId: WS_A,
    });
    expect(Object.keys(result!).sort()).toEqual(["claimId", "runId", "type"]);
  });

  it("Firestore .get() throws -> null, never rejects", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    const originalCollection = mockAdminDb.collection;
    mockAdminDb.collection = () => ({
      doc: () => ({
        get: async () => {
          throw new Error("simulated infrastructure failure");
        },
      }),
    });
    try {
      await expect(
        resolveTeamSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID, expectedWorkspaceId: WS_A })
      ).resolves.toBeNull();
    } finally {
      mockAdminDb.collection = originalCollection;
    }
  });

  it("performs at most one run document read", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    const getSpy = jest.fn();
    const originalCollection = mockAdminDb.collection;
    mockAdminDb.collection = (name: string) => {
      const inner = originalCollection(name);
      return {
        doc: (id: string) => {
          const innerDoc = inner.doc(id);
          return { ...innerDoc, get: async () => { getSpy(); return innerDoc.get(); } };
        },
      };
    };
    await resolveTeamSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID, expectedWorkspaceId: WS_A });
    expect(getSpy).toHaveBeenCalledTimes(1);
    mockAdminDb.collection = originalCollection;
  });

  it("uses current Team run-access helper — re-derives access rather than trusting a prior check", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    await resolveTeamSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID, expectedWorkspaceId: WS_A });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledTimes(1);
  });
});
