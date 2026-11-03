/**
 * Owner Order A — reviewed-content integrity. Every review cycle is bound to the exact content submitted (rrc-v1
 * server-computed fingerprint); a decision on changed content is refused and writes nothing; an open cycle whose
 * content changed can only be superseded by a new cycle; previous decisions keep their original fingerprint.
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
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));

import { readFileSync } from "fs";
import { join } from "path";
import { canonicalReportReviewContent, computeReportReviewContentFingerprint, REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS, REPORT_REVIEW_CONTENT_MAX_BYTES } from "@/lib/governance/reportReviewContent";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { parseReportReviewRecord, type ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { computeMembershipId } from "@/lib/workspaces/membershipId";

const W = "wsRRA";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const REVIEWER = "uid-reviewer";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const RUN = "run-rra";

/** The reviewable content of the golden fixture: exactly what rrc-v1 must keep. */
const GOLDEN_CONTENT = {
  question: "Is the plan sound?",
  questionContext: null,
  selectedModels: ["chatgpt", "claude"],
  status: "complete",
  runDocument: {
    perModel: [
      { modelId: "chatgpt", status: "ok", rawTextTruncated: "Yes — mostly. «Ünïcode» ✓", wasTruncated: false },
      { modelId: "claude", status: "error", rawTextTruncated: "", wasTruncated: false },
    ],
    flags: { storageTruncated: false },
  },
  legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "2026-11-02T09:59:00.000Z", results: [], alignedClaims: [] },
  score: 0.5,
  count: 3,
};
/** Computed independently in Python: sha256("rrc-v1\n" + json.dumps(GOLDEN_CONTENT, sort_keys=True, separators=(",",":"), ensure_ascii=False)). */
const GOLDEN_DIGEST = "af9b383428c17be12d649f659eb15302d823730715410b27426757bfcd3a0362";
const GOLDEN_BYTES = 565;

/** The same content as a stored run document: excluded (non-content) fields and per-model metrics added, keys shuffled. */
function storedRun(over: Record<string, unknown> = {}) {
  return {
    count: 3,
    tokenUsage: { totals: { totalTokens: 12 } },
    userId: CREATOR,
    workspaceId: W,
    projectId: null,
    createdAt: NOW,
    completedAt: NOW,
    status: "complete",
    question: "Is the plan sound?",
    questionContext: null,
    score: 0.5,
    selectedModels: ["chatgpt", "claude"],
    runDocument: {
      flags: { storageTruncated: false },
      perModel: [
        { wasTruncated: false, latencyMs: 812, rawTextTruncated: "Yes — mostly. «Ünïcode» ✓", status: "ok", tokenUsage: { totalTokens: 7 }, modelId: "chatgpt" },
        { modelId: "claude", status: "error", rawTextTruncated: "", wasTruncated: false, latencyMs: 30 },
      ],
    },
    legacyAdaptiveOutput: { alignedClaims: [], results: [], generatedAt: "2026-11-02T09:59:00.000Z", classification: { queryType: "generic" }, schemaId: "generic", version: 1 },
    totalTokens: 12,
    ...over,
  };
}

