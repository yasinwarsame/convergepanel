/**
 * Owner Order B — single-workspace activation allow-list. Default deny; fail closed on any malformed configuration;
 * every report-review surface checks the Workspace it targets; normal authorization is unchanged; governed review and
 * every unlisted Workspace behave exactly as before.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const cfg: { enabled: unknown; list: unknown } = { enabled: true, list: ["wsTrial"] };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return cfg.enabled;
  },
  get REPORT_REVIEW_WORKSPACE_ALLOWLIST() {
    return cfg.list;
  },
}));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: async (_ws: string, uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  ...jest.requireActual("@/lib/governance/reviewerIdentity"),
  resolveReviewerDisplayNames: async (uids: string[]) => new Map(uids.map((u) => [u, `Name(${u})`])),
}));
const identity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => ({ status: "authenticated", uid: identity.uid, source: "session_cookie" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));

import { NextRequest } from "next/server";
import { evaluateReportReviewActivation, isReportReviewEnabledForWorkspace } from "@/lib/workspaces/reportReviewActivation";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { getReviewerCandidates } from "@/lib/workspaces/reviewerCandidates";
import { isMergedReviewQueueView } from "@/lib/workspaces/reviewQueueMode";
import { getReviewQueue } from "@/lib/workspaces/reviewQueue";
import { buildReportReviewRecord } from "@/lib/governance/reportReview";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { decodeReviewQueueCursor } from "@/lib/workspaces/reviewQueueCursor";
import { buildSeed, seedDb, W as Q, OWNER as Q_OWNER } from "./helpers/reviewQueueScenario";
import { POST as submitPost, GET as contextGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route";
import { POST as decisionPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/decision/route";
import { POST as resubmitPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/resubmit/route";
import { GET as exportGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route";

const T = "wsTrial";
const O = "wsOther";
const OWNER = "uid-owner"; // Owner of BOTH Workspaces (multiple memberships)
const MEMBER = "uid-member"; // Member of both
const REVIEWER = "uid-reviewer"; // Reviewer in both
const VIEWER = "uid-viewer";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));

function membership(ws: string, uid: string, role: string) {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
function genericRun(id: string, ws: string, extra: Record<string, unknown> = {}) {
  db.seed(`runs/${id}`, {
    userId: CREATOR,
    workspaceId: ws,
    projectId: null,
    question: `Q ${id}`,
    selectedModels: ["chatgpt"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "answer", wasTruncated: false }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "x", results: [], alignedClaims: [] },
    ...extra,
  });
}
/** A report review that exists in an UNLISTED Workspace (e.g. left over after a rollback): must stay dormant there. */
function legacyRecord() {
  return buildReportReviewRecord({ cycle: 1, scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 1, requestedModels: 1 }, purpose: { code: "other", note: null }, actorUid: MEMBER, now: "2026-11-02T09:00:00.000Z" });
}
const auditRows = (ws?: string) =>
  db
    .paths("workspaceMembershipEvents/")
    .map((p) => db.read(p)!)
    .filter((r) => typeof r.eventType === "string" && (r.eventType as string).startsWith("workspace_report_review_") && (!ws || r.workspaceId === ws));

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  cfg.enabled = true;
  cfg.list = [T];
  identity.uid = OWNER;
  for (const ws of [T, O]) {
    db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: ws, ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
    membership(ws, OWNER, "owner");
    membership(ws, MEMBER, "member");
    membership(ws, REVIEWER, "reviewer");
    membership(ws, VIEWER, "viewer");
    membership(ws, CREATOR, "member");
  }
  genericRun("rT", T);
  genericRun("rO", O);
});

