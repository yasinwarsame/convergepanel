/**
 * ZCA L-3 — `GET /api/user/workspace-review-runs/[runId]` (D-4 E-d). These are the route-gate cases of
 * the former `/workspace/reviews/[runId]` Server Component, now asserted on the bearer-authorized
 * endpoint that makes the same decision (admission → getWorkspaceRunDetail; every denial the same 404).
 */
const mockResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

let approvalGlobal = false;
let approvalCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get APPROVAL_WORKFLOW_ENABLED() { return approvalGlobal; },
  get APPROVAL_WORKFLOW_CANARY_UIDS() { return approvalCanary; },
}));
const mockGetWorkspaceRunDetail = jest.fn();
jest.mock("@/lib/workspaces/workspaceRunDetail", () => ({ getWorkspaceRunDetail: (...a: unknown[]) => mockGetWorkspaceRunDetail(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/workspace-review-runs/[runId]/route";

const DETAIL = {
  runId: "run-1",
  workspaceId: "ws-1",
  workspaceName: "Acme Research",
  projectId: null,
  projectName: null,
  runLabel: "What are the top acquisition risks?",
  reviewStatus: "approved_with_conditions",
  createdAt: "2026-08-01T00:00:00.000Z",
  reviewedAt: "2026-08-05T00:00:00.000Z",
};
const call = (runId = "run-1") => GET(new NextRequest("http://localhost/api/user/workspace-review-runs/" + runId), { params: { runId } });
const authed = (uid = "u1") => mockResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "bearer_token" });

beforeEach(() => {
  approvalGlobal = false;
  approvalCanary = undefined;
  jest.clearAllMocks();
});

describe("identity", () => {
  it.each(["missing_credentials", "invalid_bearer_token", "revoked_session", "expired_session"])("%s → 401, and the run is never read", async (reason) => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason });
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockGetWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("a verifier outage → 503 auth_unavailable (never an allow), and the run is never read", async () => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "auth_unavailable" });
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: "auth_unavailable" });
    expect(mockGetWorkspaceRunDetail).not.toHaveBeenCalled();
  });
});

describe("the former page gate, now on the endpoint", () => {
  it("not admitted: getWorkspaceRunDetail IS called with approvalAdmitted:false (Phase 9C.4 drain rule lives there)", async () => {
    authed();
    mockGetWorkspaceRunDetail.mockResolvedValue({ status: "not_found" });
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u1", approvalAdmitted: false });
  });

  it("not admitted but drain-eligible (ok) → 200 with the detail", async () => {
    authed();
    mockGetWorkspaceRunDetail.mockResolvedValue({ status: "ok", detail: DETAIL });
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, detail: DETAIL });
  });

  it("SECURITY: canary present but uid does not match → admitted false", async () => {
    authed("u2");
    approvalCanary = "u1";
    mockGetWorkspaceRunDetail.mockResolvedValue({ status: "not_found" });
    await call();
    expect(mockGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u2", approvalAdmitted: false });
  });

  it("canary admission is decided for the BEARER's uid (canary u1, bearer u1 → admitted)", async () => {
    authed("u1");
    approvalCanary = "u1";
    mockGetWorkspaceRunDetail.mockResolvedValue({ status: "not_found" });
    await call();
    expect(mockGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u1", approvalAdmitted: true });
  });

  it("globally admitted → approvalAdmitted:true for the BEARER's uid", async () => {
    authed("u1");
    approvalGlobal = true;
    mockGetWorkspaceRunDetail.mockResolvedValue({ status: "ok", detail: DETAIL });
    await call();
    expect(mockGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u1", approvalAdmitted: true });
  });

  it("not_found and read_failed answer byte-identical 404s (no message reveals whether a run exists)", async () => {
    authed();
    approvalGlobal = true;
    mockGetWorkspaceRunDetail.mockResolvedValueOnce({ status: "not_found" });
    const a = await call();
    mockGetWorkspaceRunDetail.mockResolvedValueOnce({ status: "read_failed" });
    const b = await call();
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.text()).toBe(await b.text());
  });

  it("an empty runId → 404 without a read", async () => {
    authed();
    const res = await call("");
    expect(res.status).toBe(404);
    expect(mockGetWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("every answer is private, no-store", async () => {
    authed();
    mockGetWorkspaceRunDetail.mockResolvedValue({ status: "ok", detail: DETAIL });
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
  });
});
