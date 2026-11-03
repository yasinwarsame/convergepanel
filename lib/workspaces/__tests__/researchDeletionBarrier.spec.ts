/**
 * Owner decision 2026-11-03: research deletion integrity. Once a deletion is requested, no application writer may
 * recreate the run's content or anything derived from it. This spec checks every guarded writer in four states:
 *   - tombstone: `runDeletionJobs/{R}` exists, even with no run document;
 *   - mark: the run is marked for deletion;
 *   - missing: no run document, including runs deleted before tombstones existed;
 *   - normal: an ordinary writable run, where the writer behaves exactly as before.
 * It also checks the interleaving where the writer starts BEFORE the deletion and tries to commit AFTER it.
 */
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId: "pro" }) }));
jest.mock("@/lib/governance/governancePolicyStore", () => ({ loadGovernancePolicy: async () => ({ policyVersion: 7 }) }));
jest.mock("@/lib/governance/evaluateGovernance", () => ({
  evaluateGovernance: () => ({ status: "needs_review", reasons: ["low consensus"], meta: { scoreFamily: "f", scoreThresholdsInEffect: { review: 70 } } }),
}));
jest.mock("@/lib/governance/policyEngine", () => ({ DEFAULT_POLICIES: [], evaluatePolicies: () => ({ blocked: false, requiresReview: false, triggered: [] }) }));