describe("configuration (pure): default deny, fail closed", () => {
  it.each([
    ["switch off", false, ["wsTrial"], "disabled"],
    ["switch truthy but not true", "true", ["wsTrial"], "disabled"],
    ["empty allow-list", true, [], "disabled"],
    ["one workspace", true, ["wsTrial"], "active"],
    ["two workspaces (not a single-workspace trial)", true, ["wsTrial", "wsOther"], "invalid"],
    ["duplicate (counts as more than one)", true, ["wsTrial", "wsTrial"], "invalid"],
    ["not an array", true, "wsTrial", "invalid"],
    ["undefined", true, undefined, "invalid"],
    ["non-string id", true, [42], "invalid"],
    ["empty id", true, [""], "invalid"],
    ["path-like id", true, ["ws/x"], "invalid"],
    ["wildcard-like id", true, ["*"], "invalid"],
  ])("%s → %s", (_l, enabled, list, status) => {
    expect(evaluateReportReviewActivation(enabled, list).status).toBe(status);
  });

  it("a malformed configuration disables EVERY Workspace, including a listed one", () => {
    cfg.list = [T, T];
    expect([isReportReviewEnabledForWorkspace(T), isReportReviewEnabledForWorkspace(O)]).toEqual([false, false]);
    cfg.list = [T];
    expect([isReportReviewEnabledForWorkspace(T), isReportReviewEnabledForWorkspace(O), isReportReviewEnabledForWorkspace(undefined), isReportReviewEnabledForWorkspace(["wsTrial"])]).toEqual([true, false, false, false]);
  });
});

const params = (ws: string, run: string) => ({ params: { workspaceId: ws, runId: run } });
const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const base = (ws: string, run: string) => `http://localhost/api/workspaces/${ws}/runs/${run}/report-review`;

