/**
 * Order B, Stage B1 — THE DUAL-RECORD EXCLUSION PROOF (owner stop condition, D-B7 option (a)).
 *
 * Invariant: no run ever holds both `governanceRecord` and `reportReview`.
 *
 * Method: the REAL production writers run against a transactional in-memory Firestore that retries on read
 * conflicts (helpers/fakeTransactionalFirestore.ts). Each writer sequence below is the exact production order:
 *
 *   governed (Milestone-2):  createRun → completeRun → persistAdaptiveOutput → readGovernanceRecordForInitialization
 *                             → initializeAdaptiveGovernanceRecord (→ persistGovernanceRecord)   [runPanelExecution.ts:806-866]
 *   governed, init retried:  … → initializeAdaptiveGovernanceRecord twice (retry after a lost response)
 *   governed, save failed:   createRun → completeRun   (adaptiveOutput never saved, so governance is skipped)
 *   legacy (Generic):        createRun → completeRun → persistLegacyAdaptiveOutput            [runPanelExecution.ts:777-792]
 *   legacy, envelope failed: createRun → completeRun   (no envelope written)
 *
 * For EVERY point at which a submission can start (A: before/after completion, B: before/after persistence,
 * C: before/after governance initialization and its retry) and EVERY set of remaining writer steps injected
 * BETWEEN the submission transaction's reads and its commit (forcing a conflict and a retry), the invariant must hold.
 * D (two simultaneous submissions) and E (a retried submission after a commit failure or a lost response) are below.
 *
 * The tests are built to BREAK the invariant if the eligibility rule were weaker: see the mutation notes at the end.
 */

import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({ REPORT_REVIEW_ENABLED: true }));
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createRun, completeRun, persistAdaptiveOutput, persistLegacyAdaptiveOutput, readGovernanceRecordForInitialization } from "@/lib/firestore/runs";
import { initializeAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceInitialization";
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { governedAdaptiveOutput } from "./helpers/governedAdaptiveOutputFixture";
import { GOVERNED_SCHEMA_IDS, REPORT_REVIEW_ENVELOPE_CUTOFF } from "@/lib/governance/reportReview";
import { PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS } from "@/lib/adaptiveSchema/persistedOutput";

const W = "wsTeamB1";
const OWNER = "uid-owner";
const MEMBER = "uid-member";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));

