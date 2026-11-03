/**
 * Step 6 D5.1 — persistence of System A score-semantics provenance.
 *
 * `evaluateAndStoreGovernance` runs for real against an in-memory Firestore
 * fake, with the REAL audit writer (`writeAuditEvent`) behind it. Proven here:
 *   - the parent document's status and reasons are exactly the evaluator's,
 *     and `governanceMeta` gains `scoreFamily` + `scoreThresholdsInEffect`;
 *   - the append-only `governanceEvents` entry carries the same provenance
 *     beside every field it carried before — the parent is current state and a
 *     re-evaluation replaces it, the event is the history;
 *   - the `admin_audit_logs` row carries it too, with its existing fields;
 *   - legacy-shaped documents and events without the fields stay readable.
 */
import type { GovernanceInput, GovernancePolicy } from "@/lib/governance/evaluateGovernance";

// Research deletion integrity (2026-11-03): for a research run (`runs`), the status, the governance event and the audit
// row are now written in ONE transaction guarded by the deletion barrier, so this spec uses the shared transactional fake.
// `writes.sets` / `writes.adds` are views over its applied-write log with the same shape the old fake recorded:
// sets carry `merge`, adds carry the collection path.
import { FakeTransactionalFirestore } from "@/lib/workspaces/__tests__/helpers/fakeTransactionalFirestore";
type Write = { path: string; data: Record<string, unknown>; merge?: boolean };
const db = new FakeTransactionalFirestore();
const writes = {
  get sets(): Write[] {
    return db.writeLog.filter((w) => w.kind === "set" || w.kind === "merge").map((w) => ({ path: w.path, data: w.data, merge: w.kind === "merge" ? true : undefined }));
  },
  get adds(): Write[] {
    return db.writeLog.filter((w) => w.kind === "create").map((w) => ({ path: w.path.split("/").slice(0, -1).join("/"), data: w.data }));
  },
};
const docs = { get: (path: string) => db.read(path), set: (path: string, data: Record<string, unknown>) => db.seed(path, data) };

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: jest.fn(async () => ({ planId: "full" })) }));
let mockPolicy: GovernancePolicy;
jest.mock("@/lib/governance/governancePolicyStore", () => ({ loadGovernancePolicy: jest.fn(async () => mockPolicy) }));

const { getDefaultGovernancePolicy, evaluateGovernance } = require("@/lib/governance/evaluateGovernance");

/** A fresh module per test: evaluateAndStore caches the policy for 60 s at module scope. */
function loadEvaluateAndStore(): typeof import("@/lib/governance/evaluateAndStore") {
  let mod: typeof import("@/lib/governance/evaluateAndStore") | undefined;
  jest.isolateModules(() => {
    mod = require("@/lib/governance/evaluateAndStore");
  });
  return mod!;
}

const INPUT: GovernanceInput = {
  scoreFamily: "video_agreement_v1",
  consensusScore: 74,
  evidenceQuality: "mixed",
  sourceBacked: false,
  missingSourcesCount: 0,
  modelHealth: { ok: 4, substituted: 0, failed: 0 },
  question: "Video verification: clip.mp4 (10s, 1920x1080)",
  runType: "verification",
  verificationVerdict: "confirmed",
};

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.writeLog = [];
  mockPolicy = getDefaultGovernancePolicy();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function run(input: GovernanceInput, runId = "vid-1", collection: "runs" | "verifications" | "videoVerifications" = "videoVerifications") {
  if (!docs.get(`${collection}/${runId}`)) docs.set(`${collection}/${runId}`, { userEmail: "owner@example.test" });
  const { evaluateAndStoreGovernance } = loadEvaluateAndStore();
  const res = await evaluateAndStoreGovernance({ runId, collection, input, ownerUid: "uid-1" });
  const parent = writes.sets.filter((w) => w.path === `${collection}/${runId}`).pop()!;
  const event = writes.adds.filter((w) => w.path === `${collection}/${runId}/governanceEvents`).pop()!;
  const audit = writes.adds.filter((w) => w.path === "admin_audit_logs").pop()!;
  return { res, parent, event, audit };
}