describe("every surface is restricted to the activated Workspace", () => {
  it.each([
    ["switch off", () => (cfg.enabled = false)],
    ["empty allow-list", () => (cfg.list = [])],
    ["malformed allow-list", () => (cfg.list = [T, O])],
  ])("%s: nothing works even in the trial Workspace", async (_l, setup) => {
    setup();
    expect(await submitReportReview({ uid: MEMBER, workspaceId: T, runId: "rT", purpose: { code: "other" } })).toEqual({ ok: false, reason: "disabled" });
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: T, runId: "rT" })).toEqual({ status: "not_found" });
    expect((await submitPost(post(base(T, "rT"), { purpose: { code: "other" } }), params(T, "rT"))).status).toBe(404);
    expect((await contextGet(new NextRequest(base(T, "rT")), params(T, "rT"))).status).toBe(404);
    expect((await exportGet(new NextRequest(`${base(T, "rT")}/export?format=json`), params(T, "rT"))).status).toBe(404);
    expect(isMergedReviewQueueView("needs_review", T)).toBe(false);
    expect(db.read("runs/rT")!.reportReview).toBeUndefined();
  });

  it("one Workspace: the full flow works there and only there (a member of both Workspaces gains nothing in the other)", async () => {
    // Trial Workspace: works.
    identity.uid = MEMBER;
    expect((await submitPost(post(base(T, "rT"), { purpose: { code: "other" } }), params(T, "rT"))).status).toBe(201);
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(base(T, "rT")), params(T, "rT"))).status).toBe(200);
    expect(isMergedReviewQueueView("needs_review", T)).toBe(true);
    // Other Workspace, same callers: every surface refuses, exactly as before Order B (concealed / disabled).
    identity.uid = MEMBER;
    expect((await submitPost(post(base(O, "rO"), { purpose: { code: "other" } }), params(O, "rO"))).status).toBe(404);
    expect(await submitReportReview({ uid: MEMBER, workspaceId: O, runId: "rO", purpose: { code: "other" } })).toEqual({ ok: false, reason: "disabled" });
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(base(O, "rO")), params(O, "rO"))).status).toBe(404);
    expect((await exportGet(new NextRequest(`${base(O, "rO")}/export?format=json`), params(O, "rO"))).status).toBe(404);
    expect((await resubmitPost(post(`${base(O, "rO")}/resubmit`, { purpose: { code: "other" }, expectedCycle: 1 }), params(O, "rO"))).status).toBe(404);
    expect((await decisionPost(post(`${base(O, "rO")}/decision`, { decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "x" }), params(O, "rO"))).status).toBe(404);
    expect(isMergedReviewQueueView("needs_review", O)).toBe(false);
    expect(db.read("runs/rO")!.reportReview).toBeUndefined();
    expect(auditRows(O)).toEqual([]);
    expect(auditRows(T)).toHaveLength(1);
  });

  it("wrong Workspace id: addressing the trial Workspace with another Workspace's run is still refused (containment unchanged)", async () => {
    identity.uid = MEMBER;
    expect((await submitPost(post(base(T, "rO"), { purpose: { code: "other" } }), params(T, "rO"))).status).toBe(404);
    expect(await submitReportReview({ uid: MEMBER, workspaceId: T, runId: "rO", purpose: { code: "other" } })).toEqual({ ok: false, reason: "run_not_found" });
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: T, runId: "rO" })).toEqual({ status: "not_found" });
    expect(db.read("runs/rO")!.reportReview).toBeUndefined();
  });

  it("normal authorization still applies inside the trial Workspace (the allow-list grants nothing)", async () => {
    expect(await submitReportReview({ uid: REVIEWER, workspaceId: T, runId: "rT", purpose: { code: "other" } })).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(await submitReportReview({ uid: VIEWER, workspaceId: T, runId: "rT", purpose: { code: "other" } })).toEqual({ ok: false, reason: "insufficient_capability" });
    expect(await submitReportReview({ uid: "uid-stranger", workspaceId: T, runId: "rT", purpose: { code: "other" } })).toMatchObject({ ok: false });
    const sub = await submitReportReview({ uid: MEMBER, workspaceId: T, runId: "rT", purpose: { code: "other" } });
    if (!sub.ok) throw new Error("submit");
    // The submitter can't be assigned; unassigned reviewers and the creator can't decide.
    expect(await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: T, runId: "rT", assignedReviewerUserId: MEMBER, expectedRevision: 0, dueAt: null })).toMatchObject({ ok: false });
    expect(await decideReportReview({ uid: REVIEWER, workspaceId: T, runId: "rT", decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: sub.record.updatedAt })).toMatchObject({ ok: false, reason: "not_authorized" });
    expect(await resubmitReportReview({ uid: REVIEWER, workspaceId: T, runId: "rT", purpose: { code: "other" }, expectedCycle: 1 })).toMatchObject({ ok: false });
  });

  it("an unlisted Workspace holding a leftover report review: dormant everywhere (assignment, candidates, queue, decisions)", async () => {
    db.seed("runs/rO", { ...db.read("runs/rO")!, reportReview: legacyRecord() });
    // Assignment behaves exactly as before B2: the submitter is assignable and no report-review audit row is written.
    expect((await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: O, runId: "rO", assignedReviewerUserId: MEMBER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
    expect(auditRows()).toEqual([]);
    const cands = await getReviewerCandidates({ workspaceId: O, runId: "rO" });
    expect(cands.status === "ok" && cands.reviewers.map((r) => r.uid)).toContain(MEMBER);
    expect(await decideReportReview({ uid: MEMBER, workspaceId: O, runId: "rO", decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "2026-11-02T09:00:00.000Z" })).toEqual({ ok: false, reason: "disabled" });
    // The queue for the unlisted Workspace is the governed-only scan: the leftover report review is not listed.
    const q = await getReviewQueue({ view: "needs_review", workspaceId: O, uid: OWNER, callerCandidate: { uid: OWNER, workspaceId: O, role: "owner", status: "active" }, projectFilter: undefined, limit: 10, cursor: null });
    expect(q.status === "ok" && q.items.map((i) => i.runId)).toEqual([]);
  });

  it("an unlisted Workspace's leftover report review: the route gate, context, export and Assigned-to-me each refuse it on their own", async () => {
    db.seed("runs/rO", { ...db.read("runs/rO")!, reportReview: legacyRecord() });
    // Each surface is checked directly, so a missing gate cannot be hidden by a later check.
    expect((await contextGet(new NextRequest(base(O, "rO")), params(O, "rO"))).status).toBe(404);
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: O, runId: "rO" })).toEqual({ status: "not_found" });
    expect((await exportGet(new NextRequest(`${base(O, "rO")}/export?format=json`), params(O, "rO"))).status).toBe(404);
    expect((await putWorkspaceReviewAssignment({ uid: OWNER, workspaceId: O, runId: "rO", assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null })).ok).toBe(true);
    const caller = { uid: REVIEWER, workspaceId: O, role: "reviewer" as const, status: "active" as const };
    for (const view of ["assigned_to_me", "needs_review"] as const) {
      const q = await getReviewQueue({ view, workspaceId: O, uid: REVIEWER, callerCandidate: caller, projectFilter: undefined, limit: 10, cursor: null });
      expect(q.status === "ok" && q.items.map((i) => i.runId)).toEqual([]);
    }
  });

  it("an unlisted Workspace's queue (real governed + report-review seed, paginated) is byte-identical with the feature on elsewhere and fully off", async () => {
    // The B2 scenario seeds valid governed runs AND report reviews in scenario Workspace Q; the trial Workspace is T.
    const seed = buildSeed();
    await seedDb(db as never, seed);
    const caller = { uid: Q_OWNER, workspaceId: Q, role: "owner" as const, status: "active" as const };
    const pages = async () => {
      const out: string[] = [];
      for (const view of ["needs_review", "changes_requested", "recently_approved", "assigned_to_me", "overdue"] as const) {
        let cursor: string | null = null;
        for (let i = 0; i < 50; i++) {
          const decoded = cursor ? decodeReviewQueueCursor(cursor) : null;
          const r = await getReviewQueue({ view, workspaceId: Q, uid: Q_OWNER, callerCandidate: caller, projectFilter: undefined, limit: 2, cursor: decoded && decoded.ok ? decoded.cursor : null });
          out.push(JSON.stringify(r));
          if (r.status !== "ok" || !r.nextCursor) break;
          cursor = r.nextCursor;
        }
      }
      return out;
    };
    const on = await pages();
    expect(on.some((p) => p.includes('"nextCursor"'))).toBe(true); // genuinely paginated
    expect(on.some((p) => p.includes('"recordKind"'))).toBe(false); // the seeded report reviews stay dormant
    cfg.enabled = false;
    expect(await pages()).toEqual(on);
  });

  it("queue: a report review in the trial Workspace is listed there; governed rows are listed in both Workspaces exactly as before", async () => {
    const gov = (id: string, ws: string) => genericRun(id, ws, { legacyAdaptiveOutput: undefined, governanceRecord: { version: 1, humanReview: { status: "pending" } } });
    gov("gT", T);
    gov("gO", O);
    await submitReportReview({ uid: MEMBER, workspaceId: T, runId: "rT", purpose: { code: "other" } });
    const caller = (ws: string) => ({ uid: OWNER, workspaceId: ws, role: "owner" as const, status: "active" as const });
    const qT = await getReviewQueue({ view: "needs_review", workspaceId: T, uid: OWNER, callerCandidate: caller(T), projectFilter: undefined, limit: 10, cursor: null });
    const qO = await getReviewQueue({ view: "needs_review", workspaceId: O, uid: OWNER, callerCandidate: caller(O), projectFilter: undefined, limit: 10, cursor: null });
    const cfgOff = async () => {
      cfg.enabled = false;
      const r = await getReviewQueue({ view: "needs_review", workspaceId: O, uid: OWNER, callerCandidate: caller(O), projectFilter: undefined, limit: 10, cursor: null });
      cfg.enabled = true;
      return r;
    };
    expect(qT.status === "ok" && qT.items.some((i) => i.runId === "rT" && i.recordKind === "report_review")).toBe(true);
    // The unlisted Workspace's queue is identical with the feature on (trial elsewhere) and fully off.
    expect(JSON.stringify(qO)).toBe(JSON.stringify(await cfgOff()));
  });
});

