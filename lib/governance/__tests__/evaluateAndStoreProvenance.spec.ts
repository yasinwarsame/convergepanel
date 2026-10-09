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

type Write = { path: string; data: Record<string, unknown>; merge?: boolean };

const writes: { sets: Write[]; adds: Write[] } = { sets: [], adds: [] };
const docs = new Map<string, Record<string, unknown>>();

function fakeDoc(path: string): any {
  return {
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      writes.sets.push({ path, data, merge: opts?.merge });
      docs.set(path, { ...(opts?.merge ? docs.get(path) ?? {} : {}), ...data });
    },
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    collection: (name: string) => fakeCollection(`${path}/${name}`),
  };
}
function fakeCollection(path: string): any {
  return {
    doc: (id: string) => fakeDoc(`${path}/${id}`),
    add: async (data: Record<string, unknown>) => {
      writes.adds.push({ path, data });
      return { id: `auto-${writes.adds.length}` };
    },
  };
}

jest.mock("@/lib/firebase/admin", () => ({ adminDb: { collection: (name: string) => fakeCollection(name) } }));
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
  writes.sets = [];
  writes.adds = [];
  docs.clear();
  mockPolicy = getDefaultGovernancePolicy();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function run(input: GovernanceInput, runId = "vid-1", collection: "runs" | "verifications" | "videoVerifications" = "videoVerifications") {
  docs.set(`${collection}/${runId}`, { userEmail: "owner@example.test" });
  const { evaluateAndStoreGovernance } = loadEvaluateAndStore();
  const res = await evaluateAndStoreGovernance({ runId, collection, input, ownerUid: "uid-1" });
  const parent = writes.sets.find((w) => w.path === `${collection}/${runId}`)!;
  const event = writes.adds.find((w) => w.path === `${collection}/${runId}/governanceEvents`)!;
  const audit = writes.adds.find((w) => w.path === "admin_audit_logs")!;
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
      scoreThresholdsInEffect: { minConsensusToAvoidReview: 70 },
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
      scoreThresholdsInEffect: { minConsensusToAvoidReview: 70 },
    });
  });

  it("records the runtime policy's values and the sensitive set when it applied", async () => {
    mockPolicy = { ...getDefaultGovernancePolicy(), policyVersion: 4, minConsensusToAvoidReview: 66, sensitiveMinConsensusToApprove: 91, sensitiveMinConsensusToAvoidReview: 71, minConsensusToApprove: 97 };
    const { event, parent } = await run({ ...INPUT, scoreFamily: "claim_verification_v1", question: "Is this medication safe?" }, "vcl-1", "verifications");
    const provenance = {
      minConsensusToAvoidReview: 66,
      sensitive: { domain: "medical", minConsensusToAvoidReview: 71, minConsensusToApprove: 91 },
    };
    expect(event.data.policyVersion).toBe(4);
    expect(event.data.scoreFamily).toBe("claim_verification_v1");
    expect(event.data.scoreThresholdsInEffect).toEqual(provenance);
    expect((parent.data.governanceMeta as Record<string, unknown>).scoreThresholdsInEffect).toEqual(provenance);
    expect(JSON.stringify(event.data)).not.toContain("97");
  });

  it("a later re-evaluation replaces the parent meta but each event keeps its own family", async () => {
    await run(INPUT, "run-x", "runs");
    await run({ ...INPUT, scoreFamily: "research_synthesis_v1", runType: "research" }, "run-x", "runs");
    const events = writes.adds.filter((w) => w.path === "runs/run-x/governanceEvents").map((w) => w.data.scoreFamily);
    expect(events).toEqual(["video_agreement_v1", "research_synthesis_v1"]);
    expect((docs.get("runs/run-x")!.governanceMeta as Record<string, unknown>).scoreFamily).toBe("research_synthesis_v1");
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
      scoreThresholdsInEffect: { minConsensusToAvoidReview: 70 },
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
    const d51Meta = { ...legacyMeta, scoreFamily: "research_synthesis_v1", scoreThresholdsInEffect: { minConsensusToAvoidReview: 70 } };
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
      expect.objectContaining({ action: "evaluated", nextStatus: "approved", scoreFamily: "claim_verification_v1", scoreThresholdsInEffect: { minConsensusToAvoidReview: 70 } })
    );
  });
});
