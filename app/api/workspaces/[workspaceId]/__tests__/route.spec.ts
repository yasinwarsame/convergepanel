/**
 * ZCA L-4 — `GET /api/workspaces/[workspaceId]` (D-4 E-a): the access decision every Team Workspace page's
 * Server Component used to make on the cookie's identity, now on the bearer.
 */
const mockResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockResolveWorkspaceAccess(...a) }));
const mockReportReview = jest.fn();
jest.mock("@/lib/workspaces/reportReviewActivation", () => ({ isReportReviewEnabledForWorkspace: (...a: unknown[]) => mockReportReview(...a) }));
const mockAssignmentUi = jest.fn();
jest.mock("@/lib/workspaces/projectAssignmentUiAdmission", () => ({ projectAssignmentUiEnabledFor: (...a: unknown[]) => mockAssignmentUi(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/route";

const call = (workspaceId = "ws-1") => GET(new NextRequest("http://localhost/api/workspaces/" + workspaceId), { params: { workspaceId } });
const authed = (uid = "u1") => mockResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "bearer_token" });
const TEAM = (over: Record<string, unknown> = {}) => ({
  granted: true,
  workspaceType: "team",
  workspace: { id: "ws-canonical", name: "Acme Research", type: "team", ownerUserId: "owner", secretField: "never" },
  membership: { role: "admin", status: "active", userId: "u1", invitedBy: "someone" },
  capabilities: ["workspace.read", "members.read", "audit.read"],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReportReview.mockReturnValue(false);
  mockAssignmentUi.mockReturnValue(false);
});

describe("identity", () => {
  it.each(["missing_credentials", "invalid_session_cookie", "invalid_bearer_token", "credential_mismatch", "revoked_session", "expired_session"])(
    "%s → 401 and no access lookup",
    async (reason) => {
      mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason });
      expect((await call()).status).toBe(401);
      expect(mockResolveWorkspaceAccess).not.toHaveBeenCalled();
    },
  );
  it("a verifier outage → 503 auth_unavailable and no access lookup", async () => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "auth_unavailable" });
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: "auth_unavailable" });
    expect(mockResolveWorkspaceAccess).not.toHaveBeenCalled();
  });
});

describe("access (the pages' former gate)", () => {
  it("looks up access for the BEARER's uid and the route's workspace id", async () => {
    authed("u7");
    mockResolveWorkspaceAccess.mockResolvedValue(TEAM());
    await call("ws-9");
    expect(mockResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: "u7", workspaceId: "ws-9" });
  });

  it("every denial and a Personal Workspace answer byte-identical 404s", async () => {
    authed();
    const outcomes = [
      ...["workspace_not_found", "workspace_malformed", "not_owner", "team_workspaces_disabled", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"].map((reason) => ({ granted: false, reason })),
      { granted: true, workspaceType: "personal", workspace: { id: "p", name: "Mine" } },
    ];
    const bodies: string[] = [];
    for (const o of outcomes) {
      mockResolveWorkspaceAccess.mockResolvedValueOnce(o);
      const res = await call();
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("a transient lookup failure → 503, distinct from every denial (the pages threw, never notFound)", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const res = await call();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ errorCode: "unavailable" });
  });

  it("an empty workspace id → 404 without a lookup", async () => {
    authed();
    expect((await call("")).status).toBe(404);
    expect(mockResolveWorkspaceAccess).not.toHaveBeenCalled();
  });
});

describe("what crosses to the client", () => {
  it("returns exactly the fields the pages rendered from access — never the membership record or other workspace fields", async () => {
    authed("u1");
    mockResolveWorkspaceAccess.mockResolvedValue(TEAM());
    const res = await call("ws-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      workspace: { id: "ws-canonical", name: "Acme Research" },
      role: "admin",
      capabilities: ["workspace.read", "members.read", "audit.read"],
      reportReviewEnabled: false,
      projectAssignmentUiEnabled: false,
    });
  });

  it("report review is decided for the CANONICAL workspace id; assignment UI for the BEARER's uid", async () => {
    authed("u-bearer");
    mockResolveWorkspaceAccess.mockResolvedValue(TEAM());
    mockReportReview.mockImplementation((id: string) => id === "ws-canonical");
    mockAssignmentUi.mockImplementation((uid: string) => uid === "u-bearer");
    await expect((await call("ws-1")).json()).resolves.toMatchObject({ reportReviewEnabled: true, projectAssignmentUiEnabled: true });
    expect(mockReportReview).toHaveBeenCalledWith("ws-canonical");
    expect(mockAssignmentUi).toHaveBeenCalledWith("u-bearer");
  });

  it("every answer is private, no-store", async () => {
    authed();
    mockResolveWorkspaceAccess.mockResolvedValue(TEAM());
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
    mockResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
  });
});