describe("rrc-v1 canonical form and fingerprint (pure)", () => {
  it("golden: matches an independent implementation, ignoring excluded fields, metrics and key order", () => {
    const r = computeReportReviewContentFingerprint(storedRun());
    expect(r.ok && r.fingerprint).toEqual({ version: "rrc-v1", algorithm: "sha256", digest: GOLDEN_DIGEST, canonicalBytes: GOLDEN_BYTES });
    expect(r.ok && JSON.parse(r.canonical)).toEqual(GOLDEN_CONTENT);
  });

  it("deterministic across calls and insertion orders", () => {
    const a = computeReportReviewContentFingerprint(storedRun());
    const reversed = Object.fromEntries(Object.entries(storedRun()).reverse());
    const b = computeReportReviewContentFingerprint(reversed);
    expect(a.ok && b.ok && a.fingerprint.digest === b.fingerprint.digest).toBe(true);
  });

  const digest = (run: Record<string, unknown>) => {
    const r = computeReportReviewContentFingerprint(run);
    if (!r.ok) throw new Error(r.reason);
    return r.fingerprint.digest;
  };

  it("the exclusion list is exactly the documented one (a removal or addition must be a reviewed boundary change)", () => {
    expect(Object.keys(REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS).sort()).toEqual(
      [
        "userId", "workspaceId", "projectId", "assigneeUid", "assigneeUids", "origin", "createdAt", "completedAt", "synthesizedAt", "synthesisInputHash", "synthesisMetadata",
        "tokenUsage", "totalTokens", "tokensByModel", "tokensByProvider", "promptTokensByProvider", "completionTokensByProvider", "geminiHasUsageMetadata", "documentSizeChars",
        "adaptiveExportCounter", "reportReview", "governanceRecord", "teamGovernance", "errorMessage", "governanceStatus", "governanceReasons", "governanceMeta", "adaptiveRetryUsage",
      ].sort()
    );
    expect(digest(storedRun({ synthesizedAt: Timestamp.now() }))).toBe(GOLDEN_DIGEST);
  });

  it.each(Object.keys(REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS))("excluded field %s never changes the fingerprint", (field) => {
    expect(digest(storedRun({ [field]: { changed: Math.random() } }))).toBe(GOLDEN_DIGEST);
  });

  it.each([
    ["the question", { question: "Is the plan sound? (edited)" }],
    ["research context", { questionContext: "Background" }],
    ["a saved model response", { runDocument: { ...storedRun().runDocument, perModel: [{ ...storedRun().runDocument.perModel[0], rawTextTruncated: "No." }, storedRun().runDocument.perModel[1]] } }],
    ["a model's truncation flag", { runDocument: { ...storedRun().runDocument, flags: { storageTruncated: true } } }],
    ["the structured result", { legacyAdaptiveOutput: { ...storedRun().legacyAdaptiveOutput, alignedClaims: [{ id: "c1" }] } }],
    ["a synthesis (no timestamp)", { synthesizedStructuredReport: { summary: "S" }, schemaVersion: 1 }],
    ["a consensus summary", { synthesisConsensusSummary: { agreement: "high" } }],
    ["a legacy results array", { results: [{ modelId: "chatgpt", rawText: "x" }] }],
    ["an unclassified new field (default include)", { someFutureContentField: "x" }],
    ["selected models", { selectedModels: ["chatgpt"] }],
  ])("%s changes the fingerprint", (_l, over) => {
    expect(digest(storedRun(over))).not.toBe(GOLDEN_DIGEST);
  });

  it("explicit null and absent are different content; -0 and 0 are the same; arrays keep order", () => {
    const { questionContext: _q, ...absent } = storedRun();
    void _q;
    expect(digest(absent)).not.toBe(GOLDEN_DIGEST);
    expect(digest(storedRun({ score: -0, count: 3 }))).toBe(digest(storedRun({ score: 0 })));
    expect(digest(storedRun({ selectedModels: ["claude", "chatgpt"] }))).not.toBe(GOLDEN_DIGEST);
  });

  it("Timestamps and Dates of the same instant serialize identically; nanoseconds count", () => {
    const t = Timestamp.fromDate(new Date("2026-11-02T10:00:00.123Z"));
    expect(digest(storedRun({ note: { at: t } }))).toBe(digest(storedRun({ note: { at: new Date("2026-11-02T10:00:00.123Z") } })));
    expect(digest(storedRun({ note: { at: new Timestamp(t.seconds, t.nanoseconds + 1) } }))).not.toBe(digest(storedRun({ note: { at: t } })));
    const c = canonicalReportReviewContent(storedRun({ note: { at: new Date(-1500) } }));
    expect(c.ok && c.canonical).toContain('{"$timestamp":"-2.500000000"}');
    // The documented form: seconds, a dot, and exactly nine nanosecond digits.
    const n = canonicalReportReviewContent(storedRun({ note: { at: new Timestamp(1762077600, 5) } }));
    expect(n.ok && n.canonical).toContain('{"$timestamp":"1762077600.000000005"}');
  });

  it.each([
    ["NaN", { score: NaN }],
    ["Infinity", { score: Infinity }],
    ["a class instance (GeoPoint, DocumentReference…)", { place: new (class GeoPoint { lat = 1; lng = 2; })() }],
    ["bytes", { blob: Buffer.from("x") }],
    ["bigint", { big: BigInt(1) }],
    ["an invalid Date", { at: new Date("nope") }],
    ["a stored map that mimics the Timestamp encoding", { at: { $timestamp: "1.000000000" } }],
  ])("unsupported value fails closed (%s)", (_l, over) => {
    expect(computeReportReviewContentFingerprint(storedRun(over))).toEqual({ ok: false, reason: "unsupported_value" });
  });

  it("oversized content fails closed — never a partial fingerprint", () => {
    expect(computeReportReviewContentFingerprint(storedRun({ big: "x".repeat(REPORT_REVIEW_CONTENT_MAX_BYTES) }))).toEqual({ ok: false, reason: "too_large" });
    expect(computeReportReviewContentFingerprint(null)).toEqual({ ok: false, reason: "not_an_object" });
  });

  it("the parser rejects a malformed stored fingerprint and keeps a valid one", () => {
    const base = { version: 1, kind: "report_review", cycle: 1, scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 1, requestedModels: 2 }, purpose: { code: "other" }, humanReview: { status: "unreviewed" }, submittedAt: "2026-11-02T11:00:00.000Z", submittedByUserId: MEMBER, createdAt: "2026-11-02T11:00:00.000Z", updatedAt: "2026-11-02T11:00:00.000Z" };
    const good = { version: "rrc-v1", algorithm: "sha256", digest: GOLDEN_DIGEST, canonicalBytes: GOLDEN_BYTES };
    expect(parseReportReviewRecord({ ...base, contentFingerprint: good })).toMatchObject({ ok: true, record: { contentFingerprint: good } });
    for (const bad of [{ ...good, digest: "XYZ" }, { ...good, version: "rrc-v0" }, { ...good, algorithm: "md5" }, { ...good, canonicalBytes: 1.5 }, "abc"]) {
      expect(parseReportReviewRecord({ ...base, contentFingerprint: bad })).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

function membership(uid: string, role: string) {
  const id = computeMembershipId(W, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: W, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1;
const run = () => db.read(`runs/${RUN}`)!;
const setRun = (over: Record<string, unknown>) => db.seed(`runs/${RUN}`, { ...run(), ...over });
const snapshotState = () =>
  JSON.stringify({
    record: rr(),
    assignment: db.read(`runs/${RUN}/humanReviewAssignment/current`),
    events: db.paths(`runs/${RUN}/reportReviewEvents/`).length,
    audit: db.paths("workspaceMembershipEvents/").length,
    cycles: db.paths(`runs/${RUN}/reportReviewCycles/`).length,
  });

async function submitted() {
  const r = await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "internal_review" }, now: "2026-11-02T11:00:00.000Z" });
  if (!r.ok) throw new Error(`submit ${r.reason}`);
  await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" });
  return r.record;
}
const decide = (status = "approved", now = "2026-11-02T12:00:00.000Z") => decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status }, expectedCycle: rr().cycle, expectedUpdatedAt: rr().updatedAt, now });