import {
  persistAdaptiveOutput,
  persistLegacyAdaptiveOutput,
  persistGovernanceRecord,
  writeAdaptiveGovernanceEvent,
  writeAdaptiveHumanReviewEvent,
  createAdaptiveHumanReviewHistory,
  createAdaptiveHumanReviewAssignmentHistory,
  createAdaptivePanelFinalizationHistory,
  createAdaptivePanelOverrideHistory,
  writeAdaptivePanelFinalizationGovernanceEvent,
  writeAdaptivePanelOverrideGovernanceEvent,
} from "@/lib/firestore/runs";
import { createAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { createAdaptiveExportRecord, markAdaptiveExportReady, markAdaptiveExportFailed, supersedeOlderAdaptiveExports } from "@/lib/firestore/adaptiveExports";
import { evaluateAndStoreGovernance } from "@/lib/governance/evaluateAndStore";
import { applyTeamGovernancePipeline } from "@/lib/governance/teamGovernancePipeline";
import { saveClaimVerification } from "@/lib/firestore/verifications";
import { deleteResearchRun, findResearchDeletionOrphans } from "@/lib/firestore/researchDeletion";
import { assertResearchWritable, isResearchWriteRefusedError, RESEARCH_DELETION_TOMBSTONE_COLLECTION, runResearchWrite } from "@/lib/firestore/researchDeletionBarrier";

const R = "run-barrier";
const SECRET = "SECRET research text";

type State = "tombstone" | "mark" | "missing" | "normal";
function seedState(state: State) {
  db.docs.clear();
  db.hooks = {};
  db.seed("users/u1", { teamId: "team1" });
  db.seed("teams/team1", { name: "T", members: [], settings: { minimumConsensusForAction: 60, flagThreshold: 50 } });
  if (state === "missing") return;
  if (state === "tombstone") {
    db.seed(`${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`, { runId: R, state: "complete" });
    return;
  }
  db.seed(`runs/${R}`, { userId: "u1", userEmail: "u1@x.test", question: SECRET, status: "complete", ...(state === "mark" ? { deletion: { state: "pending" } } : {}) });
}
/** Every stored document that is derived from R (the tombstone itself is not content). */
function derived(): string[] {
  return Array.from(db.docs.entries())
    .filter(([p, s]) => p === `runs/${R}` || p.startsWith(`runs/${R}/`) || (!p.startsWith(`${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/`) && (s.data as Record<string, unknown>).runId === R) || ((s.data as Record<string, any>).origin?.runId === R))
    .map(([p]) => p)
    .sort();
}
const exportInput = () => ({
  runId: R,
  exportId: "exp-1",
  record: { exportMetadata: { exportId: "exp-1", schemaId: "generic" }, artifactStatus: "generating", reportSnapshot: { body: SECRET } } as never,
});

type Writer = { name: string; run: () => Promise<unknown>; ok: (r: any) => boolean; refused: (r: any) => boolean };
const WRITERS: Writer[] = [
  { name: "persistAdaptiveOutput", run: () => persistAdaptiveOutput(R, { version: 1, results: [SECRET] } as never), ok: (r) => r.saved === true, refused: (r) => r.saved === false && r.reason === "write_failed" },
  { name: "persistLegacyAdaptiveOutput", run: () => persistLegacyAdaptiveOutput(R, { version: 1, results: [SECRET] }), ok: (r) => r.saved === true, refused: (r) => r.saved === false && r.reason === "write_failed" },
  { name: "persistGovernanceRecord", run: () => persistGovernanceRecord(R, { schemaId: "generic", receipt: SECRET } as never), ok: (r) => r.saved === true, refused: (r) => r.saved === false && r.reason === "write_failed" },
  { name: "writeAdaptiveGovernanceEvent", run: () => writeAdaptiveGovernanceEvent(R, { status: "needs_review", reasons: [SECRET], policyVersion: 1 } as never, "t"), ok: (r) => r.written === true, refused: (r) => r.written === false && r.reason === "write_failed" },
  { name: "writeAdaptiveHumanReviewEvent", run: () => writeAdaptiveHumanReviewEvent({ runId: R, teamId: null, schemaId: "generic" as never, answerShape: "x" as never, reviewerId: "u2", prevStatus: "pending" as never, nextStatus: "approved" as never, at: "t" }), ok: (r) => r.written === true, refused: (r) => r.written === false },
  { name: "createAdaptiveHumanReviewHistory", run: () => createAdaptiveHumanReviewHistory(R, { decisionId: "d1", comment: SECRET } as never), ok: (r) => r.status === "recorded", refused: (r) => r.status === "failed" },
  { name: "createAdaptiveHumanReviewAssignmentHistory", run: () => createAdaptiveHumanReviewAssignmentHistory(R, { eventId: "e1" } as never), ok: (r) => r.status === "recorded", refused: (r) => r.status === "failed" },
  { name: "createAdaptivePanelFinalizationHistory", run: () => createAdaptivePanelFinalizationHistory(R, { eventId: "pf1" } as never), ok: (r) => r.status === "recorded", refused: (r) => r.status === "failed" },
  { name: "createAdaptivePanelOverrideHistory", run: () => createAdaptivePanelOverrideHistory(R, { eventId: "po1" } as never), ok: (r) => r.status === "recorded", refused: (r) => r.status === "failed" },
  { name: "writeAdaptivePanelFinalizationGovernanceEvent", run: () => writeAdaptivePanelFinalizationGovernanceEvent({ runId: R, teamId: null, schemaId: "generic", answerShape: "x", finalStatus: "approved", finalDecisionId: "fd1", aggregationPolicyVersion: 1, supportingReviewerCount: 2, actorUserId: "u2", finalizedAt: "t" } as never), ok: (r) => r.status === "recorded", refused: (r) => r.status === "failed" },
  { name: "writeAdaptivePanelOverrideGovernanceEvent", run: () => writeAdaptivePanelOverrideGovernanceEvent({ runId: R, teamId: null, schemaId: "generic", answerShape: "x", finalStatus: "approved", finalDecisionId: "fd2", overrideByUserId: "u2", finalizedAt: "t" } as never), ok: (r) => r.status === "recorded", refused: (r) => r.status === "failed" },
  { name: "createAdaptiveTeamRunProjection", run: () => createAdaptiveTeamRunProjection({ teamId: "team1", runId: R, conclusion: SECRET } as never), ok: (r) => r.status === "created", refused: (r) => r.status === "write_failed" },
  { name: "createAdaptiveExportRecord (Order 6 exception)", run: () => createAdaptiveExportRecord(exportInput()), ok: (r) => r.ok === true && r.reportVersion === 1, refused: (r) => r.ok === false && r.reason === "write_failed" },
  { name: "evaluateAndStoreGovernance (runs)", run: () => evaluateAndStoreGovernance({ runId: R, collection: "runs", input: { question: SECRET, consensusScore: 40, runType: "research" } as never, ownerUid: "u1" }), ok: (r) => r?.governanceStatus === "needs_review", refused: (r) => r === null },
  {
    name: "applyTeamGovernancePipeline (research run)",
    run: () => applyTeamGovernancePipeline({ uid: "u1", userEmail: "u1@x.test", consensusSummary: {} as never, consensusScore: 90, type: "research", query: SECRET, auditBundle: {} as never, runId: R }),
    ok: (r) => typeof r.teamRunId === "string",
    refused: (r) => r.teamRunId === undefined,
  },
  {
    name: "saveClaimVerification (origin-linked)",
    run: () => saveClaimVerification("vcl-1", { userId: "u1", claim: SECRET, origin: { type: "deep_research_claim", runId: R, claimId: "c1" }, evidenceSources: [] } as never).then(() => "saved", (e) => (isResearchWriteRefusedError(e) ? "refused" : `error:${e}`)),
    ok: (r) => r === "saved",
    refused: (r) => r === "refused",
  },
];

describe("every guarded writer refuses a deleted, deleting or missing run, and writes nothing", () => {
  for (const w of WRITERS) {
    for (const state of ["tombstone", "mark", "missing"] as const) {
      it(`${w.name} — ${state}`, async () => {
        seedState(state);
        const before = derived();
        const r = await w.run();
        expect(w.refused(r)).toBe(true);
        expect(derived()).toEqual(before); // nothing created or changed
        if (state !== "missing" && state !== "tombstone") expect(db.read(`runs/${R}`)).toEqual(expect.objectContaining({ deletion: { state: "pending" } }));
        expect(db.paths("admin_audit_logs/")).toEqual([]);
        expect(db.paths("teamRuns/")).toEqual([]);
      });
    }
    it(`${w.name} — normal run: behaves as before`, async () => {
      seedState("normal");
      const before = JSON.stringify(Array.from(db.docs.entries()).map(([p, s]) => [p, s.data]));
      const r = await w.run();
      expect(w.ok(r)).toBe(true);
      expect(JSON.stringify(Array.from(db.docs.entries()).map(([p, s]) => [p, s.data]))).not.toEqual(before); // it wrote
    });
  }
});

describe("normal-run documents are the same documents the writers wrote before", () => {
  it("persistAdaptiveOutput merges into the run", async () => {
    seedState("normal");
    await persistAdaptiveOutput(R, { version: 1 } as never);
    expect(db.read(`runs/${R}`)).toEqual(expect.objectContaining({ question: SECRET, adaptiveOutput: { version: 1 } }));
  });
  it("history create is still exclusive: a second create is already_exists and the first entry is kept", async () => {
    seedState("normal");
    expect(await createAdaptiveHumanReviewHistory(R, { decisionId: "d1", n: 1 } as never)).toEqual({ status: "recorded" });
    expect(await createAdaptiveHumanReviewHistory(R, { decisionId: "d1", n: 2 } as never)).toEqual({ status: "already_exists" });
    expect(db.read(`runs/${R}/humanReviewHistory/d1`)).toEqual({ decisionId: "d1", n: 1 });
  });
  it("evaluateAndStoreGovernance writes status + one event (one guarded transaction) and one audit row (its own guarded transaction); question cut to 200, then trimmed, as writeAuditEvent did", async () => {
    seedState("normal");
    await evaluateAndStoreGovernance({ runId: R, collection: "runs", input: { question: `  ${"q".repeat(300)}  `, consensusScore: 40, runType: "research" } as never, ownerUid: "u1" });
    expect(db.read(`runs/${R}`)).toEqual(expect.objectContaining({ governanceStatus: "needs_review", governanceReasons: ["low consensus"] }));
    expect(db.paths(`runs/${R}/governanceEvents/`)).toHaveLength(1);
    const rows = db.paths("admin_audit_logs/");
    expect(rows).toHaveLength(1);
    const row = db.read(rows[0])!;
    expect(row).toEqual(expect.objectContaining({ runId: R, action: "evaluated", runOwnerEmail: "u1@x.test", question: "q".repeat(198), policyVersion: 7 }));
    expect(typeof row.at).toBe("string");
  });
  it("non-run governance (a verification) still uses the old path unchanged (no barrier)", async () => {
    seedState("missing");
    db.seed("verifications/v1", { userId: "u1", claim: "c" });
    expect(await evaluateAndStoreGovernance({ runId: "v1", collection: "verifications", input: { question: "c", consensusScore: 40, runType: "verification" } as never, ownerUid: "u1" })).toEqual({ governanceStatus: "needs_review" });
    expect(db.read("verifications/v1")).toEqual(expect.objectContaining({ governanceStatus: "needs_review" }));
  });
  it("a verification-only Team projection (no runId) is unchanged", async () => {
    seedState("missing");
    const r = await applyTeamGovernancePipeline({ uid: "u1", userEmail: "u1@x.test", consensusSummary: {} as never, consensusScore: 90, type: "verification", query: "c", auditBundle: {} as never, verificationId: "v1" });
    expect(typeof r.teamRunId).toBe("string");
    expect(db.paths("teamRuns/")).toHaveLength(1);
  });
  it("a non-origin claim verification is saved without any run check", async () => {
    seedState("missing");
    await saveClaimVerification("vcl-2", { userId: "u1", claim: "c" } as never);
    expect(db.read("verifications/vcl-2")).toEqual(expect.objectContaining({ claim: "c" }));
  });
});

describe("export lifecycle (Order 6 frozen writer, exact-file exception)", () => {
  it("normal: create → ready → supersede older ready exports, exactly as before", async () => {
    seedState("normal");
    db.seed(`runs/${R}/exports/exp-0`, { artifactStatus: "ready" });
    expect(await createAdaptiveExportRecord(exportInput())).toEqual({ ok: true, reportVersion: 1 });
    expect(await markAdaptiveExportReady(R, "exp-1", "hash1")).toEqual({ ok: true });
    expect(db.read(`runs/${R}/exports/exp-1`)).toEqual(expect.objectContaining({ artifactStatus: "ready", exportMetadata: expect.objectContaining({ fileHash: "hash1", exportId: "exp-1", finalReportVersion: 1 }) }));
    expect(await supersedeOlderAdaptiveExports(R, "exp-1")).toEqual({ ok: true });
    expect(db.read(`runs/${R}/exports/exp-0`)).toEqual({ artifactStatus: "superseded" });
    expect(db.read(`runs/${R}/exports/exp-1`)!.artifactStatus).toBe("ready");
    expect(await markAdaptiveExportFailed(R, "exp-1", "boom")).toEqual({ ok: true });
  });
  it("a render that finishes after the deletion writes nothing (ready / failed / supersede all refused)", async () => {
    seedState("normal");
    await createAdaptiveExportRecord(exportInput());
    expect(await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" });
    expect(await markAdaptiveExportReady(R, "exp-1", "h")).toEqual({ ok: false, reason: "write_failed" });
    expect(await markAdaptiveExportFailed(R, "exp-1", "x")).toEqual({ ok: false, reason: "write_failed" });
    expect(await supersedeOlderAdaptiveExports(R, "exp-1")).toEqual({ ok: false, reason: "write_failed" });
    expect(derived()).toEqual([]);
  });
});

describe("interleaving: the writer starts BEFORE the deletion and commits AFTER it", () => {
  // The hook runs after the writer's transaction has done its reads and before it commits. The deletion runs there
  // to completion, so the writer's commit happens after the deletion has finished.
  const RACERS = WRITERS.filter((w) => !w.name.startsWith("applyTeam") && !w.name.startsWith("saveClaim"));
  for (const w of RACERS) {
    it(`${w.name}: refused on retry, nothing resurrected, deletion verified, no orphans`, async () => {
      seedState("normal");
      let fired = false;
      db.hooks.afterTxReads = async () => {
        if (fired) return;
        fired = true;
        const hooks = db.hooks;
        db.hooks = {};
        expect(await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" });
        db.hooks = hooks;
      };
      const r = await w.run();
      expect(fired).toBe(true);
      expect(w.refused(r)).toBe(true);
      expect(derived()).toEqual([]);
      expect(db.read(`${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`)).toEqual(expect.objectContaining({ state: "complete" }));
      db.hooks = {};
      expect(await findResearchDeletionOrphans()).toEqual({ orphanRunIds: [], unfinishedJobs: [] });
    });
  }
  it("post-deletion retries of every writer fail closed and the tombstone persists", async () => {
    seedState("normal");
    expect(await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" });
    for (let i = 0; i < 3; i++) for (const w of WRITERS) expect(w.refused(await w.run())).toBe(true);
    expect(derived()).toEqual([]);
    expect(db.read(`${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`)).toBeDefined();
    expect(await findResearchDeletionOrphans()).toEqual({ orphanRunIds: [], unfinishedJobs: [] });
  });
});

describe("the barrier itself", () => {
  it("reuse of a deleted id is refused even when a run document is recreated under it", async () => {
    seedState("tombstone");
    db.seed(`runs/${R}`, { userId: "u1", question: "new" });
    await expect(db.runTransaction((tx) => assertResearchWritable(tx as never, db as never, R))).rejects.toMatchObject({ code: "research_write_refused", refusal: "deleted" });
  });
  it("rejects malformed run ids (empty, path-like) as missing", async () => {
    seedState("normal");
    for (const id of ["", "a/b", `${R}/exports`]) await expect(db.runTransaction((tx) => assertResearchWritable(tx as never, db as never, id))).rejects.toMatchObject({ refusal: "missing" });
  });
  it("a path-like id that names an EXISTING subtree document (no deletion mark, no tombstone at that path) is still refused", async () => {
    // Without the id check, `runs/${R}/exports/e1` would be read as "the run" (it exists and carries no deletion mark),
    // and `runDeletionJobs/${R}/exports/e1` as "its tombstone" (absent), so the write would be allowed.
    seedState("normal");
    db.seed(`runs/${R}/exports/e1`, { reportSnapshot: { body: SECRET } });
    await expect(db.runTransaction((tx) => assertResearchWritable(tx as never, db as never, `${R}/exports/e1`))).rejects.toMatchObject({ refusal: "missing" });
  });
  it("the tombstone state does not matter: in_progress and failed jobs block writes too", async () => {
    for (const state of ["in_progress", "failed"]) {
      seedState("normal");
      db.seed(`${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`, { state });
      await expect(runResearchWrite(db as never, R, () => undefined)).rejects.toMatchObject({ refusal: "deleted" });
    }
  });
  it("the deletion workflow creates the tombstone before anything else and never deletes it", async () => {
    seedState("normal");
    const order: string[] = [];
    db.hooks.failWrite = (w) => void order.push(`${w.kind}:${w.path}`);
    await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" });
    expect(order[0]).toBe(`merge:${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`);
    expect(order.some((o) => o === `delete:${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`)).toBe(false);
  });
  it("a deletion interrupted right after the tombstone already blocks every writer", async () => {
    seedState("normal");
    db.hooks.failWrite = (w) => {
      if (w.path === `runs/${R}` && w.kind === "update") throw new Error("injected: crash before mark");
    };
    expect(await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "incomplete", step: "mark" });
    db.hooks = {};
    for (const w of WRITERS) expect(w.refused(await w.run())).toBe(true);
    expect(await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" })).toMatchObject({ status: "deleted" }); // recovery
    expect(derived()).toEqual([]);
  });
});

// ── Review M-1: the transactional review / panel / vote / assignment writers ("Category C") ───────────────────────
import {
  submitAdaptiveHumanReview,
  submitAdaptiveHumanReviewAssignment,
  submitAdaptiveHumanReviewPanel,
  cancelAdaptiveHumanReviewPanel,
  submitAdaptiveHumanReviewVote,
  finalizeAdaptiveHumanReviewPanel,
  overrideAdaptiveHumanReviewPanel,
} from "@/lib/firestore/runs";

describe("review M-1: every transactional review writer refuses a deleted or deleting run, in its own transaction", () => {
  const C_WRITERS: Array<[string, () => Promise<any>]> = [
    ["submitAdaptiveHumanReview (decision)", () => submitAdaptiveHumanReview({ runId: R, update: { status: "approved", comment: SECRET } as never, reviewerId: "u2", reviewerName: "R", teamId: null } as never)],
    ["submitAdaptiveHumanReviewAssignment", () => submitAdaptiveHumanReviewAssignment({ runId: R, teamId: null, newReviewerUserId: "u2", actorUserId: "u1", expectedRevision: 0 } as never)],
    ["submitAdaptiveHumanReviewPanel", () => submitAdaptiveHumanReviewPanel({ runId: R, teamId: "team1", reviewerUserIds: ["u2", "u3"], actorUserId: "u1" } as never)],
    ["cancelAdaptiveHumanReviewPanel", () => cancelAdaptiveHumanReviewPanel({ runId: R, teamId: "team1", actorUserId: "u1" } as never)],
    ["submitAdaptiveHumanReviewVote (carries the comment)", () => submitAdaptiveHumanReviewVote({ runId: R, teamId: "team1", reviewerUserId: "u2", vote: { status: "approved", comment: SECRET } } as never)],
    ["finalizeAdaptiveHumanReviewPanel", () => finalizeAdaptiveHumanReviewPanel({ runId: R, teamId: "team1", actorUserId: "u1" } as never)],
    ["overrideAdaptiveHumanReviewPanel", () => overrideAdaptiveHumanReviewPanel({ runId: R, teamId: "team1", actorUserId: "u1", justification: SECRET } as never)],
  ];
  for (const [name, call] of C_WRITERS) {
    it(`${name}: tombstone or mark → run_missing, nothing written; control: without them the barrier does not refuse`, async () => {
      for (const state of ["tombstone-with-run", "mark"] as const) {
        seedState("normal");
        if (state === "mark") db.seed(`runs/${R}`, { userId: "u1", question: SECRET, deletion: { state: "pending" } });
        else db.seed(`${RESEARCH_DELETION_TOMBSTONE_COLLECTION}/${R}`, { state: "in_progress" });
        db.writeLog = [];
        expect(await call()).toEqual(expect.objectContaining({ ok: false, reason: "run_missing" }));
        expect(db.writeLog).toEqual([]);
      }
      seedState("normal");
      const control = await call();
      expect(control?.reason).not.toBe("run_missing"); // the refusal above came from the barrier, not from the fixture
    });
  }

  it("the reviewer's scenario: a writer that commits between the deletion's sweep and its pre-verify is refused, and the deletion completes", async () => {
    seedState("normal");
    db.seed(`runs/${R}/exports/e1`, { body: SECRET }); // something for the sweep to delete
    // The deletion's first step after the subtree sweep is the Workspace-audit redaction query. The writer is injected
    // there, once: after the tombstone, mark and sweep, and before the pre-verify.
    const realCollection = db.collection.bind(db);
    let injected: any = null;
    (db as any).collection = (name: string) => {
      const col = realCollection(name);
      if (name !== "workspaceMembershipEvents" || injected !== null) return col;
      return {
        where: (...w: unknown[]) => {
          const q = (col.where as any)(...w);
          return {
            get: async () => {
              if (injected === null) {
                expect(db.paths(`runs/${R}/`)).toEqual([]); // the sweep has run
                injected = await submitAdaptiveHumanReviewAssignment({ runId: R, teamId: null, newReviewerUserId: "u2", actorUserId: "u1", expectedRevision: 0 } as never);
              }
              return q.get();
            },
          };
        },
      };
    };
    try {
      const res = await deleteResearchRun({ runId: R, actorUid: "sys", reason: "admin_delete" });
      expect(injected).toEqual(expect.objectContaining({ ok: false, reason: "run_missing" }));
      expect(res).toMatchObject({ status: "deleted" }); // not "incomplete": the writer could not stall it
      expect(derived()).toEqual([]);
    } finally {
      (db as any).collection = realCollection;
    }
  });
});
