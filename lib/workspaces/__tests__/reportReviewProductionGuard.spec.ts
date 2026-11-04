/**
 * Option C — Production-only report-review guard (owner decision 2026-11-04).
 *
 * The REAL deployment-environment module is used here (no mock): it reads `process.env.VERCEL_ENV`, which each test sets
 * explicitly. The rollout switch and allow-list are mocked ON for workspace W, so every refusal below can come only from
 * the deployment guard. Firestore is the in-memory transactional fake; no Production data is read or written.
 */
import { Timestamp } from "firebase-admin/firestore";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const cfg: { enabled: unknown; list: unknown } = { enabled: true, list: ["wsPilot"] };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return cfg.enabled;
  },
  get REPORT_REVIEW_WORKSPACE_ALLOWLIST() {
    return cfg.list;
  },
}));
// NOTE: "@/lib/workspaces/reportReviewDeploymentEnvironment" is deliberately NOT mocked.
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
import { isProductionDeployment } from "@/lib/workspaces/reportReviewDeploymentEnvironment";
import { isReportReviewEnabledForWorkspace, reportReviewActivationConfig } from "@/lib/workspaces/reportReviewActivation";
import { submitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { getReportReviewContext } from "@/lib/workspaces/reportReviewContext";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { getReviewerCandidates } from "@/lib/workspaces/reviewerCandidates";
import { isMergedReviewQueueView } from "@/lib/workspaces/reviewQueueMode";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";
import { POST as submitPost, GET as contextGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route";
import { POST as decisionPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/decision/route";
import { GET as exportGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route";

const W = "wsPilot";
const O = "wsOther";
const OWNER = "uid-owner"; // owner and creator of the run
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const REVIEWER = "uid-reviewer";
const REVIEWER2 = "uid-reviewer2";
const RUN = "run-w";
const RUN_O = "run-o";
const NOW = Timestamp.fromDate(new Date("2026-11-04T10:00:00Z"));
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = v;
}
function membership(ws: string, uid: string, role: string, status = "active") {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status, createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}
function genericRun(id: string, ws: string) {
  db.seed(`runs/${id}`, {
    userId: OWNER,
    workspaceId: ws,
    projectId: null,
    question: `Q ${id}`,
    selectedModels: ["chatgpt"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "answer", wasTruncated: false }] },
    legacyAdaptiveOutput: { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "x", results: [], alignedClaims: [] },
  });
}
const rr = (id = RUN) => db.read(`runs/${id}`)!.reportReview as ReportReviewRecordV1 | undefined;
const params = (ws: string, run: string) => ({ params: { workspaceId: ws, runId: run } });
const base = (ws: string, run: string) => `http://localhost/api/workspaces/${ws}/runs/${run}/report-review`;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const submit = (uid: string, ws = W, runId = RUN) => submitReportReview({ uid, workspaceId: ws, runId, purpose: { code: "internal_review" }, now: "2026-11-04T11:00:00.000Z" });
const assign = (actor: string, reviewer: string) => putWorkspaceReviewAssignment({ uid: actor, workspaceId: W, runId: RUN, assignedReviewerUserId: reviewer, expectedRevision: 0, dueAt: null, now: "2026-11-04T11:05:00.000Z" });
const decide = (uid: string, ws = W, runId = RUN) =>
  decideReportReview({ uid, workspaceId: ws, runId, decision: { status: "approved", comment: "ok" }, expectedCycle: rr(runId)?.cycle ?? 1, expectedUpdatedAt: rr(runId)?.updatedAt ?? "x", now: "2026-11-04T12:00:00.000Z" });

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  cfg.enabled = true;
  cfg.list = [W];
  identity.uid = OWNER;
  setEnv("production");
  for (const ws of [W, O]) {
    db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: ws, ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
    membership(ws, OWNER, "owner");
    membership(ws, ADMIN, "admin");
    membership(ws, MEMBER, "member");
    membership(ws, REVIEWER, "reviewer");
    membership(ws, REVIEWER2, "reviewer");
  }
  genericRun(RUN, W);
  genericRun(RUN_O, O);
});
afterAll(() => setEnv(ORIGINAL_VERCEL_ENV));

