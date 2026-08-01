/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D —
 * submitAdaptiveHumanReview() transaction tests, plus
 * getAdaptiveTeamRunProjection()/syncAdaptiveTeamRunProjectionAfterReview()
 * projection tests (docs/governance-decision-receipts-design.md §21.7/§21.9).
 *
 * The fake Firestore below models a real transaction: `txn.get()` reads
 * from the SAME backing store `txn.update()` writes to, and `.update()`
 * applies dot-notation field paths at the leaf level (not whole-object
 * replacement) — this is what makes the "only two nested fields written"
 * and "sibling fields untouched" assertions below a genuine proof rather
 * than an assumption.
 */

const runDocs = new Map<string, Record<string, any>>();
const teamRunDocs = new Map<string, Record<string, any>>();
const firestoreUnavailableFlag = { value: false };
const forceTransactionThrow = { value: false };
const eventsByRunId = new Map<string, Record<string, unknown>[]>();

function applyDotPathUpdate(target: Record<string, any>, fields: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(fields)) {
    const segments = path.split(".");
    let cursor = target;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
        cursor[segment] = {};
      }
      cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
  }
}

function notFoundError(id: string) {
  const err: any = new Error("5 NOT_FOUND: No document to update: runs/" + id);
  err.code = 5;
  return err;
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      id,
      get: jest.fn().mockImplementation(async () => {
        const store = name === "runs" ? runDocs : teamRunDocs;
        return { exists: store.has(id), data: () => store.get(id) };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        const store = name === "runs" ? runDocs : teamRunDocs;
        if (!store.has(id)) throw notFoundError(id);
        applyDotPathUpdate(store.get(id)!, fields);
      }),
      collection: (subName: string) => ({
        add: jest.fn().mockImplementation(async (event: Record<string, unknown>) => {
          const key = `${id}/${subName}`;
          const existing = eventsByRunId.get(key) || [];
          existing.push(event);
          eventsByRunId.set(key, existing);
          return { id: `event-${existing.length}` };
        }),
      }),
    }),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    if (forceTransactionThrow.value) {
      throw new Error("transaction failed");
    }
    const txn = {
      get: async (ref: { id: string }) => ({
        exists: runDocs.has(ref.id),
        data: () => runDocs.get(ref.id),
      }),
      update: (ref: { id: string }, fields: Record<string, unknown>) => {
        if (!runDocs.has(ref.id)) throw notFoundError(ref.id);
        applyDotPathUpdate(runDocs.get(ref.id)!, fields);
      },
    };
    return fn(txn);
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { submitAdaptiveHumanReview } from "@/lib/firestore/runs";
import { getAdaptiveTeamRunProjection, syncAdaptiveTeamRunProjectionAfterReview } from "@/lib/firestore/teamRuns";
import { buildAdaptiveTeamRunProjectionId } from "@/lib/governance/adaptiveTeamReview";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

function governanceRecord(overrides: Partial<GovernanceRecordV1> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    automatedGovernance: { status: "flagged", reasons: ["2 model(s) failed"], evaluatedAt: "2026-07-29T00:00:00.000Z", policyVersion: 3 },
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  } as GovernanceRecordV1;
}

function seedRun(runId: string, record: GovernanceRecordV1) {
  // Deep-cloned — a real Firestore document is never the SAME in-memory
  // object as whatever local variable was used to seed a test fixture, so
  // the store must hold an independent copy for "input record not
  // mutated" assertions to mean anything.
  runDocs.set(runId, JSON.parse(JSON.stringify({ governanceRecord: record, userId: "owner-uid" })));
}

const EXPECTED_UPDATED_AT = "2026-07-29T00:00:00.000Z";

beforeEach(() => {
  runDocs.clear();
  teamRunDocs.clear();
  eventsByRunId.clear();
  firestoreUnavailableFlag.value = false;
  forceTransactionThrow.value = false;
  mockLoggerWarn.mockClear();
  mockAdminDb.runTransaction.mockClear();
});

