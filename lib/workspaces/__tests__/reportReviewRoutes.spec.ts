/**
 * Order B, Stage B1 — the two Report Review routes: identity, Approval Workflow admission (concealed), exact bodies,
 * and the HTTP mapping of every mutation outcome (concealment preserved: nothing reveals whether a run exists).
 */
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const admission = { admitted: true };
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => admission }));
const rollout = { REPORT_REVIEW_ENABLED: true };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return rollout.REPORT_REVIEW_ENABLED;
  },
}));
const mockedSubmit = jest.fn();
const mockedResubmit = jest.fn();
jest.mock("@/lib/workspaces/reportReviewMutations", () => ({ submitReportReview: (...a: unknown[]) => mockedSubmit(...a), resubmitReportReview: (...a: unknown[]) => mockedResubmit(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST as submitPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route";
import { POST as resubmitPost } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/resubmit/route";
import { REPORT_REVIEW_DISCLAIMER } from "@/lib/governance/reportReview";
import { REPORT_REVIEW_INELIGIBLE_MESSAGES } from "@/lib/workspaces/reportReviewRouteSupport";

const params = { params: { workspaceId: "w1", runId: "r1" } };
const req = (body: unknown, path = "report-review") =>
  new NextRequest(`http://localhost/api/workspaces/w1/runs/r1/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });
const RECORD = { version: 1, kind: "report_review", cycle: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  admission.admitted = true;
  rollout.REPORT_REVIEW_ENABLED = true;
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid: "u1", source: "session_cookie" });
  mockedSubmit.mockResolvedValue({ ok: true, created: true, record: RECORD });
  mockedResubmit.mockResolvedValue({ ok: true, record: { ...RECORD, cycle: 2 }, archivedCycle: 1 });
});

async function json(res: Response) {
  return { status: res.status, body: await res.json() };
}

describe("identity and admission", () => {
  it("no credentials → 401; bad token → 401; nothing called", async () => {
    mockedIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await submitPost(req({ purpose: { code: "other" } }), params)).status).toBe(401);
    mockedIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "invalid_token" });
    expect((await resubmitPost(req({ purpose: { code: "other" }, expectedCycle: 1 }, "report-review/resubmit"), params)).status).toBe(401);
    expect(mockedSubmit).not.toHaveBeenCalled();
    expect(mockedResubmit).not.toHaveBeenCalled();
  });

  it("not admitted to Approval Workflow → the concealed 404, nothing called", async () => {
    admission.admitted = false;
    expect((await submitPost(req({ purpose: { code: "other" } }), params)).status).toBe(404);
    expect((await resubmitPost(req({ purpose: { code: "other" }, expectedCycle: 1 }, "report-review/resubmit"), params)).status).toBe(404);
    expect(mockedSubmit).not.toHaveBeenCalled();
  });
});

describe("dark first (review B1 NIT): with the switch off, every request is the concealed 404 before its body is read", () => {
  it.each([["valid body", { purpose: { code: "other" } }], ["malformed body", "{"], ["extra key", { x: 1 }]])("%s → 404, nothing called", async (_k, body) => {
    rollout.REPORT_REVIEW_ENABLED = false;
    const a = await json(await submitPost(req(body), params));
    const b = await json(await resubmitPost(req(body, "report-review/resubmit"), params));
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(mockedSubmit).not.toHaveBeenCalled();
    expect(mockedResubmit).not.toHaveBeenCalled();
  });
});

describe("bodies are exact", () => {
  it.each([["missing", undefined], ["string", "1"], ["zero", 0], ["fraction", 1.5], ["negative", -1]])("resubmit with expectedCycle %s → 400, no call (review B1-m4)", async (_k, expectedCycle) => {
    const body = expectedCycle === undefined ? { purpose: { code: "other" } } : { purpose: { code: "other" }, expectedCycle };
    expect((await json(await resubmitPost(req(body, "report-review/resubmit"), params))).status).toBe(400);
    expect(mockedResubmit).not.toHaveBeenCalled();
  });

  it.each([["not json", "{"], ["array", [1]], ["extra key", { purpose: { code: "other" }, cycle: 2 }], ["null", null]])("submit rejects %s with 400 and no call", async (_k, body) => {
    expect((await submitPost(req(body), params)).status).toBe(400);
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("resubmit accepts only { purpose, expectedCycle }", async () => {
    expect((await resubmitPost(req({ purpose: { code: "other" }, expectedCycle: 1, force: true }, "report-review/resubmit"), params)).status).toBe(400);
    expect(mockedResubmit).not.toHaveBeenCalled();
  });

  it("passes the caller's own uid and the URL ids, never body values", async () => {
    await submitPost(req({ purpose: { code: "client_delivery", note: "n" } }), params);
    expect(mockedSubmit).toHaveBeenCalledWith({ uid: "u1", workspaceId: "w1", runId: "r1", purpose: { code: "client_delivery", note: "n" } });
    await resubmitPost(req({ purpose: { code: "other" }, expectedCycle: 1 }, "report-review/resubmit"), params);
    expect(mockedResubmit).toHaveBeenCalledWith({ uid: "u1", workspaceId: "w1", runId: "r1", purpose: { code: "other" }, expectedCycle: 1 });
  });
});

describe("success responses carry the record and the fixed disclaimer", () => {
  it("created → 201; already open → 200 created:false", async () => {
    expect(await json(await submitPost(req({ purpose: { code: "other" } }), params))).toEqual({ status: 201, body: { ok: true, created: true, reportReview: RECORD, disclaimer: REPORT_REVIEW_DISCLAIMER } });
    mockedSubmit.mockResolvedValueOnce({ ok: true, created: false, record: RECORD });
    expect((await json(await submitPost(req({ purpose: { code: "other" } }), params))).status).toBe(200);
    expect(await json(await resubmitPost(req({ purpose: { code: "other" }, expectedCycle: 1 }, "report-review/resubmit"), params))).toEqual({
      status: 200,
      body: { ok: true, reportReview: { ...RECORD, cycle: 2 }, archivedCycle: 1, disclaimer: REPORT_REVIEW_DISCLAIMER },
    });
  });

  it("the disclaimer states approval is not factual verification", () => {
    expect(REPORT_REVIEW_DISCLAIMER).toBe(
      "Approval means a reviewer read this report and found it acceptable for its stated purpose. It does not mean its factual claims, sources or model confidence were verified, or that analysis missing from the report exists."
    );
  });
});

describe("failure mapping", () => {
  it.each([
    "disabled",
    "team_workspaces_disabled",
    "run_not_found",
    "workspace_not_found",
    "workspace_malformed",
    "membership_not_found",
    "membership_removed",
    "membership_malformed",
    "owner_integrity_violation",
  ])("%s → the same concealed 404", async (reason) => {
    mockedSubmit.mockResolvedValueOnce({ ok: false, reason });
    const r = await json(await submitPost(req({ purpose: { code: "other" } }), params));
    expect(r.status).toBe(404);
    // Identical body for every concealed reason.
    mockedSubmit.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    expect(r).toEqual(await json(await submitPost(req({ purpose: { code: "other" } }), params)));
  });

  it("insufficient_capability → 403 with the fixed sentence", async () => {
    mockedSubmit.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    expect(await json(await submitPost(req({ purpose: { code: "other" } }), params))).toEqual({
      status: 403,
      body: { ok: false, error: { code: "insufficient_capability", message: "Only members who can organize research can submit it for approval." } },
    });
  });

  it.each(Object.entries(REPORT_REVIEW_INELIGIBLE_MESSAGES))("ineligible %s → 409 ineligible_%s with its fixed reason", async (reason, message) => {
    mockedSubmit.mockResolvedValueOnce({ ok: false, reason: "ineligible", ineligible: reason });
    expect(await json(await submitPost(req({ purpose: { code: "other" } }), params))).toEqual({ status: 409, body: { ok: false, error: { code: `ineligible_${reason}`, message } } });
  });

  it.each([
    ["invalid_purpose", 400],
    ["active_panel", 409],
    ["not_decided", 409],
    ["cycle_conflict", 409],
    ["panel_unreadable", 500],
    ["record_malformed", 500],
    ["firestore_unavailable", 500],
    ["write_failed", 500],
  ])("%s → %i", async (reason, status) => {
    mockedResubmit.mockResolvedValueOnce({ ok: false, reason });
    expect((await resubmitPost(req({ purpose: { code: "other" }, expectedCycle: 1 }, "report-review/resubmit"), params)).status).toBe(status);
  });
});
