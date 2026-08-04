/**
 * Query-Routing Redesign, Phase 2A, Step 6B, Part B —
 * persistAutomatedGovernanceUpdate() and writeAdaptiveGovernanceEvent()
 * tests, plus the MANDATORY concurrency regression proving nested
 * field-path updates cannot clobber a concurrent human-review change
 * (docs/governance-decision-receipts-design.md §18.9).
 *
 * The fake Firestore below models `.update()` at the FIELD-PATH level
 * (not just top-level keys) so a dot-notation write like
 * `"governanceRecord.automatedGovernance"` only ever touches that one
 * nested leaf, exactly like the real Admin SDK — this is what makes the
 * concurrency regression below a meaningful proof rather than an
 * assumption.
 */

const runDocs = new Map<string, Record<string, any>>();
const missingRunIds = new Set<string>();
const firestoreUnavailableFlag = { value: false };

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

const eventsByRunId = new Map<string, Record<string, unknown>[]>();

const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        if (name === "runs" && missingRunIds.has(id)) {
          const err: any = new Error("5 NOT_FOUND: No document to update: runs/" + id);
          err.code = 5;
          throw err;
        }
        if (!runDocs.has(id)) {
          runDocs.set(id, {});
        }
        applyDotPathUpdate(runDocs.get(id)!, fields);
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

import { persistAutomatedGovernanceUpdate, writeAdaptiveGovernanceEvent } from "@/lib/firestore/runs";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

function automatedGovernance(overrides: Partial<NonNullable<GovernanceRecordV1["automatedGovernance"]>> = {}) {
  return {
    status: "flagged" as const,
    reasons: ["1 model(s) failed to produce usable output"],
    evaluatedAt: "2026-07-29T12:00:00.000Z",
    policyVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  runDocs.clear();
  missingRunIds.clear();
  eventsByRunId.clear();
  firestoreUnavailableFlag.value = false;
  mockLoggerWarn.mockClear();
});

