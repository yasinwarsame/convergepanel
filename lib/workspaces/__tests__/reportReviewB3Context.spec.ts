/**
 * Order B, Stage B3 — the page's read context (submission availability and its reason, viewer abilities, names,
 * history), the submitter exclusion from reviewer candidates, and the controlled missing-index failure.
 * Viewer abilities must match what the server mutations would actually do (they are presentation only).
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const flags = { REPORT_REVIEW_ENABLED: true };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return flags.REPORT_REVIEW_ENABLED;
  },
}));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  ...jest.requireActual("@/lib/governance/reviewerIdentity"),
  resolveReviewerDisplayNames: async (uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));

import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { getReviewerCandidates } from "@/lib/workspaces/reviewerCandidates";
import { getReviewQueue, isMissingIndexError } from "@/lib/workspaces/reviewQueue";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { REPORT_REVIEW_DISCLAIMER } from "@/lib/governance/reportReviewCopy";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";

const W = "wsB3c";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const MEMBER2 = "uid-member2";
const REVIEWER = "uid-reviewer";
const VIEWER = "uid-viewer";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const RUN = "run-b3c";

function membership(uid: string, role: string, status = "active") {
  const id = computeMembershipId(W, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: W, uid, role, status, createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
function run(over: Record<string, unknown> = {}) {
  db.seed(`runs/${RUN}`, {
    userId: CREATOR,
    workspaceId: W,
    projectId: null,
    question: "Q?",
    selectedModels: ["chatgpt"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok" }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: {}, generatedAt: "x", results: [], alignedClaims: [] },
    ...over,
  });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  flags.REPORT_REVIEW_ENABLED = true;
  db.seed(`workspaces/${W}`, { schemaVersion: 1, id: W, type: "team", name: "T", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
  membership(OWNER, "owner");
  membership(ADMIN, "admin");
  membership(MEMBER, "member");
  membership(MEMBER2, "member");
  membership(REVIEWER, "reviewer");
  membership(VIEWER, "viewer");
  membership(CREATOR, "member");
  run();
});

const ctx = (uid: string) => getReportReviewContext({ uid, workspaceId: W, runId: RUN });
const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1;
const submit = () => submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "internal_review" }, now: "2026-11-02T11:00:00.000Z" });

describe("not yet submitted: availability and its reason", () => {
  it("eligible: Owner, Admin and Member can submit; Reviewer cannot (D-B3a); the disclaimer is included", async () => {
    for (const [uid, can] of [[OWNER, true], [ADMIN, true], [MEMBER, true], [REVIEWER, false]] as const) {
      expect(await ctx(uid)).toEqual({ status: "not_submitted", eligibility: { eligible: true }, viewer: { canSubmit: can }, disclaimer: REPORT_REVIEW_DISCLAIMER });
    }
  });

  it("the verdict matches the server: a Reviewer told 'cannot submit' is refused by the submit transaction", async () => {
    const c = await ctx(REVIEWER);
    expect(c.status === "not_submitted" && c.viewer.canSubmit).toBe(false);
    expect((await submitReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, purpose: { code: "other" } })).ok).toBe(false);
  });

  it.each([
    ["governed run", { governanceRecord: { humanReview: { status: "unreviewed" } } }, "governed_run"],
    ["governed output", { adaptiveOutput: { version: 1 } }, "governed_run"],
    ["unfinished run", { status: "running" }, "not_complete"],
    ["governed schema envelope", { legacyAdaptiveOutput: { version: 1, schemaId: "decision_support", results: [] } }, "no_review_information"],
  ])("ineligible (%s): reason %s, nobody can submit", async (_l, over, reason) => {
    run(over);
    expect(await ctx(OWNER)).toMatchObject({ status: "not_submitted", eligibility: { eligible: false, reason }, viewer: { canSubmit: false } });
  });

  it("an open review panel makes submission unavailable (active_panel), as the transaction would", async () => {
    db.seed(`runs/${RUN}/humanReviewPanel/current`, { schemaVersion: 1, runId: RUN, status: "open", reviewerUserIds: [REVIEWER], revision: 1 });
    const c = await ctx(OWNER);
    expect(c.status).toBe("not_submitted");
    if (c.status !== "not_submitted") return;
    expect(c.viewer.canSubmit).toBe(false);
    expect(c.eligibility.eligible).toBe(false);
  });

  it("concealed: OFF, a non-member, another Workspace's run, and a malformed record are all not_found", async () => {
    flags.REPORT_REVIEW_ENABLED = false;
    expect(await ctx(OWNER)).toEqual({ status: "not_found" });
    flags.REPORT_REVIEW_ENABLED = true;
    expect(await getReportReviewContext({ uid: "uid-stranger", workspaceId: W, runId: RUN })).toEqual({ status: "not_found" });
    run({ workspaceId: "wsElsewhere" });
    expect(await ctx(OWNER)).toEqual({ status: "not_found" });
    run({ reportReview: { version: 1, kind: "report_review", cycle: "one" } });
    expect(await ctx(OWNER)).toEqual({ status: "not_found" });
  });

  it("both records present: integrity_violation (fail closed)", async () => {
    await submit();
    run({ reportReview: rr(), governanceRecord: { humanReview: { status: "unreviewed" } } });
    expect(await ctx(OWNER)).toEqual({ status: "integrity_violation" });
  });
});

describe("submitted: abilities, names, history", () => {
  it("open cycle: managers can assign; nobody can resubmit; names resolve every uid; history lists the submission", async () => {
    await submit();
    const c = await ctx(ADMIN);
    if (c.status !== "ok") throw new Error(c.status);
    expect(c.viewer).toMatchObject({ canResubmit: false, canManageAssignment: true });
    expect(c.names[MEMBER]).toBe(`Name(${MEMBER})`);
    expect(c.history).toEqual([{ type: "report_review_submitted", at: "2026-11-02T11:00:00.000Z", actorDisplayName: `Name(${MEMBER})`, cycle: 1, purposeCode: "internal_review" }]);
    const m = await ctx(MEMBER);
    expect(m.status === "ok" && m.viewer.canManageAssignment).toBe(false); // Member lacks reviews.manage
  });

  it("assignment info is in the reviewer-card shape; the submitter as assignee would be stale (never actionable)", async () => {
    await submit();
    await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" });
    const c = await ctx(ADMIN);
    if (c.status !== "ok") throw new Error(c.status);
    expect(c.assignment).toEqual({
      assignedReviewerUserId: REVIEWER,
      revision: 1,
      info: { assignedReviewerUserId: REVIEWER, assignedReviewerDisplayName: `Name(${REVIEWER})`, revision: 1, assignedAt: "2026-11-02T11:01:00.000Z", updatedAt: "2026-11-02T11:01:00.000Z", dueAt: null, state: "actionable" },
    });
    expect(c.history.map((h) => [h.type, h.reviewerDisplayName ?? null])).toEqual([
      ["report_review_submitted", null],
      ["report_review_assignment_changed", `Name(${REVIEWER})`],
    ]);
    // Seed an assignment naming the submitter directly (the mutation would refuse it): shown stale, never actionable.
    db.seed(`runs/${RUN}/humanReviewAssignment/current`, { ...db.read(`runs/${RUN}/humanReviewAssignment/current`)!, assignedReviewerUserId: MEMBER });
    const s = await ctx(ADMIN);
    expect(s.status === "ok" && s.assignment.info?.state).toBe("stale");
  });

  it("decided cycle: organizers can resubmit (and the server agrees); nobody can manage the closed cycle's assignment", async () => {
    await submit();
    await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" });
    await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "rejected" }, expectedCycle: 1, expectedUpdatedAt: rr().updatedAt, now: "2026-11-02T12:00:00.000Z" });
    for (const [uid, canResubmit] of [[MEMBER2, true], [OWNER, true], [REVIEWER, false]] as const) {
      const c = await ctx(uid);
      expect(c.status === "ok" && [c.viewer.canResubmit, c.viewer.canManageAssignment]).toEqual([canResubmit, false]);
    }
    expect((await resubmitReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1 })).ok).toBe(false);
    expect((await resubmitReportReview({ uid: MEMBER2, workspaceId: W, runId: RUN, purpose: { code: "other" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" })).ok).toBe(true);
    const after = await ctx(OWNER);
    if (after.status !== "ok") throw new Error(after.status);
    expect(after.previousCycles).toEqual([{ cycle: 1, status: "rejected", reviewerId: REVIEWER, reviewedAt: "2026-11-02T12:00:00.000Z", purposeCode: "internal_review", assignedReviewerUserId: REVIEWER }]);
    expect(after.viewer.canManageAssignment).toBe(true); // new open cycle
  });
});

describe("reviewer candidates exclude the submitter (dormant while OFF)", () => {
  it("ON: the submitter is never offered; OFF: the list is exactly as before B2", async () => {
    membership(MEMBER, "member");
    await submit();
    const on = await getReviewerCandidates({ workspaceId: W, runId: RUN });
    if (on.status !== "ok") throw new Error(on.status);
    expect(on.reviewers.map((r) => r.uid)).not.toContain(MEMBER);
    expect(on.reviewers.map((r) => r.uid)).toContain(MEMBER2);
    flags.REPORT_REVIEW_ENABLED = false;
    const off = await getReviewerCandidates({ workspaceId: W, runId: RUN });
    if (off.status !== "ok") throw new Error(off.status);
    expect(off.reviewers.map((r) => r.uid)).toContain(MEMBER);
  });

  it("ON: a governed run's candidates are unchanged", async () => {
    run({ governanceRecord: { humanReview: { status: "unreviewed" } }, legacyAdaptiveOutput: undefined });
    const res = await getReviewerCandidates({ workspaceId: W, runId: RUN });
    if (res.status !== "ok") throw new Error(res.status);
    expect(res.reviewers.map((r) => r.uid)).toContain(MEMBER);
  });
});

describe("missing composite index is recognised", () => {
  it.each([
    [{ code: 9, message: "9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/..." }, true],
    [{ code: "failed-precondition", message: "The query requires an index" }, true],
    [{ code: 9, message: "FAILED_PRECONDITION: transaction precondition" }, false],
    [{ code: 14, message: "UNAVAILABLE: index" }, false],
    [new Error("requires an index"), false],
    [null, false],
  ])("%j → %s", (err, expected) => {
    expect(isMissingIndexError(err)).toBe(expected);
  });
});

describe("queue scan: a missing index in the MERGED scan is index_unavailable; the governed scan is unchanged", () => {
  const indexError = Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/x"), { code: 9 });
  const args = { view: "needs_review" as const, workspaceId: W, uid: OWNER, callerCandidate: { uid: OWNER, workspaceId: W, role: "owner" as const, status: "active" as const }, projectFilter: undefined, limit: 5, cursor: null };
  let original: typeof db.collection;
  beforeEach(() => {
    original = db.collection.bind(db);
    // Every query on `runs` fails the way Firestore fails a query whose composite index is missing.
    (db as unknown as { collection: (n: string) => unknown }).collection = (name: string) => {
      const real = original(name) as unknown as Record<string, unknown>;
      if (name !== "runs") return real;
      const failing: Record<string, unknown> = {};
      for (const m of ["where", "orderBy", "startAfter", "limit"]) failing[m] = () => failing;
      failing.get = async () => {
        throw indexError;
      };
      return failing;
    };
  });
  afterEach(() => {
    (db as unknown as { collection: unknown }).collection = original;
  });
  it("ON (merged): index_unavailable", async () => {
    expect(await getReviewQueue(args)).toEqual({ status: "index_unavailable" });
  });
  it("OFF (governed only): query_failed, exactly as before B3", async () => {
    flags.REPORT_REVIEW_ENABLED = false;
    expect(await getReviewQueue(args)).toEqual({ status: "query_failed" });
  });
});