describe("evaluateAndStoreGovernance — parent document", () => {
  it("status and reasons are exactly the evaluator's; governanceMeta gains the provenance", async () => {
    const expected = evaluateGovernance(INPUT, mockPolicy);
    const { res, parent } = await run(INPUT);
    expect(res).toEqual({ governanceStatus: "approved" });
    expect(parent.merge).toBe(true);
    expect(parent.data.governanceStatus).toBe(expected.status);
    expect(parent.data.governanceReasons).toEqual(expected.reasons);
    expect(parent.data.governanceMeta).toEqual({
      policyVersion: 1,
      evaluatedAt: expect.any(String),
      scoreFamily: "video_agreement_v1",
      scoreThresholdsInEffect: { minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" },
    });
    expect(Object.keys(parent.data).sort()).toEqual(["governanceMeta", "governanceReasons", "governanceStatus"]);
  });
});

describe("evaluateAndStoreGovernance — append-only governanceEvents entry", () => {
  it("carries scoreFamily + thresholds beside every pre-D5.1 field", async () => {
    const { event } = await run({ ...INPUT, consensusScore: 60 });
    expect(event.data).toEqual({
      action: "evaluated",
      byUid: "system",
      byEmail: "system",
      at: expect.any(String),
      nextStatus: "needs_review",
      reasons: ["Consensus 60 below 70"],
      policyVersion: 1,
      scoreFamily: "video_agreement_v1",
      scoreThresholdsInEffect: { minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" },
    });
  });

  it("records the runtime policy's values and the sensitive set when it applied", async () => {
    mockPolicy = { ...getDefaultGovernancePolicy(), policyVersion: 4, minConsensusToAvoidReview: 66, sensitiveMinConsensusToApprove: 91, sensitiveMinConsensusToAvoidReview: 71, minConsensusToApprove: 97 };
    const { event, parent } = await run({ ...INPUT, scoreFamily: "claim_verification_v1", question: "Is this medication safe?" }, "vcl-1", "verifications");
    const provenance = {
      minConsensusToAvoidReview: 66,
      minConsensusToAvoidReviewSource: "shared",
      sensitive: { domain: "medical", minConsensusToAvoidReview: 71, minConsensusToApprove: 91 },
    };
    expect(event.data.policyVersion).toBe(4);
    expect(event.data.scoreFamily).toBe("claim_verification_v1");
    expect(event.data.scoreThresholdsInEffect).toEqual(provenance);
    expect((parent.data.governanceMeta as Record<string, unknown>).scoreThresholdsInEffect).toEqual(provenance);
    // The unused general approval threshold (97) appears nowhere in the recorded thresholds.
    // (Scoped to the threshold object: the event's ISO timestamp can contain any digit run.)
    expect(JSON.stringify(event.data.scoreThresholdsInEffect)).not.toContain("97");
    expect(Object.keys(event.data.scoreThresholdsInEffect as object).sort()).toEqual(["minConsensusToAvoidReview", "minConsensusToAvoidReviewSource", "sensitive"]);
  });

  it("a later re-evaluation replaces the parent meta but each event keeps its own family", async () => {
    await run(INPUT, "run-x", "runs");
    await run({ ...INPUT, scoreFamily: "research_synthesis_v1", runType: "research" }, "run-x", "runs");
    const events = writes.adds.filter((w) => w.path === "runs/run-x/governanceEvents").map((w) => w.data.scoreFamily);
    expect(events).toEqual(["video_agreement_v1", "research_synthesis_v1"]);
    expect((docs.get("runs/run-x")!.governanceMeta as Record<string, unknown>).scoreFamily).toBe("research_synthesis_v1");
  });
});

describe("D5.2A — a score-type override is recorded identically on parent, event and audit row", () => {
  it("video override 75: resolved value + source 'family' everywhere; the decision uses 75", async () => {
    mockPolicy = { ...getDefaultGovernancePolicy(), scoreFamilyReviewThresholds: { video_agreement_v1: 75 } };
    const { parent, event, audit } = await run(INPUT); // score 74
    const expected = { minConsensusToAvoidReview: 75, minConsensusToAvoidReviewSource: "family" };
    expect(parent.data.governanceStatus).toBe("needs_review");
    expect(parent.data.governanceReasons).toEqual(["Consensus 74 below 75"]);
    expect((parent.data.governanceMeta as Record<string, unknown>).scoreThresholdsInEffect).toEqual(expected);
    expect(event.data.scoreThresholdsInEffect).toEqual(expected);
    expect(audit.data.scoreThresholdsInEffect).toEqual(expected);
  });
  it("the same policy evaluates a research input on the shared value", async () => {
    mockPolicy = { ...getDefaultGovernancePolicy(), scoreFamilyReviewThresholds: { video_agreement_v1: 75 } };
    const { event } = await run({ ...INPUT, scoreFamily: "research_synthesis_v1", runType: "research" }, "run-r", "runs");
    expect(event.data.nextStatus).toBe("approved");
    expect(event.data.scoreThresholdsInEffect).toEqual({ minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" });
  });
});

describe("evaluateAndStoreGovernance — admin_audit_logs row (real writeAuditEvent)", () => {
  it("carries the same provenance and keeps its existing fields", async () => {
    const { audit, event } = await run(INPUT);
    expect(audit.data).toEqual({
      runId: "vid-1",
      collection: "videoVerifications",
      runType: "claim",
      action: "evaluated",
      byUid: "system",
      byEmail: "system",
      nextStatus: "approved",
      reasons: [],
      policyVersion: 1,
      scoreFamily: "video_agreement_v1",
      scoreThresholdsInEffect: { minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" },
      runOwnerUid: "uid-1",
      runOwnerEmail: "owner@example.test",
      question: "Video verification: clip.mp4 (10s, 1920x1080)",
      consensusScore: 74,
      at: expect.any(String),
    });
    expect(audit.data.scoreThresholdsInEffect).toEqual(event.data.scoreThresholdsInEffect);
  });

  it("the runtime log line names the action only — no family, threshold or record identifier", async () => {
    const log = console.log as jest.Mock;
    await run(INPUT);
    const auditLines = log.mock.calls.filter((c) => String(c[0]).startsWith("[governance/audit] Writing"));
    expect(auditLines).toEqual([["[governance/audit] Writing audit event:", "evaluated"]]);
  });
});

describe("legacy shapes without D5.1 provenance remain readable", () => {
  it("the export provenance reader takes the same policyVersion from old and new governanceMeta", () => {
    const { freezeExportRunProvenance } = require("@/lib/adaptiveSchema/exportRunProvenance");
    const legacyMeta = { policyVersion: 3, evaluatedAt: "2026-05-01T00:00:00.000Z" };
    const d51Meta = { ...legacyMeta, scoreFamily: "research_synthesis_v1", scoreThresholdsInEffect: { minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" } };
    const freeze = (governanceMeta: unknown) =>
      freezeExportRunProvenance({ selectedModels: [], runDocument: {}, policy: { family: "legacy", governanceStatus: "approved", governanceMeta } });
    expect(freeze(legacyMeta)).toEqual(freeze(d51Meta));
    expect(freeze(legacyMeta).policyVersion).toBe(3);
  });

  it("the lazy backfill still treats a legacy governanceMeta as already evaluated (no re-evaluation, no write)", async () => {
    const { ensureDocumentGovernanceEvaluated } = require("@/lib/governance/governanceBackfill");
    const legacy = { governanceMeta: { policyVersion: 1, evaluatedAt: "2026-05-01T00:00:00.000Z" } };
    const out = await ensureDocumentGovernanceEvaluated("runs", "old-run", legacy, { uid: "a", email: "a@example.test" });
    expect(out).toBe(legacy);
    expect(writes.sets).toHaveLength(0);
    expect(writes.adds).toHaveLength(0);
  });

  it("the lazy backfill's own evaluated event carries the same provenance when it does evaluate", async () => {
    const { ensureDocumentGovernanceEvaluated } = require("@/lib/governance/governanceBackfill");
    await ensureDocumentGovernanceEvaluated("verifications", "vcl-old", { claim: "c", consensusScore: 90, verdict: "confirmed", evidenceQuality: "strong" }, { uid: "a", email: "a@example.test" });
    const ev = writes.adds.find((w) => w.path === "verifications/vcl-old/governanceEvents")!;
    expect(ev.data).toEqual(
      expect.objectContaining({ action: "evaluated", nextStatus: "approved", scoreFamily: "claim_verification_v1", scoreThresholdsInEffect: { minConsensusToAvoidReview: 70, minConsensusToAvoidReviewSource: "shared" } })
    );
  });
});

describe("research runs: one guarded transaction, same documents (research deletion integrity)", () => {
  it("the parent status, the event and the audit row are committed together, in one transaction", async () => {
    await run({ ...INPUT, scoreFamily: "research_synthesis_v1", runType: "research" }, "run-t", "runs");
    expect(db.writeLog.map((w) => [w.kind, w.path.split("/").slice(0, -1).join("/") || w.path, w.via])).toEqual([
      ["merge", "runs", "tx"],
      ["create", "runs/run-t/governanceEvents", "tx"],
      ["create", "admin_audit_logs", "tx"],
    ]);
  });

  it("the research-run audit row is field-for-field what writeAuditEvent writes for the same evaluation", async () => {
    const research = { ...INPUT, scoreFamily: "research_synthesis_v1" as const, runType: "research" as const, question: `  ${"Q".repeat(260)}  ` };
    const viaGuarded = (await run(research, "r-1", "runs")).audit.data;
    const viaWriteAuditEvent = (await run(research, "r-1", "verifications")).audit.data;
    const strip = (d: Record<string, unknown>) => {
      const { collection: _c, at: _a, ...rest } = d;
      return rest;
    };
    expect(strip(viaGuarded)).toEqual(strip(viaWriteAuditEvent));
    expect(viaGuarded.question).toBe("Q".repeat(198)); // cut to 200 by the caller, then trimmed, exactly as before
    expect(viaGuarded.collection).toBe("runs");
  });

  it("deletion barrier: a deleted, deleting or missing research run gets no status, event or audit row", async () => {
    db.seed("runDeletionJobs/run-d", { state: "complete" });
    db.seed("runs/run-d", { userEmail: "owner@example.test" });
    db.seed("runs/run-m", { userEmail: "owner@example.test", deletion: { state: "pending" } });
    const { evaluateAndStoreGovernance } = loadEvaluateAndStore();
    for (const runId of ["run-d", "run-m", "run-none"]) {
      expect(await evaluateAndStoreGovernance({ runId, collection: "runs", input: { ...INPUT, runType: "research" }, ownerUid: "uid-1" })).toBeNull();
    }
    expect(db.writeLog).toEqual([]);
  });
});
