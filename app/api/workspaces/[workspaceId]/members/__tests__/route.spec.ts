/**
 * Team Workspace Self-Service Onboarding — GET /api/workspaces/{workspaceId}/members
 * tests. Mocks resolveWorkspaceAccess() and listWorkspaceMembers() (each
 * independently tested elsewhere) — this suite covers auth,
 * capability-gating, and status-code mapping only, matching the sibling
 * `projects/route.ts` GET test's exact structure and conventions.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => mockedResolveWorkspaceAccess(...args),
}));

const mockedListWorkspaceMembers = jest.fn();
jest.mock("@/lib/workspaces/listWorkspaceMembers", () => ({
  listWorkspaceMembers: (...args: unknown[]) => mockedListWorkspaceMembers(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/members/route";

const UID = "member-1";
const WS_ID = "ws-team-1";

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/members`, { method: "GET" });
}

async function callGet() {
  const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}

const SAMPLE_MEMBERS = [{ uid: UID, displayName: "Test Member", role: "member", isCanonicalOwner: false, joinedAt: "2026-01-01T00:00:00.000Z" }];

function grantedAccess(capabilities: string[], role = "member") {
  return { granted: true, workspaceType: "team", workspace: { id: WS_ID, type: "team" }, membership: { role }, capabilities };
}

// Exact frozen ROLE_CAPABILITIES matrix (lib/workspaces/capabilities.ts) —
// members.read is present for Owner/Admin/Member, absent for Reviewer/Viewer.
const OWNER_CAPS = ["workspace.read", "members.read", "members.invite", "members.manage", "audit.read", "projects.read", "projects.create", "projects.manage", "research.read", "research.create", "research.organize", "reviews.read", "reviews.submit", "reviews.manage", "reviews.override", "exports.create", "ownership.transfer", "admins.manage"];
const ADMIN_CAPS = ["workspace.read", "members.read", "members.invite", "members.manage", "audit.read", "projects.read", "projects.create", "projects.manage", "research.read", "research.create", "research.organize", "reviews.read", "reviews.submit", "reviews.manage", "exports.create"];
const MEMBER_CAPS = ["workspace.read", "members.read", "projects.read", "projects.create", "projects.manage", "research.read", "research.create", "research.organize", "reviews.read", "reviews.submit", "exports.create"];
const REVIEWER_CAPS = ["workspace.read", "projects.read", "research.read", "reviews.read", "reviews.submit"];
const VIEWER_CAPS = ["workspace.read", "projects.read", "research.read", "reviews.read"];

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedResolveWorkspaceAccess.mockResolvedValue(grantedAccess(MEMBER_CAPS));
  mockedListWorkspaceMembers.mockResolvedValue({ status: "listed", members: SAMPLE_MEMBERS });
});

describe("GET /api/workspaces/[workspaceId]/members — authentication", () => {
  it("A. unauthenticated -> 401, denied", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet();
    expect(res.status).toBe(401);
    expect(mockedListWorkspaceMembers).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces/[workspaceId]/members — role capability matrix (frozen ROLE_CAPABILITIES)", () => {
  it("C. Owner (has members.read) -> succeeds", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedAccess(OWNER_CAPS, "owner"));
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("D. Admin (has members.read) -> succeeds", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedAccess(ADMIN_CAPS, "admin"));
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("E. Member (has members.read per frozen matrix) -> succeeds", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedAccess(MEMBER_CAPS, "member"));
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("F. Reviewer (does NOT have members.read per frozen matrix) -> denied", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedAccess(REVIEWER_CAPS, "reviewer"));
    const { res, json } = await callGet();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
    expect(mockedListWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("G. Viewer (does NOT have members.read per frozen matrix) -> denied", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedAccess(VIEWER_CAPS, "viewer"));
    const { res, json } = await callGet();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
    expect(mockedListWorkspaceMembers).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces/[workspaceId]/members — concealment", () => {
  it("H. non-member (membership_not_found) -> concealed 404, byte-identical shape to every other Team read route", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
    expect(mockedListWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("I. cross-Workspace / foreign workspace_not_found -> same concealed 404 (no oracle distinguishing 'not admitted' from 'not a member of this specific one')", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "workspace_not_found" });
    const notMember = await callGet();
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "team_workspaces_disabled" });
    const notAdmitted = await callGet();
    expect(notMember.res.status).toBe(notAdmitted.res.status);
    expect(JSON.stringify(notMember.json)).toBe(JSON.stringify(notAdmitted.json));
  });

  it("Personal Workspace access -> concealed 404 (this route is Team-only)", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID } });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
    expect(mockedListWorkspaceMembers).not.toHaveBeenCalled();
  });

  it("owner_integrity_violation -> same concealed 404 family", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "owner_integrity_violation" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });
});

describe("GET /api/workspaces/[workspaceId]/members — response projection", () => {
  it("K. returns the exact allow-list DTO array from listWorkspaceMembers() verbatim — no additional/raw fields", async () => {
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, members: SAMPLE_MEMBERS });
  });

  it("L. does not serialize a raw membership/Firestore document — response body is exactly {ok, members}, nothing else", async () => {
    const { json } = await callGet();
    expect(Object.keys(json).sort()).toEqual(["members", "ok"]);
  });
});

describe("GET /api/workspaces/[workspaceId]/members — infrastructure", () => {
  it("firestore_unavailable from the core -> 500 internal error, not a domain denial", async () => {
    mockedListWorkspaceMembers.mockResolvedValue({ status: "firestore_unavailable" });
    const { res, json } = await callGet();
    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
  });

  it("query_failed from the core -> 500 internal error", async () => {
    mockedListWorkspaceMembers.mockResolvedValue({ status: "query_failed" });
    const { res } = await callGet();
    expect(res.status).toBe(500);
  });
});

describe("GET /api/workspaces/[workspaceId]/members — Ownership Transfer UI, Phase TEAM-MGMT-12C: OCC token pass-through", () => {
  it("passes result.workspaceUpdateToken through to the response verbatim, as a sibling field alongside members", async () => {
    const token = { seconds: 1723600000, nanoseconds: 0 };
    mockedListWorkspaceMembers.mockResolvedValue({ status: "listed", members: SAMPLE_MEMBERS, workspaceUpdateToken: token });
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, members: SAMPLE_MEMBERS, workspaceUpdateToken: token });
  });
});

describe("GET /api/workspaces/[workspaceId]/members — call wiring", () => {
  it("passes the resolved access.workspace object to listWorkspaceMembers() — never re-derives or re-fetches the Workspace itself", async () => {
    const access = grantedAccess(OWNER_CAPS, "owner");
    mockedResolveWorkspaceAccess.mockResolvedValue(access);
    await callGet();
    expect(mockedListWorkspaceMembers).toHaveBeenCalledWith({ workspace: access.workspace });
  });
});