describe("persistAutomatedGovernanceUpdate", () => {
  it("writes only the two nested field paths, via .update()", async () => {
    const runId = "run-1";
    runDocs.set(runId, { governanceRecord: { schemaId: "decision_support", humanReview: { status: "unreviewed" } } });

    const outcome = await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");

    expect(outcome).toEqual({ saved: true });
    const stored = runDocs.get(runId);
    expect(stored.governanceRecord.automatedGovernance).toEqual(automatedGovernance());
    expect(stored.governanceRecord.updatedAt).toBe("2026-07-29T13:00:00.000Z");
  });

  it("never includes humanReview in the write payload — sibling field untouched", async () => {
    const runId = "run-2";
    runDocs.set(runId, { governanceRecord: { schemaId: "decision_support", humanReview: { status: "approved", reviewerId: "u1" } } });

    await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");

    const stored = runDocs.get(runId);
    expect(stored.governanceRecord.humanReview).toEqual({ status: "approved", reviewerId: "u1" });
  });

  it("never includes decisionReceipt in the write payload — sibling field untouched", async () => {
    const runId = "run-3";
    runDocs.set(runId, { governanceRecord: { schemaId: "decision_support", decisionReceipt: { conclusion: "original conclusion" } } });

    await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");

    const stored = runDocs.get(runId);
    expect(stored.governanceRecord.decisionReceipt).toEqual({ conclusion: "original conclusion" });
  });

  it("never includes schemaId in the write payload — sibling field untouched", async () => {
    const runId = "run-4";
    runDocs.set(runId, { governanceRecord: { schemaId: "decision_support" } });

    await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");

    expect(runDocs.get(runId).governanceRecord.schemaId).toBe("decision_support");
  });

  it("uses .update() rather than creating a document — the fake Firestore's doc object exposes no .set() at all, so a successful write here is only reachable via .update()", async () => {
    const runId = "run-5";
    runDocs.set(runId, { governanceRecord: {} });

    const outcome = await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");

    expect(outcome).toEqual({ saved: true });
  });

  it("returns run_missing (not a generic failure) when the run document doesn't exist, and does not create one", async () => {
    const runId = "run-missing-1";
    missingRunIds.add(runId);

    const outcome = await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");

    expect(outcome).toEqual({ saved: false, reason: "run_missing" });
    expect(runDocs.has(runId)).toBe(false);
  });

  it("returns firestore_unavailable when adminDb is not configured, without attempting a write", async () => {
    firestoreUnavailableFlag.value = true;
    const outcome = await persistAutomatedGovernanceUpdate("run-x", automatedGovernance(), "2026-07-29T13:00:00.000Z");
    expect(outcome).toEqual({ saved: false, reason: "firestore_unavailable" });
  });

  it("returns write_failed for a generic write error (not classified as run_missing)", async () => {
    const runId = "run-write-error";
    const brokenAdminDb = {
      collection: () => ({
        doc: () => ({
          update: jest.fn().mockRejectedValueOnce(new Error("internal error")),
        }),
      }),
    };
    jest.resetModules();
    jest.doMock("@/lib/firebase/admin", () => ({ adminDb: brokenAdminDb }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
    const { persistAutomatedGovernanceUpdate: persistWithBrokenDb } = await import("@/lib/firestore/runs");

    const outcome = await persistWithBrokenDb(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");
    expect(outcome).toEqual({ saved: false, reason: "write_failed" });
    jest.resetModules();
  });

  it("does not retry after a write failure", async () => {
    const runId = "run-no-retry";
    const updateMock = jest.fn().mockRejectedValueOnce(new Error("boom"));
    const brokenAdminDb = { collection: () => ({ doc: () => ({ update: updateMock }) }) };
    jest.resetModules();
    jest.doMock("@/lib/firebase/admin", () => ({ adminDb: brokenAdminDb }));
    jest.doMock("@/lib/logger", () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
    const { persistAutomatedGovernanceUpdate: persistWithBrokenDb } = await import("@/lib/firestore/runs");

    await persistWithBrokenDb(runId, automatedGovernance(), "2026-07-29T13:00:00.000Z");
    expect(updateMock).toHaveBeenCalledTimes(1);
    jest.resetModules();
  });

  it("logs only metadata (runId) on failure — never receipt content, reasons, or reviewer identity", async () => {
    const runId = "run-secret-check";
    missingRunIds.add(runId);
    await persistAutomatedGovernanceUpdate(
      runId,
      automatedGovernance({ reasons: ["SECRET REASON TEXT should not leak"] }),
      "2026-07-29T13:00:00.000Z"
    );
    const logged = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logged).not.toContain("SECRET REASON TEXT");
  });
});

describe("writeAdaptiveGovernanceEvent", () => {
  it("writes the generic governanceEvents shape, using the real (schema-agnostic) contract", async () => {
    const runId = "run-events-1";
    const outcome = await writeAdaptiveGovernanceEvent(runId, automatedGovernance(), "2026-07-29T12:00:00.000Z");
    expect(outcome).toEqual({ written: true });

    const events = eventsByRunId.get(`${runId}/governanceEvents`);
    expect(events).toHaveLength(1);
    expect(events?.[0]).toEqual(
      expect.objectContaining({
        action: "evaluated",
        byUid: "system",
        byEmail: "system",
        nextStatus: "flagged",
        reasons: ["1 model(s) failed to produce usable output"],
        policyVersion: 1,
      })
    );
  });

  it("never writes to admin_audit_logs", async () => {
    await writeAdaptiveGovernanceEvent("run-events-2", automatedGovernance(), "2026-07-29T12:00:00.000Z");
    // The shared mockAdminDb only ever creates "runs/{id}/governanceEvents"
    // subcollection docs from this function — no top-level admin_audit_logs
    // collection call is ever issued, confirmed by the absence of any key
    // under that name in the event store.
    expect([...eventsByRunId.keys()].every((k) => k.includes("governanceEvents"))).toBe(true);
  });

  it("returns firestore_unavailable when adminDb is not configured", async () => {
    firestoreUnavailableFlag.value = true;
    const outcome = await writeAdaptiveGovernanceEvent("run-x", automatedGovernance(), "2026-07-29T12:00:00.000Z");
    expect(outcome).toEqual({ written: false, reason: "firestore_unavailable" });
  });

  it("uses the exact injected timestamp for 'at', never generating its own — the same moment shared across the evaluator, the persisted record, and this event", async () => {
    const runId = "run-events-shared-timestamp";
    const sharedTimestamp = "2026-07-29T09:15:00.000Z";
    await writeAdaptiveGovernanceEvent(runId, automatedGovernance(), sharedTimestamp);
    const events = eventsByRunId.get(`${runId}/governanceEvents`);
    expect(events?.[0]?.at).toBe(sharedTimestamp);
  });
});

describe("Concurrency regression — MANDATORY (§18.9)", () => {
  it("a concurrent human-review update is never clobbered by an automated-governance persistence write that started reading before it", async () => {
    const runId = "run-concurrency";
    runDocs.set(runId, {
      governanceRecord: {
        schemaId: "decision_support",
        humanReview: { status: "unreviewed" },
        decisionReceipt: { conclusion: "original conclusion" },
        createdAt: "2026-07-29T10:00:00.000Z",
      },
    });

    // 1. The evaluator "reads" the record while humanReview is still
    //    unreviewed (simulated — the evaluator itself is pure/no I/O, so
    //    this models the state at the moment evaluation began).
    const recordAtEvaluationTime = JSON.parse(JSON.stringify(runDocs.get(runId)!.governanceRecord));
    expect(recordAtEvaluationTime.humanReview.status).toBe("unreviewed");

    // 2. A reviewer concurrently approves the run — modeled as its OWN
    //    narrow, field-path write (exactly the same pattern this design
    //    requires for any future human-review persistence path), never a
    //    whole-record write.
    await mockAdminDb.collection("runs").doc(runId).update({
      "governanceRecord.humanReview": { status: "approved", reviewerId: "u1", reviewerName: "Reviewer One" },
      "governanceRecord.updatedAt": "2026-07-29T12:30:00.000Z",
    });

    // 3. The automated-governance persistence write executes AFTER the
    //    reviewer's write, using data computed from the STALE
    //    (pre-approval) snapshot read in step 1 — the realistic race this
    //    regression exists to prove is safe.
    const outcome = await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T12:31:00.000Z");
    expect(outcome).toEqual({ saved: true });

    // 4. The reviewer's approval MUST survive — only automatedGovernance
    //    and updatedAt changed as a result of step 3.
    const finalRecord = runDocs.get(runId)!.governanceRecord;
    expect(finalRecord.humanReview).toEqual({ status: "approved", reviewerId: "u1", reviewerName: "Reviewer One" });
    expect(finalRecord.decisionReceipt).toEqual({ conclusion: "original conclusion" });
    expect(finalRecord.schemaId).toBe("decision_support");
    expect(finalRecord.createdAt).toBe("2026-07-29T10:00:00.000Z");
    expect(finalRecord.automatedGovernance).toEqual(automatedGovernance());
    expect(finalRecord.updatedAt).toBe("2026-07-29T12:31:00.000Z");
  });

  it("the reverse ordering is equally safe — an automated write followed by a concurrent human-review write leaves automatedGovernance intact", async () => {
    const runId = "run-concurrency-reverse";
    runDocs.set(runId, {
      governanceRecord: {
        schemaId: "decision_support",
        humanReview: { status: "unreviewed" },
        decisionReceipt: { conclusion: "original conclusion" },
      },
    });

    await persistAutomatedGovernanceUpdate(runId, automatedGovernance(), "2026-07-29T12:00:00.000Z");
    await mockAdminDb.collection("runs").doc(runId).update({
      "governanceRecord.humanReview": { status: "rejected", reviewerId: "u2" },
      "governanceRecord.updatedAt": "2026-07-29T12:05:00.000Z",
    });

    const finalRecord = runDocs.get(runId)!.governanceRecord;
    expect(finalRecord.automatedGovernance).toEqual(automatedGovernance());
    expect(finalRecord.humanReview).toEqual({ status: "rejected", reviewerId: "u2" });
    expect(finalRecord.decisionReceipt).toEqual({ conclusion: "original conclusion" });
  });
});
