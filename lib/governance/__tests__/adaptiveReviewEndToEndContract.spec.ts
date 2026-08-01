/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — a focused,
 * non-browser END-TO-END CONTRACT test (docs/governance-decision-receipts-design.md
 * §26.22). Exercises the REAL detail GET route and the REAL decision POST
 * route together against one shared, in-memory Firestore-like fake — never
 * mocking away the concurrency token itself. Only the Firestore Admin SDK
 * boundary and team-auth boundary are mocked (the same boundaries every
 * other route test in this repo mocks); `parseGovernanceRecord`,
 * `applyHumanReviewUpdate`, `isHumanReviewStatusReviewable`,
 * `buildAdaptiveReviewDetailResponse`, and the routes' own logic are all
 * REAL.
 */

const runDocs = new Map<string, Record<string, any>>();
const teamRunDocs = new Map<string, Record<string, any>>();
const auditDocs = new Map<string, Record<string, any>>();
const eventsByRunId = new Map<string, Record<string, unknown>[]>();
const historyDocs = new Map<string, Record<string, any>>();

function applyDotPathUpdate(target: Record<string, any>, fields: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(fields)) {
    const segments = path.split(".");
    let cursor = target;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (typeof cursor[segment] !== "object" || cursor[segment] === null) cursor[segment] = {};
      cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
  }
}

function notFoundError(id: string) {
  const err: any = new Error("5 NOT_FOUND: No document to update: " + id);
  err.code = 5;
  return err;
}

function alreadyExistsError() {
  const err: any = new Error("6 ALREADY_EXISTS");
  err.code = 6;
  return err;
}

function topLevelStoreFor(name: string): Map<string, Record<string, any>> | null {
  if (name === "runs") return runDocs;
  if (name === "teamRuns") return teamRunDocs;
  if (name === "admin_audit_logs") return auditDocs;
  return null;
}

const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      id,
      get: jest.fn().mockImplementation(async () => {
        const store = topLevelStoreFor(name);
        if (!store) throw new Error(`unexpected top-level get on ${name}`);
        return { exists: store.has(id), data: () => store.get(id) };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        const store = topLevelStoreFor(name);
        if (!store || !store.has(id)) throw notFoundError(id);
        applyDotPathUpdate(store.get(id)!, fields);
      }),
      create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
        const store = topLevelStoreFor(name);
        if (!store) throw new Error(`unexpected top-level create on ${name}`);
        if (store.has(id)) throw alreadyExistsError();
        store.set(id, value);
      }),
      collection: (subName: string) => ({
        add: jest.fn().mockImplementation(async (event: Record<string, unknown>) => {
          const key = `${id}/${subName}`;
          const existing = eventsByRunId.get(key) || [];
          existing.push(event);
          eventsByRunId.set(key, existing);
          return { id: `event-${existing.length}` };
        }),
        doc: (docId: string) => ({
          create: jest.fn().mockImplementation(async (value: Record<string, unknown>) => {
            const key = `${id}/${subName}/${docId}`;
            if (historyDocs.has(key)) throw alreadyExistsError();
            historyDocs.set(key, value);
          }),
          // Multi-Reviewer Panel Foundation, Part B — the decision route's
          // panel-presence gate now reads `humanReviewPanel/current` on
          // every POST. No test in this file ever creates a panel, so this
          // always correctly reports "not found" (absent), never
          // "read_failed" — the fake must support the read at all so the
          // panel gate doesn't fail CLOSED (503) by mistake for every
          // single test in this file, per its own deliberate fail-closed design.
          get: jest.fn().mockImplementation(async () => {
            const key = `${id}/${subName}/${docId}`;
            return { exists: historyDocs.has(key), data: () => historyDocs.get(key) };
          }),
        }),
        get: jest.fn().mockImplementation(async () => {
          const prefix = `${id}/${subName}/`;
          const docs = [...historyDocs.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ id: key.slice(prefix.length), data: () => value }));
          return { docs };
        }),
      }),
    }),
  }),
  runTransaction: jest.fn().mockImplementation(async (fn: (txn: any) => Promise<any>) => {
    const txn = {
      get: async (ref: { id: string }) => ({ exists: runDocs.has(ref.id), data: () => runDocs.get(ref.id) }),
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
    return mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TEAM_ID = "team-1";
const RUN_ID = "run-1";
const CALLER_UID = "reviewer-uid";
const PROJECTION_ID = `${TEAM_ID}:${RUN_ID}`;

jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: jest.fn().mockResolvedValue(CALLER_UID),
  loadUserAndTeam: jest.fn().mockResolvedValue({ user: { name: "Reviewer" }, team: { id: TEAM_ID } }),
  memberRole: jest.fn().mockReturnValue("admin"),
  isTeamAdmin: jest.fn().mockReturnValue(true),
}));

