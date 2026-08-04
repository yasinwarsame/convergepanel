/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C —
 * buildAdaptiveTeamRunProjectionId() and createAdaptiveTeamRunProjection()
 * tests, including the mandatory proof that `.create()` (not `.set()`) is
 * used, and that an existing projection is never overwritten on retry.
 */

const docsById = new Map<string, Record<string, unknown>>();
const firestoreUnavailableFlag = { value: false };
const createMock = jest.fn();
const docMock = jest.fn();

function makeCreateImpl() {
  return async (id: string, projection: Record<string, unknown>) => {
    if (docsById.has(id)) {
      const err: any = new Error("6 ALREADY_EXISTS: Document already exists: " + id);
      err.code = 6;
      throw err;
    }
    docsById.set(id, projection);
  };
}

const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => {
      docMock(name, id);
      return {
        create: jest.fn().mockImplementation(async (projection: Record<string, unknown>) => {
          createMock(name, id, projection);
          return makeCreateImpl()(id, projection);
        }),
      };
    },
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { createAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { buildAdaptiveTeamRunProjectionId, AdaptiveTeamRunProjection } from "@/lib/governance/adaptiveTeamReview";

beforeEach(() => {
  docsById.clear();
  firestoreUnavailableFlag.value = false;
  createMock.mockClear();
  docMock.mockClear();
  mockLoggerWarn.mockClear();
});

function projection(overrides: Partial<AdaptiveTeamRunProjection> = {}): AdaptiveTeamRunProjection {
  return {
    projectionVersion: 1,
    teamId: "team_abc12345_1700000000000",
    userId: "uid-123",
    runId: "run-11111111-1111-1111-1111-111111111111",
    adaptive: true,
    schemaId: "ranked_enumeration",
    answerShape: "ranked_list",
    receiptConclusion: "Consensus reached.",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "passed",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildAdaptiveTeamRunProjectionId", () => {
  it("returns the same ID for the same team/run pair", () => {
    const id1 = buildAdaptiveTeamRunProjectionId("team_abc", "run-1");
    const id2 = buildAdaptiveTeamRunProjectionId("team_abc", "run-1");
    expect(id1).toBe(id2);
  });

  it("returns different IDs for different team/run pairs", () => {
    expect(buildAdaptiveTeamRunProjectionId("team_a", "run-1")).not.toBe(buildAdaptiveTeamRunProjectionId("team_b", "run-1"));
    expect(buildAdaptiveTeamRunProjectionId("team_a", "run-1")).not.toBe(buildAdaptiveTeamRunProjectionId("team_a", "run-2"));
  });

  it("rejects empty or whitespace-only teamId/runId", () => {
    expect(() => buildAdaptiveTeamRunProjectionId("", "run-1")).toThrow();
    expect(() => buildAdaptiveTeamRunProjectionId("   ", "run-1")).toThrow();
    expect(() => buildAdaptiveTeamRunProjectionId("team_a", "")).toThrow();
    expect(() => buildAdaptiveTeamRunProjectionId("team_a", "   ")).toThrow();
  });

  it("rejects a teamId or runId containing '/'", () => {
    expect(() => buildAdaptiveTeamRunProjectionId("team/a", "run-1")).toThrow();
    expect(() => buildAdaptiveTeamRunProjectionId("team_a", "run/1")).toThrow();
  });

  it("cannot collide across distinct pairs given the real ID formats used in this codebase", () => {
    // teamId format: team_${uid.slice(0,8)}_${Date.now()}; runId format: run-${randomUUID()} — neither contains ':'.
    const idA = buildAdaptiveTeamRunProjectionId("team_abc12345_1700000000000", "run-11111111-1111-1111-1111-111111111111");
    const idB = buildAdaptiveTeamRunProjectionId("team_abc12345_1700000000000:run-11111111-1111-1111-1111-111111111111", "extra");
    expect(idA).not.toBe(idB);
  });
});

describe("createAdaptiveTeamRunProjection", () => {
  it("uses .create(), not .set(), to write the projection", async () => {
    const p = projection();
    await createAdaptiveTeamRunProjection(p);
    expect(createMock).toHaveBeenCalledTimes(1);
    const [collectionName, id, writtenProjection] = createMock.mock.calls[0];
    expect(collectionName).toBe("teamRuns");
    expect(id).toBe(buildAdaptiveTeamRunProjectionId(p.teamId, p.runId));
    expect(writtenProjection).toEqual(p);
  });

  it("returns 'created' with the projection ID on first write", async () => {
    const p = projection();
    const result = await createAdaptiveTeamRunProjection(p);
    expect(result).toEqual({ status: "created", projectionId: buildAdaptiveTeamRunProjectionId(p.teamId, p.runId) });
  });

  it("returns 'already_exists' on a retried creation attempt, and leaves the existing document byte-for-byte unchanged", async () => {
    const first = projection({ humanReviewStatus: "unreviewed" });
    await createAdaptiveTeamRunProjection(first);
    const id = buildAdaptiveTeamRunProjectionId(first.teamId, first.runId);
    const storedAfterFirst = { ...docsById.get(id)! };

    // Simulate a retried creation attempt with DIFFERENT content — proving
    // the retry cannot clobber a projection whose review status may have
    // since been synced by a future Part D write.
    const retried = projection({ humanReviewStatus: "approved", receiptConclusion: "different content" });
    const result = await createAdaptiveTeamRunProjection(retried);

    expect(result).toEqual({ status: "already_exists", projectionId: id });
    expect(docsById.get(id)).toEqual(storedAfterFirst);
    expect(docsById.get(id)!.humanReviewStatus).toBe("unreviewed");
  });

  it("makes exactly one write attempt — no retry loop on ALREADY_EXISTS or on failure", async () => {
    const p = projection();
    await createAdaptiveTeamRunProjection(p);
    createMock.mockClear();
    await createAdaptiveTeamRunProjection(p);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("returns 'firestore_unavailable' when adminDb is null, without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createAdaptiveTeamRunProjection(projection());
    expect(result).toEqual({ status: "firestore_unavailable" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 'write_failed' on an unexpected Firestore error, without throwing", async () => {
    const p = projection();
    const id = buildAdaptiveTeamRunProjectionId(p.teamId, p.runId);
    // Pre-seed a doc-create override by mocking a permission error instead of ALREADY_EXISTS.
    const originalCollection = mockAdminDb.collection;
    (mockAdminDb as any).collection = (name: string) => ({
      doc: (docId: string) => ({
        create: jest.fn().mockImplementation(async () => {
          const err: any = new Error("7 PERMISSION_DENIED: Missing or insufficient permissions");
          err.code = 7;
          throw err;
        }),
      }),
    });

    const result = await createAdaptiveTeamRunProjection(p);
    expect(result).toEqual({ status: "write_failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();

    (mockAdminDb as any).collection = originalCollection;
    void id;
  });

  it("logs only metadata (runId/teamId) on failure — never the receipt conclusion or review data", async () => {
    (mockAdminDb as any).collection = (name: string) => ({
      doc: () => ({
        create: jest.fn().mockImplementation(async () => {
          const err: any = new Error("13 INTERNAL");
          err.code = 13;
          throw err;
        }),
      }),
    });

    const p = projection({ receiptConclusion: "SENSITIVE CONTENT SHOULD NOT BE LOGGED" });
    await createAdaptiveTeamRunProjection(p);

    expect(mockLoggerWarn).toHaveBeenCalled();
    const loggedArgs = JSON.stringify(mockLoggerWarn.mock.calls[0]);
    expect(loggedArgs).not.toContain("SENSITIVE CONTENT SHOULD NOT BE LOGGED");
    expect(loggedArgs).toContain(p.runId);
    expect(loggedArgs).toContain(p.teamId);
  });
});