describe("deployment environment: exact Production only, everything else fails closed", () => {
  it("only the exact value \"production\" is Production", () => {
    setEnv("production");
    expect(isProductionDeployment()).toBe(true);
    for (const v of [undefined, "", "preview", "development", "Production", "PRODUCTION", " production", "production ", "prod", "production\n", "test"]) {
      setEnv(v);
      expect(isProductionDeployment()).toBe(false);
    }
  });

  it.each([
    ["Production + switch ON + allow-listed Workspace", "production", W, true],
    ["Production + switch ON + other Workspace", "production", O, false],
    ["Preview + switch ON + allow-listed Workspace", "preview", W, false],
    ["Development + switch ON + allow-listed Workspace", "development", W, false],
    ["unset (local next dev, Jest, CI) + switch ON + allow-listed Workspace", undefined, W, false],
    ["empty + switch ON + allow-listed Workspace", "", W, false],
    ["malformed (case) + switch ON + allow-listed Workspace", "Production", W, false],
    ["malformed (whitespace) + switch ON + allow-listed Workspace", " production ", W, false],
  ] as const)("%s → %s", (_label, env, ws, expected) => {
    setEnv(env);
    expect(isReportReviewEnabledForWorkspace(ws)).toBe(expected);
  });

  it("the guard is checked first: outside Production even a malformed allow-list reports disabled, never invalid", () => {
    cfg.list = [W, O];
    setEnv("production");
    expect(reportReviewActivationConfig()).toEqual({ status: "invalid" });
    setEnv("preview");
    expect(reportReviewActivationConfig()).toEqual({ status: "disabled" });
  });

  it("in Production the switch and allow-list still apply (the guard grants nothing)", () => {
    setEnv("production");
    cfg.enabled = false;
    expect(isReportReviewEnabledForWorkspace(W)).toBe(false);
    cfg.enabled = true;
    cfg.list = [];
    expect(isReportReviewEnabledForWorkspace(W)).toBe(false);
  });
});

describe("Preview + switch ON + allow-listed Workspace: every server-side surface refuses", () => {
  it("routes, mutations, context, queue and assignment hooks behave as if the feature were off — with a Production positive control", async () => {
    // Create a real report review in Production first, so every refusal below can only come from the gate.
    setEnv("production");
    expect((await submit(MEMBER)).ok).toBe(true);
    setEnv("preview");
    identity.uid = MEMBER;
    expect((await submitPost(post(base(W, RUN), { purpose: { code: "internal_review" } }), params(W, RUN))).status).toBe(404);
    expect(await submit(MEMBER, W, RUN)).toEqual({ ok: false, reason: "disabled" });
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "disabled" });
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(base(W, RUN)), params(W, RUN))).status).toBe(404);
    expect(await getReportReviewContext({ uid: OWNER, workspaceId: W, runId: RUN })).toEqual({ status: "not_found" });
    expect((await exportGet(new NextRequest(`${base(W, RUN)}/export?format=json`), params(W, RUN))).status).toBe(404);
    expect((await decisionPost(post(`${base(W, RUN)}/decision`, { decision: { status: "approved" }, expectedCycle: 1, expectedUpdatedAt: "x" }), params(W, RUN))).status).toBe(404);
    expect(isMergedReviewQueueView("needs_review", W)).toBe(false);
    // Dormant assignment hooks: the submitter (MEMBER) stays a candidate and is assignable, as when the feature is off.
    const cands = await getReviewerCandidates({ workspaceId: W, runId: RUN });
    expect(cands.status === "ok" && cands.reviewers.map((r) => r.uid)).toContain(MEMBER);

    // Positive control: the same request in Production is admitted.
    setEnv("production");
    expect((await contextGet(new NextRequest(base(W, RUN)), params(W, RUN))).status).toBe(200);
    expect(isMergedReviewQueueView("needs_review", W)).toBe(true);
    const candsProd = await getReviewerCandidates({ workspaceId: W, runId: RUN });
    expect(candsProd.status === "ok" && candsProd.reviewers.map((r) => r.uid)).not.toContain(MEMBER);
    expect(candsProd.status === "ok" && candsProd.reviewers.map((r) => r.uid)).toContain(REVIEWER);
  });

  it("client-supplied environment hints are ignored (headers, query string)", async () => {
    setEnv("preview");
    identity.uid = MEMBER;
    const spoof = { "x-vercel-env": "production", "x-vercel-deployment-url": "convergepanel.com", "x-forwarded-host": "convergepanel.com", "vercel-env": "production" };
    expect((await submitPost(post(`${base(W, RUN)}?VERCEL_ENV=production&env=production`, { purpose: { code: "internal_review" } }, spoof), params(W, RUN))).status).toBe(404);
    identity.uid = OWNER;
    expect((await contextGet(new NextRequest(`${base(W, RUN)}?VERCEL_ENV=production`, { headers: spoof }), params(W, RUN))).status).toBe(404);
    expect(rr()).toBeUndefined();
  });

  it("development and unset environments refuse too", async () => {
    for (const env of ["development", undefined] as const) {
      setEnv(env);
      expect(await submit(MEMBER)).toEqual({ ok: false, reason: "disabled" });
      expect(rr()).toBeUndefined();
    }
  });
});