import { NextRequest } from "next/server";
import { GET as getDetail } from "@/app/api/teams/adaptive-runs/[runId]/route";
import { POST as postDecision } from "@/app/api/teams/adaptive-runs/[runId]/decision/route";
import { GET as getHistory } from "@/app/api/teams/adaptive-runs/[runId]/history/route";

function seedValidRun(overrides: Record<string, unknown> = {}) {
  runDocs.set(RUN_ID, {
    userId: "owner-uid",
    governanceRecord: {
      version: 1,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      adaptiveOutputVersion: 1,
      automatedGovernance: { status: "flagged", reasons: ["2 model(s) failed"], evaluatedAt: "2026-07-29T00:00:00.000Z", policyVersion: 3 },
      humanReview: { status: "unreviewed" },
      decisionReceipt: {
        conclusion: "The panel recommends option A.",
        basis: ["b1"],
        assumptions: ["a1"],
        uncertainties: ["u1"],
        limitations: ["l1"],
        sources: ["s1"],
        sourceBacked: true,
        humanReviewNeeded: false,
      },
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
      ...overrides,
    },
  });
}

function seedValidProjection() {
  teamRunDocs.set(PROJECTION_ID, {
    projectionVersion: 1,
    adaptive: true,
    teamId: TEAM_ID,
    userId: "owner-uid",
    runId: RUN_ID,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "The panel recommends option A.",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  });
}