describe("submission and decision bind to the exact submitted content", () => {
  beforeEach(() => {
    db.docs.clear();
    db.hooks = {};
    db.seed(`workspaces/${W}`, { schemaVersion: 1, id: W, type: "team", name: "T", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
    for (const [u, r] of [[OWNER, "owner"], [ADMIN, "admin"], [MEMBER, "member"], [REVIEWER, "reviewer"], [CREATOR, "member"]]) membership(u, r);
    db.seed(`runs/${RUN}`, storedRun());
  });

  it("the server computes the fingerprint at submission from the run it read (a client cannot supply one)", async () => {
    const record = await submitted();
    expect(record.contentFingerprint).toEqual({ version: "rrc-v1", algorithm: "sha256", digest: GOLDEN_DIGEST, canonicalBytes: GOLDEN_BYTES });
    const r = await submitReportReview({ uid: OWNER, workspaceId: W, runId: "other", purpose: { code: "other", contentFingerprint: "forged" } as unknown as { code: string } });
    expect(r).toEqual({ ok: false, reason: "invalid_purpose" }); // purpose is exactly { code, note? }; the route body is exactly { purpose }
  });

  it("unchanged content (only non-content fields changed: export counter, assignee, Project move, tokens, late governance evaluation, retry accounting): the decision succeeds", async () => {
    await submitted();
    setRun({ adaptiveExportCounter: 4, assigneeUid: OWNER, projectId: null, totalTokens: 99, completedAt: Timestamp.now(), governanceStatus: "approved", governanceReasons: ["r"], governanceMeta: { evaluatedAt: "2026-11-02T11:30:00.000Z" }, adaptiveRetryUsage: { calls: 1 } });
    const res = await decide();
    expect(res.ok && !res.replayed).toBe(true);
  });

  it.each([
    ["a regenerated synthesis with NO timestamp", { synthesizedStructuredReport: { summary: "new" }, schemaVersion: 1 }],
    ["a modified model response", { runDocument: { ...storedRun().runDocument, perModel: [{ ...storedRun().runDocument.perModel[0], rawTextTruncated: "changed" }, storedRun().runDocument.perModel[1]] } }],
    ["a changed structured result", { legacyAdaptiveOutput: { ...storedRun().legacyAdaptiveOutput, results: [{ modelId: "x" }] } }],
    ["a new consensus summary", { synthesisConsensusSummary: { agreement: "low" } }],
  ])("%s: the decision is refused and NOTHING is written", async (_l, over) => {
    await submitted();
    setRun(over);
    const before = snapshotState();
    expect(await decide()).toEqual({ ok: false, reason: "content_changed" });
    expect(snapshotState()).toBe(before); // assignment, record, events, audit and cycles untouched; fingerprint never replaced
  });

  it("a cycle without a fingerprint is never decided (content_unverifiable) — and can always be superseded (no dead end)", async () => {
    await submitted();
    const { contentFingerprint: _f, ...noFp } = rr();
    void _f;
    setRun({ reportReview: noFp });
    expect(await decide()).toEqual({ ok: false, reason: "content_unverifiable" });
    const ctx = await getReportReviewContext({ uid: MEMBER, workspaceId: W, runId: RUN });
    expect(ctx.status === "ok" && [ctx.contentIntegrity.status, ctx.viewer.canResubmit]).toEqual(["unverifiable", true]);
    expect((await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);
    expect(db.read(`runs/${RUN}/reportReviewCycles/1`)!.closedReason).toBe("content_unverifiable");
    expect(rr().contentFingerprint!.digest).toBe(GOLDEN_DIGEST);
  });

  it("an open cycle whose CURRENT content can no longer be fingerprinted: no decision, and the context does not offer an impossible resubmission", async () => {
    await submitted();
    setRun({ score: NaN });
    expect(await decide()).toEqual({ ok: false, reason: "content_unverifiable" });
    const ctx = await getReportReviewContext({ uid: MEMBER, workspaceId: W, runId: RUN });
    expect(ctx.status === "ok" && [ctx.contentIntegrity.status, ctx.viewer.canResubmit]).toEqual(["unverifiable", false]);
    expect(await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1 })).toEqual({ ok: false, reason: "content_unfingerprintable" });
  });

  it("a DECIDED cycle whose current content can no longer be fingerprinted: resubmission is not offered (the transaction would refuse it)", async () => {
    await submitted();
    expect((await decide()).ok).toBe(true);
    setRun({ score: NaN });
    const ctx = await getReportReviewContext({ uid: MEMBER, workspaceId: W, runId: RUN });
    expect(ctx.status === "ok" && ctx.viewer.canResubmit).toBe(false);
    expect(await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1 })).toEqual({ ok: false, reason: "content_unfingerprintable" });
  });

  it("race: content written after the decision read its run makes the transaction retry and refuse", async () => {
    await submitted();
    let fired = false;
    db.hooks = {
      afterTxReads: () => {
        if (fired) return;
        fired = true;
        db.seed(`runs/${RUN}`, { ...run(), synthesizedStructuredReport: { summary: "raced" }, schemaVersion: 1 });
      },
    };
    expect(await decide()).toEqual({ ok: false, reason: "content_changed" });
    expect(rr().humanReview.status).toBe("unreviewed");
    expect(db.stats.retries).toBeGreaterThan(0);
  });

  it("retried decision after approval replays; the earlier approval keeps its original fingerprint after content changes", async () => {
    const original = (await submitted()).contentFingerprint;
    expect((await decide()).ok).toBe(true);
    setRun({ synthesizedStructuredReport: { summary: "later" }, schemaVersion: 1 });
    const replay = await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "2026-11-02T11:00:00.000Z" });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(rr().contentFingerprint).toEqual(original);
    const ctx = await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN });
    expect(ctx.status === "ok" && ctx.contentIntegrity.status).toBe("changed"); // never presented as covering the new content
    // Resubmission starts cycle 2 on the NEW content; cycle 1's archive keeps the original fingerprint.
    expect((await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);
    const archive = db.read(`runs/${RUN}/reportReviewCycles/1`)!;
    expect([(archive.record as ReportReviewRecordV1).contentFingerprint, archive.closedReason]).toEqual([original, "decided"]);
    expect(rr().contentFingerprint!.digest).not.toBe(original!.digest);
  });

  it("an OPEN cycle whose content changed: no decision, the context says so, and it can be superseded by a new cycle", async () => {
    const original = (await submitted()).contentFingerprint;
    // Unchanged open cycle: resubmission is not allowed (it has no decision and nothing changed).
    expect(await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1 })).toEqual({ ok: false, reason: "not_decided" });
    setRun({ synthesizedStructuredReport: { summary: "new" }, schemaVersion: 1 });
    const reviewerCtx = await getReportReviewContext({ uid: REVIEWER, workspaceId: W, runId: RUN });
    expect(reviewerCtx.status === "ok" && [reviewerCtx.viewer.canDecide, reviewerCtx.viewer.denial, reviewerCtx.contentIntegrity.status]).toEqual([false, "content_changed", "changed"]);
    const memberCtx = await getReportReviewContext({ uid: MEMBER, workspaceId: W, runId: RUN });
    expect(memberCtx.status === "ok" && memberCtx.viewer.canResubmit).toBe(true);
    expect((await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);
    const archive = db.read(`runs/${RUN}/reportReviewCycles/1`)!;
    expect([(archive.record as ReportReviewRecordV1).humanReview.status, (archive.record as ReportReviewRecordV1).contentFingerprint, archive.closedReason]).toEqual(["unreviewed", original, "content_changed"]);
    const audit = db.paths("workspaceMembershipEvents/").map((p) => db.read(p)!).find((e) => e.eventType === "workspace_report_review_resubmitted")!;
    expect(audit.closedReason).toBe("content_changed");
    // The new cycle is decidable on the new content once assigned.
    await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 2, dueAt: null, now: "2026-11-02T13:01:00.000Z" });
    expect((await decide("approved", "2026-11-02T14:00:00.000Z")).ok).toBe(true);
  });

  it("content that cannot be fingerprinted is never submitted (fails closed)", async () => {
    setRun({ score: NaN });
    expect(await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "other" } })).toEqual({ ok: false, reason: "content_unfingerprintable" });
    expect(run().reportReview).toBeUndefined();
  });
});

describe("governed review semantics unchanged (static)", () => {
  const ROOT = join(__dirname, "../../..");
  it("no governed decision, assignment or panel module references the content fingerprint", () => {
    for (const f of ["lib/workspaces/workspaceReviewMutations.ts", "lib/workspaces/reviewContext.ts", "app/api/workspaces/[workspaceId]/runs/[runId]/review-decision/route.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).not.toMatch(/contentFingerprint|reportReviewContent/);
    }
  });
});
