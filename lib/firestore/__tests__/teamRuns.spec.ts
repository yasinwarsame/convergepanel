/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C —
 * buildAdaptiveTeamRunProjectionId() and createAdaptiveTeamRunProjection()
 * tests, including the mandatory proof that `.create()` (not `.set()`) is
 * used, and that an existing projection is never overwritten on retry.
 */

// Research deletion integrity (2026-11-03): the projection is now created in a transaction guarded by the deletion
// barrier (it carries the receipt conclusion). The spec uses the shared transactional fake, which models create()
// exclusivity (ALREADY_EXISTS) and transaction attempts. `docsById` reads teamRuns documents by id;
// `createCalls()` lists applied creates as the old spy's [collection, id, data].
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
const db = new FakeTransactionalFirestore();
const firestoreUnavailableFlag = { value: false };
const docsById = { get: (id: string) => db.read(`teamRuns/${id}`) as Record<string, unknown> | undefined };
const createCalls = () =>
  db.writeLog.filter((w) => w.kind === "create").map((w) => {
    const [collectionName, id] = w.path.split("/");
    return [collectionName, id, w.data] as [string, string, Record<string, unknown>];
  });
const RUN = "run-11111111-1111-1111-1111-111111111111";

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : db;
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { createAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { buildAdaptiveTeamRunProjectionId, AdaptiveTeamRunProjection } from "@/lib/governance/adaptiveTeamReview";

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  db.stats = { commits: 0, retries: 0, aborted: 0 };
  db.seed(`runs/${RUN}`, { userId: "uid-123" }); // the projected run exists and is writable
  firestoreUnavailableFlag.value = false;
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
    expect(createCalls()).toHaveLength(1);
    expect(db.writeLog.map((w) => w.kind)).toEqual(["create"]); // never a set
    const [collectionName, id, writtenProjection] = createCalls()[0];
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
    db.writeLog = [];
    db.stats = { commits: 0, retries: 0, aborted: 0 };
    expect(await createAdaptiveTeamRunProjection(p)).toEqual(expect.objectContaining({ status: "already_exists" }));
    // One transaction attempt, which finds the projection and writes nothing; no retry loop.
    expect(db.stats).toEqual({ commits: 1, retries: 0, aborted: 0 });
    expect(db.writeLog).toEqual([]);
  });

  it("returns 'firestore_unavailable' when adminDb is null, without throwing", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await createAdaptiveTeamRunProjection(projection());
    expect(result).toEqual({ status: "firestore_unavailable" });
    expect(createCalls()).toHaveLength(0);
  });

  it("returns 'write_failed' on an unexpected Firestore error, without throwing", async () => {
    const p = projection();
    const id = buildAdaptiveTeamRunProjectionId(p.teamId, p.runId);
    // A permission error at commit instead of ALREADY_EXISTS.
    db.hooks.failCommit = () => {
      const err: any = new Error("7 PERMISSION_DENIED: Missing or insufficient permissions");
      err.code = 7;
      throw err;
    };

    const result = await createAdaptiveTeamRunProjection(p);
    expect(result).toEqual({ status: "write_failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();

    expect(docsById.get(id)).toBeUndefined();
  });

  it("logs only metadata (runId/teamId) on failure — never the receipt conclusion or review data", async () => {
    db.hooks.failCommit = () => {
      const err: any = new Error("13 INTERNAL");
      err.code = 13;
      throw err;
    };

    const p = projection({ receiptConclusion: "SENSITIVE CONTENT SHOULD NOT BE LOGGED" });
    await createAdaptiveTeamRunProjection(p);

    expect(mockLoggerWarn).toHaveBeenCalled();
    const loggedArgs = JSON.stringify(mockLoggerWarn.mock.calls[0]);
    expect(loggedArgs).not.toContain("SENSITIVE CONTENT SHOULD NOT BE LOGGED");
    expect(loggedArgs).toContain(p.runId);
    expect(loggedArgs).toContain(p.teamId);
  });

  it("deletion barrier: a run that is deleted, being deleted or missing gets no projection", async () => {
    for (const setup of [() => db.seed(`runDeletionJobs/${RUN}`, { state: "complete" }), () => db.seed(`runs/${RUN}`, { deletion: { state: "pending" } }), () => db.docs.delete(`runs/${RUN}`)]) {
      db.docs.clear();
      db.writeLog = [];
      db.seed(`runs/${RUN}`, { userId: "uid-123" });
      setup();
      expect(await createAdaptiveTeamRunProjection(projection())).toEqual({ status: "write_failed" });
      expect(createCalls()).toHaveLength(0);
    }
  });
});