async function fetchDetail() {
  const req = new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}`);
  const res = await getDetail(req, { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

async function postDecisionRequest(body: unknown) {
  const req = new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await postDecision(req, { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

async function fetchHistory() {
  const req = new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/history`);
  const res = await getHistory(req, { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

beforeEach(() => {
  runDocs.clear();
  teamRunDocs.clear();
  auditDocs.clear();
  eventsByRunId.clear();
  historyDocs.clear();
  seedValidRun();
  seedValidProjection();
});

describe("Adaptive review — end-to-end contract (detail GET -> decision POST -> detail GET)", () => {
  it("the detail response's updatedAt, used as expectedUpdatedAt, is accepted by the decision route and commits", async () => {
    const { json: detailBefore } = await fetchDetail();
    expect(detailBefore.review.reviewable).toBe(true);
    expect(detailBefore.review.humanReview.status).toBe("unreviewed");

    const { res: decisionRes, json: decisionJson } = await postDecisionRequest({
      status: "approved",
      expectedUpdatedAt: detailBefore.review.updatedAt,
    });

    expect(decisionRes.status).toBe(200);
    expect(decisionJson.ok).toBe(true);
    expect(decisionJson.review.status).toBe("approved");
    expect(["synced", "failed"]).toContain(decisionJson.projectionSyncStatus);
  });

  it("a subsequent detail GET reflects the new canonical terminal state with reviewable:false", async () => {
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({ status: "rejected", comment: "Not acceptable.", expectedUpdatedAt: detailBefore.review.updatedAt });

    const { json: detailAfter } = await fetchDetail();
    expect(detailAfter.review.humanReview.status).toBe("rejected");
    expect(detailAfter.review.reviewable).toBe(false);
  });

  it("a second submission using the now-stale original expectedUpdatedAt is rejected", async () => {
    const { json: detailBefore } = await fetchDetail();
    const first = await postDecisionRequest({ status: "approved", expectedUpdatedAt: detailBefore.review.updatedAt });
    expect(first.res.status).toBe(200);

    // Second submission reuses the SAME (now stale) expectedUpdatedAt captured before the first commit.
    const second = await postDecisionRequest({ status: "rejected", comment: "too late", expectedUpdatedAt: detailBefore.review.updatedAt });
    expect(second.res.status).toBe(409);
    expect(second.json.error.code).toBe("stale_expected_updated_at");
  });

  it("a submission against an already-terminal record is rejected as a terminal conflict, not stale", async () => {
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({ status: "approved", expectedUpdatedAt: detailBefore.review.updatedAt });

    const { json: detailAfter } = await fetchDetail();
    const second = await postDecisionRequest({ status: "rejected", comment: "x", expectedUpdatedAt: detailAfter.review.updatedAt });
    expect(second.res.status).toBe(409);
    expect(second.json.error.code).toBe("terminal_review_exists");
  });

  it("the canonical governanceRecord's sibling fields are never touched by the decision", async () => {
    const before = JSON.parse(JSON.stringify(runDocs.get(RUN_ID)!.governanceRecord));
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({ status: "approved", expectedUpdatedAt: detailBefore.review.updatedAt });

    const after = runDocs.get(RUN_ID)!.governanceRecord;
    expect(after.automatedGovernance).toEqual(before.automatedGovernance);
    expect(after.decisionReceipt).toEqual(before.decisionReceipt);
    expect(after.schemaId).toBe(before.schemaId);
    expect(after.createdAt).toBe(before.createdAt);
  });
});

describe("Adaptive review — end-to-end immutable history and admin audit", () => {
  it("a committed decision produces exactly one immutable history record and one admin audit record", async () => {
    const { json: detailBefore } = await fetchDetail();
    const { json: decisionJson } = await postDecisionRequest({ status: "approved", expectedUpdatedAt: detailBefore.review.updatedAt });

    expect(decisionJson.historyStatus).toBe("recorded");
    expect(decisionJson.auditStatus).toBe("recorded");
    expect(historyDocs.size).toBe(1);
    expect(auditDocs.size).toBe(1);
  });

  it("the immutable history record is readable through the real history endpoint, with only compact fields", async () => {
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({ status: "approved_with_conditions", conditions: ["Fix citation"], expectedUpdatedAt: detailBefore.review.updatedAt });

    const { res, json } = await fetchHistory();
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toEqual({
      priorStatus: "unreviewed",
      newStatus: "approved_with_conditions",
      reviewedAt: expect.any(String),
      commentPresent: false,
      conditionsCount: 1,
    });
  });

  it("the admin audit record contains only safe metadata, never comment/conditions/receipt content", async () => {
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({
      status: "rejected",
      comment: "SENSITIVE REJECTION REASONING",
      expectedUpdatedAt: detailBefore.review.updatedAt,
    });

    expect(auditDocs.size).toBe(1);
    const stored = [...auditDocs.values()][0];
    expect(stored.action).toBe("adaptive_human_review_decided");
    expect(JSON.stringify(stored)).not.toContain("SENSITIVE REJECTION REASONING");
    expect(JSON.stringify(stored)).not.toContain("The panel recommends option A."); // receipt conclusion
  });

  it("a stale/rejected second submission never produces a second history or audit record", async () => {
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({ status: "approved", expectedUpdatedAt: detailBefore.review.updatedAt });
    expect(historyDocs.size).toBe(1);
    expect(auditDocs.size).toBe(1);

    // Stale — reuses the original (now outdated) expectedUpdatedAt.
    const staleResult = await postDecisionRequest({ status: "rejected", comment: "too late", expectedUpdatedAt: detailBefore.review.updatedAt });
    expect(staleResult.res.status).toBe(409);
    expect(historyDocs.size).toBe(1);
    expect(auditDocs.size).toBe(1);

    // Terminal — using the fresh (now terminal) updatedAt still fails, since the record is no longer reviewable.
    const { json: detailAfter } = await fetchDetail();
    const terminalResult = await postDecisionRequest({ status: "rejected", comment: "x", expectedUpdatedAt: detailAfter.review.updatedAt });
    expect(terminalResult.res.status).toBe(409);
    expect(historyDocs.size).toBe(1);
    expect(auditDocs.size).toBe(1);
  });

  it("an invalid (400) request never produces a history or audit record", async () => {
    const { json: detailBefore } = await fetchDetail();
    const result = await postDecisionRequest({ status: "unreviewed", expectedUpdatedAt: detailBefore.review.updatedAt });
    expect(result.res.status).toBe(400);
    expect(historyDocs.size).toBe(0);
    expect(auditDocs.size).toBe(0);
  });

  it("the history record's metadata matches the canonical commit exactly (schema, answerShape, statuses, reviewedAt)", async () => {
    const { json: detailBefore } = await fetchDetail();
    const { json: decisionJson } = await postDecisionRequest({ status: "approved", expectedUpdatedAt: detailBefore.review.updatedAt });

    const stored = [...historyDocs.values()][0];
    expect(stored.schemaId).toBe("decision_support");
    expect(stored.answerShape).toBe("decision_support_view");
    expect(stored.priorStatus).toBe("unreviewed");
    expect(stored.newStatus).toBe("approved");
    expect(stored.reviewedAt).toBe(decisionJson.review.reviewedAt);
  });

  it("actor and team identity in both artifacts are server-derived, never client-suppliable (no such fields exist in the request body)", async () => {
    const { json: detailBefore } = await fetchDetail();
    await postDecisionRequest({
      status: "approved",
      expectedUpdatedAt: detailBefore.review.updatedAt,
      // Attempted spoofing — the route never reads these from the body at all.
      reviewerId: "attacker-uid",
      teamId: "attacker-team",
    } as any);

    const storedHistory = [...historyDocs.values()][0];
    const storedAudit = [...auditDocs.values()][0];
    expect(storedHistory.reviewerId).toBe(CALLER_UID);
    expect(storedHistory.teamId).toBe(TEAM_ID);
    expect(storedAudit.byUid).toBe(CALLER_UID);
    expect(storedAudit.teamId).toBe(TEAM_ID);
  });

  it("history remains empty for an unreviewed run — no premature record before any decision is made", async () => {
    const { json } = await fetchHistory();
    expect(json.items).toEqual([]);
  });
});