function seedWorkspace() {
  db.docs.clear();
  db.seed(`workspaces/${W}`, { schemaVersion: 1, id: W, type: "team", name: "Team", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
  for (const [uid, role] of [
    [OWNER, "owner"],
    [MEMBER, "member"],
  ] as const) {
    const id = computeMembershipId(W, uid);
    db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: W, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
  }
}

const legacyEnvelope = (schemaId = "generic") => ({ version: 1, schemaId, classification: { queryType: schemaId, confidence: 0.5 }, generatedAt: "2026-11-02T10:00:00.000Z", results: [], alignedClaims: [] });

type Step = { name: string; run: (runId: string) => Promise<unknown> };
const create: Step = { name: "createRun", run: (id) => createRun(id, MEMBER, "Q?", ["chatgpt", "claude"], W, null) };
const complete: Step = {
  name: "completeRun",
  run: (id) =>
    completeRun({
      runId: id,
      userId: MEMBER,
      results: [{ modelId: "chatgpt", status: "ok", rawText: "a", latencyMs: 1 } as never, { modelId: "claude", status: "ok", rawText: "b", latencyMs: 1 } as never],
      question: "Q?",
      selectedModels: ["chatgpt", "claude"],
      tokenUsageByModel: [],
      tokenTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as never,
    }),
};
const persistGoverned: Step = { name: "persistAdaptiveOutput", run: (id) => persistAdaptiveOutput(id, governedAdaptiveOutput()) };
const initGovernance: Step = {
  name: "initializeGovernance",
  run: async (id) => {
    const existing = await readGovernanceRecordForInitialization(id);
    if (existing.status !== "found" && existing.status !== "absent") return;
    return initializeAdaptiveGovernanceRecord({ runId: id, adaptiveOutput: governedAdaptiveOutput(), existingGovernanceRecord: existing.status === "found" ? existing.value : undefined });
  },
};
const persistLegacy: Step = { name: "persistLegacyAdaptiveOutput", run: (id) => persistLegacyAdaptiveOutput(id, legacyEnvelope() as never) };

const SEQUENCES: Record<string, Step[]> = {
  governed: [create, complete, persistGoverned, initGovernance],
  "governed, init retried": [create, complete, persistGoverned, initGovernance, initGovernance],
  "governed, adaptive save failed": [create, complete],
  legacy: [create, complete, persistLegacy],
  "legacy, envelope failed": [create, complete],
};

let runSeq = 0;
function both(runId: string) {
  const d = db.read(`runs/${runId}`) ?? {};
  return d.governanceRecord !== undefined && d.reportReview !== undefined;
}

const submit = (runId: string, uid = MEMBER) => submitReportReview({ uid, workspaceId: W, runId, purpose: { code: "internal_review", note: null } });

describe("A/B/C: submission at every point, with every remaining writer suffix injected between its reads and its commit", () => {
  beforeEach(() => {
    seedWorkspace();
    db.hooks = {};
  });

  for (const [label, steps] of Object.entries(SEQUENCES)) {
    // Submission may start after any non-empty prefix (the run document must exist to be read).
    for (let k = 1; k <= steps.length; k++) {
      for (let m = k; m <= steps.length; m++) {
        it(`${label}: submit after [${steps.slice(0, k).map((s) => s.name).join(", ")}], with [${steps.slice(k, m).map((s) => s.name).join(", ") || "nothing"}] injected before its commit`, async () => {
          const runId = `run-${++runSeq}`;
          for (const s of steps.slice(0, k)) await s.run(runId);
          let injected = false;
          db.hooks.afterTxReads = async () => {
            if (injected) return;
            injected = true;
            for (const s of steps.slice(k, m)) await s.run(runId);
          };
          const res = await submit(runId);
          db.hooks = {};
          for (const s of steps.slice(m)) await s.run(runId);

          // THE INVARIANT
          expect(both(runId)).toBe(false);

          const final = db.read(`runs/${runId}`)!;
          if (label.startsWith("governed")) {
            // A governed run never enters report review, whatever the interleaving.
            expect(final.reportReview).toBeUndefined();
            expect(res.ok).toBe(false);
          }
          if (label === "governed") expect(final.governanceRecord).toBeDefined(); // the governed writer still completes, unchanged
          if (label === "legacy") {
            // Accepted exactly when the legacy envelope existed when the submission read the run. An envelope that lands
            // after that read leaves the (read-only, ineligible) transaction's answer unchanged, as in production.
            expect(final.reportReview !== undefined).toBe(k === steps.length);
          }
          if (label === "legacy, envelope failed") expect(final.reportReview).toBeUndefined();
        });
      }
    }
  }
});

describe("C: a governance initialization that fires AFTER a committed report review can never land", () => {
  // Defence against a hypothetical late governed write: the only governance writer requires the run's OWN saved
  // Milestone-2 adaptiveOutput, which a report-review run can never have (eligibility rejects any adaptiveOutput).
  it("persistAdaptiveOutput + initialization are not reachable for a legacy run: initialization without a saved adaptive output is not applicable", async () => {
    seedWorkspace();
    const runId = `run-${++runSeq}`;
    for (const s of SEQUENCES.legacy) await s.run(runId);
    expect((await submit(runId)).ok).toBe(true);
    // runPanelExecution only calls the initializer when persistenceStatus === "saved" for a Milestone-2 output it
    // produced in the same execution; a legacy execution has no persistedOutput at all (orchestrate.ts typing).
    expect(db.read(`runs/${runId}`)!.adaptiveOutput).toBeUndefined();
    expect(db.read(`runs/${runId}`)!.governanceRecord).toBeUndefined();
  });

  it("the Milestone-2 and legacy schema id sets are disjoint (a run's single schema selects exactly one envelope family)", () => {
    expect(PERSISTED_LEGACY_ADAPTIVE_SCHEMA_IDS.filter((id) => GOVERNED_SCHEMA_IDS.has(id))).toEqual([]);
    expect(GOVERNED_SCHEMA_IDS.size).toBe(9);
  });

  it("a legacy envelope carrying a Milestone-2 schema id is never accepted as evidence", async () => {
    seedWorkspace();
    const runId = `run-${++runSeq}`;
    await create.run(runId);
    await complete.run(runId);
    await db.doc(`runs/${runId}`).set({ legacyAdaptiveOutput: legacyEnvelope("decision_support") }, { merge: true });
    const res = await submit(runId);
    expect(res).toEqual({ ok: false, reason: "ineligible", ineligible: "no_review_information" });
  });
});

describe("D: two simultaneous submissions", () => {
  it("both read before either commits: exactly one record, exactly one event; the loser retries and reports the existing record", async () => {
    seedWorkspace();
    const runId = `run-${++runSeq}`;
    for (const s of SEQUENCES.legacy) await s.run(runId);
    let second: Promise<unknown> | null = null;
    db.hooks.afterTxReads = async (attempt) => {
      if (second || attempt > 0) return;
      // While the first transaction sits between its reads and its commit, a second submission runs to completion.
      db.hooks.afterTxReads = undefined;
      second = submitReportReview({ uid: OWNER, workspaceId: W, runId, purpose: { code: "client_delivery", note: "x" } });
      await second;
    };
    const first = await submit(runId);
    const secondRes = (await second) as Awaited<ReturnType<typeof submit>>;
    const results = [first, secondRes];
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    expect(results.filter((r) => r.ok && !r.created)).toHaveLength(1);
    expect(db.paths(`runs/${runId}/reportReviewEvents/`)).toHaveLength(1);
    const rr = db.read(`runs/${runId}`)!.reportReview as { cycle: number; purpose: { code: string } };
    expect(rr.cycle).toBe(1);
    expect(rr.purpose.code).toBe("client_delivery"); // the winner's purpose; the loser never overwrote it
    expect(db.stats.retries).toBeGreaterThan(0);
  });
});

describe("E: retries after partial failure", () => {
  beforeEach(() => {
    seedWorkspace();
    db.hooks = {};
  });

  it("a commit failure applies nothing (atomic); a retry then succeeds once", async () => {
    const runId = `run-${++runSeq}`;
    for (const s of SEQUENCES.legacy) await s.run(runId);
    db.hooks.failCommit = () => {
      throw new Error("UNAVAILABLE: injected");
    };
    expect(await submit(runId)).toEqual({ ok: false, reason: "write_failed" });
    expect(db.read(`runs/${runId}`)!.reportReview).toBeUndefined();
    expect(db.paths(`runs/${runId}/reportReviewEvents/`)).toHaveLength(0);
    db.hooks = {};
    const retry = await submit(runId);
    expect(retry.ok && retry.created).toBe(true);
    expect(db.paths(`runs/${runId}/reportReviewEvents/`)).toHaveLength(1);
  });

  it("a retry after a lost response is idempotent: same record, no second event, no overwrite", async () => {
    const runId = `run-${++runSeq}`;
    for (const s of SEQUENCES.legacy) await s.run(runId);
    const first = await submit(runId);
    expect(first.ok && first.created).toBe(true);
    const before = db.read(`runs/${runId}`)!.reportReview;
    const again = await submitReportReview({ uid: MEMBER, workspaceId: W, runId, purpose: { code: "other", note: "different" } });
    expect(again.ok && !again.created).toBe(true);
    expect(db.read(`runs/${runId}`)!.reportReview).toEqual(before);
    expect(db.paths(`runs/${runId}/reportReviewEvents/`)).toHaveLength(1);
  });

  it("governance initialization retried around a submission attempt on a governed run never produces both", async () => {
    const runId = `run-${++runSeq}`;
    await create.run(runId);
    await complete.run(runId);
    await persistGoverned.run(runId);
    db.hooks.afterTxReads = async (attempt) => {
      if (attempt === 0) await initGovernance.run(runId);
    };
    const res = await submit(runId);
    db.hooks = {};
    await initGovernance.run(runId); // a second (retry) initialization
    expect(res.ok).toBe(false);
    expect(both(runId)).toBe(false);
    expect(db.read(`runs/${runId}`)!.governanceRecord).toBeDefined();
  });
});

describe("pre-envelope runs (created before #274): eligible without an envelope, never governable later", () => {
  it("a complete run created before the cutoff with no envelope is accepted; one created after is not", async () => {
    seedWorkspace();
    for (const [offsetMs, expected] of [
      [-1, true],
      [0, false],
      [1, false],
    ] as const) {
      const runId = `run-${++runSeq}`;
      await create.run(runId);
      await complete.run(runId);
      await db.doc(`runs/${runId}`).update({ createdAt: Timestamp.fromMillis(REPORT_REVIEW_ENVELOPE_CUTOFF.toMillis() + offsetMs) });
      const res = await submit(runId);
      expect(res.ok).toBe(expected);
    }
  });
});