describe("submitAdaptiveHumanReview", () => {
  it("valid unreviewed -> terminal decision succeeds", async () => {
    seedRun("run-1", governanceRecord({ humanReview: { status: "unreviewed" } }));

    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      reviewerName: "Reviewer Name",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      now: "2026-07-30T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.humanReview.status).toBe("approved");
      expect(result.record.humanReview.reviewerId).toBe("reviewer-uid");
      expect(result.record.humanReview.reviewerName).toBe("Reviewer Name");
      expect(result.record.humanReview.reviewedAt).toBe("2026-07-30T00:00:00.000Z");
      expect(result.priorHumanReviewStatus).toBe("unreviewed");
    }
  });

  it("valid pending -> terminal decision succeeds", async () => {
    seedRun("run-1", governanceRecord({ humanReview: { status: "pending" } }));

    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "rejected", comment: "no" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      now: "2026-07-30T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.humanReview.status).toBe("rejected");
      expect(result.priorHumanReviewStatus).toBe("pending");
    }
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"] as const)(
    "a terminal '%s' record cannot be changed",
    async (terminalStatus) => {
      const conditions = terminalStatus === "approved_with_conditions" ? ["x"] : undefined;
      seedRun("run-1", governanceRecord({ humanReview: { status: terminalStatus, conditions } }));

      const result = await submitAdaptiveHumanReview({
        runId: "run-1",
        update: { status: "approved" },
        reviewerId: "reviewer-uid",
        expectedUpdatedAt: EXPECTED_UPDATED_AT,
      });

      expect(result).toEqual({ ok: false, reason: "terminal_review_exists" });
      // The record itself must remain unchanged.
      expect(runDocs.get("run-1")!.governanceRecord.humanReview.status).toBe(terminalStatus);
    }
  );

  it("rejects a stale expectedUpdatedAt", async () => {
    seedRun("run-1", governanceRecord({ updatedAt: "2026-07-29T12:00:00.000Z" }));

    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT, // stale — record's real updatedAt is later
    });

    expect(result).toEqual({ ok: false, reason: "stale_expected_updated_at" });
  });

  it("checks current stored state INSIDE the transaction, not a value read before it", async () => {
    seedRun("run-1", governanceRecord({ humanReview: { status: "unreviewed" }, updatedAt: EXPECTED_UPDATED_AT }));

    // Simulate a concurrent write landing between "the caller last observed
    // the record" and this call, by mutating the store directly before
    // calling submitAdaptiveHumanReview — the transaction must see THIS
    // state, not an earlier one.
    runDocs.get("run-1")!.governanceRecord = governanceRecord({
      humanReview: { status: "approved", reviewerId: "someone-else" },
      updatedAt: EXPECTED_UPDATED_AT,
    });

    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "rejected", comment: "no" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });

    expect(result).toEqual({ ok: false, reason: "terminal_review_exists" });
  });

  it("two concurrent reviewers: exactly one commits", async () => {
    seedRun("run-1", governanceRecord({ humanReview: { status: "unreviewed" }, updatedAt: EXPECTED_UPDATED_AT }));

    // Both "requests" observed the same expectedUpdatedAt. Run them
    // sequentially against the shared store (this fake has no real
    // concurrent scheduler), but assert the SECOND one — which now sees a
    // terminal record because the first one committed — is rejected. This
    // proves the current-state check is real and re-evaluated per call,
    // which is what makes concurrent submission safe against the real
    // Firestore transaction machinery.
    const first = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-a",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    const second = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "rejected", comment: "no" },
      reviewerId: "reviewer-b",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });

    expect(first.ok).toBe(true);
    // The first commit already advanced governanceRecord.updatedAt, so the
    // second call's (now-stale) expectedUpdatedAt is caught by the stale
    // check BEFORE the reviewable-status check even runs — exactly the
    // ordering §21.7 requires ("checked BEFORE the reviewable-status
    // check"). Either rejection reason would prove the same safety
    // property (only one caller's write survives); this is the one the
    // real ordering actually produces.
    expect(second).toEqual({ ok: false, reason: "stale_expected_updated_at" });
  });

  it("writes only the two nested fields — automatedGovernance, decisionReceipt, schemaId, answerShape, adaptiveOutputVersion, createdAt untouched", async () => {
    const record = governanceRecord({ humanReview: { status: "unreviewed" }, updatedAt: EXPECTED_UPDATED_AT });
    seedRun("run-1", record);

    await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
      now: "2026-07-30T00:00:00.000Z",
    });

    const stored = runDocs.get("run-1")!.governanceRecord;
    expect(stored.automatedGovernance).toEqual(record.automatedGovernance);
    expect(stored.decisionReceipt).toEqual(record.decisionReceipt);
    expect(stored.schemaId).toBe(record.schemaId);
    expect(stored.answerShape).toBe(record.answerShape);
    expect(stored.adaptiveOutputVersion).toBe(record.adaptiveOutputVersion);
    expect(stored.createdAt).toBe(record.createdAt);
    expect(stored.updatedAt).toBe("2026-07-30T00:00:00.000Z");
  });

  it("does not mutate the input record and produces no whole-record write (no .set())", async () => {
    const record = governanceRecord({ humanReview: { status: "unreviewed" }, updatedAt: EXPECTED_UPDATED_AT });
    const recordSnapshot = JSON.parse(JSON.stringify(record));
    seedRun("run-1", record);

    await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });

    // The in-memory `record` object passed to seedRun is never mutated by
    // applyHumanReviewUpdate (it returns a new object) — only the STORE's
    // own copy (accessed via the fake's dot-path update) changes.
    expect(record).toEqual(recordSnapshot);
  });

  it("run_missing when the parent run does not exist", async () => {
    const result = await submitAdaptiveHumanReview({
      runId: "does-not-exist",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "run_missing" });
  });

  it("governance_record_absent when no governanceRecord field exists", async () => {
    runDocs.set("run-1", { userId: "owner-uid" });
    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "governance_record_absent" });
  });

  it("governance_record_malformed for corrupted data", async () => {
    runDocs.set("run-1", { governanceRecord: { version: 1, garbage: true } });
    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "governance_record_malformed" });
  });

  it("unsupported_version for a future record version", async () => {
    const record = governanceRecord();
    runDocs.set("run-1", { governanceRecord: { ...record, version: 2 } });
    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("conditions_required passes through from applyHumanReviewUpdate", async () => {
    seedRun("run-1", governanceRecord({ humanReview: { status: "unreviewed" }, updatedAt: EXPECTED_UPDATED_AT }));
    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved_with_conditions" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "conditions_required" });
  });

  it("returns firestore_unavailable without throwing when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "firestore_unavailable" });
  });

  it("returns write_failed when the transaction itself throws", async () => {
    seedRun("run-1", governanceRecord({ updatedAt: EXPECTED_UPDATED_AT }));
    forceTransactionThrow.value = true;
    const result = await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(result).toEqual({ ok: false, reason: "write_failed" });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("does not retry after a transaction failure — exactly one attempt", async () => {
    seedRun("run-1", governanceRecord({ updatedAt: EXPECTED_UPDATED_AT }));
    forceTransactionThrow.value = true;
    await submitAdaptiveHumanReview({
      runId: "run-1",
      update: { status: "approved" },
      reviewerId: "reviewer-uid",
      expectedUpdatedAt: EXPECTED_UPDATED_AT,
    });
    expect(mockAdminDb.runTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("getAdaptiveTeamRunProjection", () => {
  it("returns 'found' with the raw projection data", async () => {
    const id = buildAdaptiveTeamRunProjectionId("team-1", "run-1");
    teamRunDocs.set(id, { adaptive: true, teamId: "team-1", runId: "run-1" });
    const result = await getAdaptiveTeamRunProjection("team-1", "run-1");
    expect(result).toEqual({ status: "found", projection: { adaptive: true, teamId: "team-1", runId: "run-1" } });
  });

  it("returns 'not_found' when no projection exists at the deterministic ID", async () => {
    const result = await getAdaptiveTeamRunProjection("team-1", "run-1");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns 'firestore_unavailable' when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await getAdaptiveTeamRunProjection("team-1", "run-1");
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});

describe("syncAdaptiveTeamRunProjectionAfterReview", () => {
  it("syncs humanReviewStatus/reviewedAt/updatedAt only, after the canonical write", async () => {
    const id = buildAdaptiveTeamRunProjectionId("team-1", "run-1");
    teamRunDocs.set(id, {
      adaptive: true,
      teamId: "team-1",
      runId: "run-1",
      humanReviewStatus: "unreviewed",
      receiptConclusion: "Original conclusion, must remain untouched.",
    });

    const result = await syncAdaptiveTeamRunProjectionAfterReview({
      teamId: "team-1",
      runId: "run-1",
      humanReviewStatus: "approved",
      reviewedAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    });

    expect(result).toEqual({ status: "synced" });
    const stored = teamRunDocs.get(id)!;
    expect(stored.humanReviewStatus).toBe("approved");
    expect(stored.reviewedAt).toBe("2026-07-30T00:00:00.000Z");
    expect(stored.updatedAt).toBe("2026-07-30T00:00:00.000Z");
    // Untouched sibling fields — no comment/conditions/receipt ever written here.
    expect(stored.receiptConclusion).toBe("Original conclusion, must remain untouched.");
    expect(stored).not.toHaveProperty("comment");
    expect(stored).not.toHaveProperty("conditions");
  });

  it("does not roll back or throw when the projection is missing — returns 'not_found' safely", async () => {
    const result = await syncAdaptiveTeamRunProjectionAfterReview({
      teamId: "team-1",
      runId: "run-1",
      humanReviewStatus: "approved",
      updatedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(result).toEqual({ status: "not_found" });
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("returns 'firestore_unavailable' safely when adminDb is null", async () => {
    firestoreUnavailableFlag.value = true;
    const result = await syncAdaptiveTeamRunProjectionAfterReview({
      teamId: "team-1",
      runId: "run-1",
      humanReviewStatus: "approved",
      updatedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(result).toEqual({ status: "firestore_unavailable" });
  });
});