describe("Production + switch ON + allow-listed Workspace: review invariants unchanged", () => {
  it("other Workspace refused; the reviewer must be assigned; creator and submitter cannot decide; the assignee can", async () => {
    setEnv("production");
    expect(await submit(MEMBER, O, RUN_O)).toEqual({ ok: false, reason: "disabled" });
    expect((await submit(MEMBER)).ok).toBe(true);
    for (const uid of [REVIEWER, REVIEWER2, ADMIN]) expect(await decide(uid)).toEqual({ ok: false, reason: "not_authorized", denial: "not_assigned" });
    expect(await decide(OWNER)).toEqual({ ok: false, reason: "not_authorized", denial: "self_review" }); // creator
    expect(await assign(ADMIN, OWNER)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } }); // creator
    expect(await assign(ADMIN, MEMBER)).toEqual({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } }); // submitter
    db.seed(`runs/${RUN}/humanReviewAssignment/current`, { schemaVersion: 1, teamId: null, runId: RUN, assignedReviewerUserId: MEMBER, assignedAt: "x", assignedByUserId: ADMIN, updatedAt: "x", updatedByUserId: ADMIN, revision: 1, workspaceId: W, projectId: null, dueAt: null, cycle: 1 });
    expect(await decide(MEMBER)).toEqual({ ok: false, reason: "not_authorized", denial: "submitter" });
    db.docs.delete(`runs/${RUN}/humanReviewAssignment/current`);
    expect((await assign(ADMIN, REVIEWER)).ok).toBe(true);
    expect((await decide(REVIEWER)).ok).toBe(true);
    expect(rr()!.humanReview.status).toBe("approved");
  });

  it("a switch-off flip back in Production stops new operations immediately (rollback path)", async () => {
    setEnv("production");
    expect((await submit(MEMBER)).ok).toBe(true);
    cfg.enabled = false;
    expect(await decide(REVIEWER)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("static: the guard is the single reader of the deployment signal", () => {
  it("among report-review modules only reportReviewDeploymentEnvironment.ts reads VERCEL_ENV, and activation imports it", () => {
    const dir = join(__dirname, "..");
    const files = readdirSync(dir).filter((f) => /^(reportReview|reviewQueue).*\.ts$/.test(f));
    const readers = files.filter((f) => /VERCEL_ENV/.test(readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(readers).toEqual(["reportReviewDeploymentEnvironment.ts"]);
    const activation = readFileSync(join(dir, "reportReviewActivation.ts"), "utf8");
    expect(activation).toMatch(/import \{ isProductionDeployment \} from "\.\/reportReviewDeploymentEnvironment";/);
    expect(activation).toMatch(/if \(!isProductionDeployment\(\)\) return \{ status: "disabled" \};\s*return evaluateReportReviewActivation\(/);
    // No NEXT_PUBLIC_ variant of the signal exists anywhere in the guard.
    const guardCode = readFileSync(join(dir, "reportReviewDeploymentEnvironment.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(guardCode).toMatch(/process\.env\.VERCEL_ENV === "production"/);
    expect(guardCode).not.toMatch(/NEXT_PUBLIC_/);
  });
});