describe("UI and API agree", () => {
  it("the research pages pass exactly the gate's verdict for the page's own Workspace", async () => {
    const fs = jest.requireActual("fs") as typeof import("fs");
    for (const p of ["app/workspace/team/[workspaceId]/research/[runId]/page.tsx", "app/workspace/team/[workspaceId]/projects/[projectId]/research/[runId]/page.tsx"]) {
      expect(fs.readFileSync(require("path").join(__dirname, "../../..", p), "utf8")).toContain("reportReviewEnabled={isReportReviewEnabledForWorkspace(access.workspace.id)}");
    }
    // Where the page would show the panel, the panel's API answers; where it would not, the API conceals.
    for (const [ws, run] of [[T, "rT"], [O, "rO"]] as const) {
      const shown = isReportReviewEnabledForWorkspace(ws);
      const res = await contextGet(new NextRequest(base(ws, run)), params(ws, run));
      expect(res.status === 200).toBe(shown);
    }
  });

  it("no report-review module reads the raw switch any more: every surface goes through the one rule", () => {
    const fs = jest.requireActual("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "../../..");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === "__tests__" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
    const readers = [...walk(path.join(root, "lib")), ...walk(path.join(root, "app")), ...walk(path.join(root, "components"))]
      .filter((f) => /\bREPORT_REVIEW_ENABLED\b/.test(fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")))
      .map((f) => path.relative(root, f))
      .sort();
    expect(readers).toEqual(["lib/workspaces/reportReviewActivation.ts", "lib/workspaces/reportReviewRollout.ts"]);
  });
});
