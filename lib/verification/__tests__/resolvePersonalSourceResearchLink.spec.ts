/**
 * Evidence Workspace, Phase 11A.5B — resolvePersonalSourceResearchLink()
 * tests. Mocks only `adminDb.collection("runs")` (same convention as
 * claimVerificationOrigin.spec.ts) — this helper never reads any other
 * collection, and never writes anything at all.
 */

type StoredDoc = Record<string, unknown>;
const runsStore = new Map<string, StoredDoc>();

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") {
      throw new Error(`resolvePersonalSourceResearchLink must never read collection "${name}"`);
    }
    return {
      doc: (docId: string) => ({
        get: async () => {
          const data = runsStore.get(docId);
          return { exists: data !== undefined, data: () => data, id: docId };
        },
        // Any write attempt must fail loudly — this helper is read-only.
        set: () => {
          throw new Error("resolvePersonalSourceResearchLink must never write");
        },
        update: () => {
          throw new Error("resolvePersonalSourceResearchLink must never write");
        },
        delete: () => {
          throw new Error("resolvePersonalSourceResearchLink must never write");
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

import { resolvePersonalSourceResearchLink } from "@/lib/verification/resolvePersonalSourceResearchLink";
import { buildDeepResearchClaimId } from "@/lib/verification/claimVerificationOrigin";

const CALLER_UID = "user-1";
const OTHER_UID = "user-2";
const RUN_ID = "run-1";

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "finding-1",
    title: "A short label",
    summary: "A stable, unchanged finding.",
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
  runsStore.set(runId, { userId: CALLER_UID, adaptiveOutput: deepResearchOutput(), ...overrides });
}

function selectorFor(runId: string, f: ReturnType<typeof finding>, section: "findings" | "lowConfidenceFindings" = "findings", index = 0): string {
  const id = buildDeepResearchClaimId({ runId, section, index, finding: f });
  if (id === null) throw new Error("test setup: expected a valid selector");
  return id;
}

beforeEach(() => {
  runsStore.clear();
  jest.clearAllMocks();
});

describe("resolvePersonalSourceResearchLink", () => {
  it("valid origin + owned/readable Deep Research source run -> exact type/runId/claimId", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
  });

  it("origin absent (undefined) -> null", async () => {
    const result = await resolvePersonalSourceResearchLink({ origin: undefined, callerUid: CALLER_UID });
    expect(result).toBeNull();
  });

  it("origin null -> null", async () => {
    const result = await resolvePersonalSourceResearchLink({ origin: null, callerUid: CALLER_UID });
    expect(result).toBeNull();
  });

  it("malformed origin (missing claimId) -> null, no crash", async () => {
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("malformed origin (runId wrong type) -> null, no crash", async () => {
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: 12345, claimId: "v1:findings:0:" + "a".repeat(43) },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("unsupported origin type value -> null", async () => {
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "something_else", runId: RUN_ID, claimId: "v1:findings:0:" + "a".repeat(43) },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("origin is a primitive (string) -> null, no crash", async () => {
    const result = await resolvePersonalSourceResearchLink({ origin: "not-an-object", callerUid: CALLER_UID });
    expect(result).toBeNull();
  });

  it("source run missing entirely -> null", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: "nonexistent-run", claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("source run owned by a different Personal user -> null, no source details leaked", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ userId: OTHER_UID });
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("source run is Team-bound (has a workspaceId) -> null, never falls back to Personal ownership", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ workspaceId: "ws-team-1" });
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
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
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("malformed persisted adaptiveOutput (findings absent) -> null, no uncontrolled exception", async () => {
    const claimId = "v1:findings:0:" + "a".repeat(43);
    seedRun({
      adaptiveOutput: {
        version: 1,
        schemaId: "deep_research",
        answerShape: "deep_research_view",
        classification: { queryType: "deep_research" },
        meta: {},
        generatedAt: "2026-01-01T00:00:00.000Z",
        result: { executiveSummary: "x", lowConfidenceFindings: [], totalModels: 1, sourceCoverage: { findingsWithSources: 0, totalFindings: 0, coverageRatio: 0 }, disagreements: [], evidenceGaps: [], openQuestions: [], panelBlindSpots: [], researchBoundaries: [], recommendedNextSteps: [] },
      },
    });
    await expect(
      resolvePersonalSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID })
    ).resolves.toBeNull();
  });

  it("stale/forged fingerprint claimId -> null", async () => {
    seedRun();
    const forged = "v1:findings:0:" + "z".repeat(43);
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId: forged },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("claimId no longer matches the current finding at that position (content changed since issuance) -> null", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ adaptiveOutput: deepResearchOutput([finding({ summary: "This finding's text has since changed." })]) });
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toBeNull();
  });

  it("Firestore read throws -> null, never rejects (enrichment must never fail the primary verification read)", async () => {
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
        resolvePersonalSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID })
      ).resolves.toBeNull();
    } finally {
      mockAdminDb.collection = originalCollection;
    }
  });

  it("source run's projectId differs from any prior expectation -> link still resolves (no projectId equality required)", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun({ projectId: "proj-currently-assigned" });
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(result).toEqual({ type: "deep_research_claim", runId: RUN_ID, claimId });
  });

  it("returned object never contains a projectId or workspaceId key", async () => {
    const f = finding();
    const claimId = selectorFor(RUN_ID, f);
    seedRun();
    const result = await resolvePersonalSourceResearchLink({
      origin: { type: "deep_research_claim", runId: RUN_ID, claimId },
      callerUid: CALLER_UID,
    });
    expect(Object.keys(result!).sort()).toEqual(["claimId", "runId", "type"]);
  });

  it("performs at most one Firestore read", async () => {
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
          return {
            ...innerDoc,
            get: async () => {
              getSpy();
              return innerDoc.get();
            },
          };
        },
      };
    };
    await resolvePersonalSourceResearchLink({ origin: { type: "deep_research_claim", runId: RUN_ID, claimId }, callerUid: CALLER_UID });
    expect(getSpy).toHaveBeenCalledTimes(1);
    mockAdminDb.collection = originalCollection;
  });
});
