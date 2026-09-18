/**
 * TEAM-VERIFICATION-PARITY-R5-I1 §AC —
 * `GET /api/workspaces/{W}/video-verifications/{verificationId}`.
 *
 * Every distinguishable failure must collapse to ONE concealed 404, the
 * Workspace binding must come from the artifact's own persisted fields, a
 * Personal Video row must never fall back to creator ownership, and the
 * missing-Project case must degrade only the LABEL — never rewrite
 * `projectId` to `null`, which would misrepresent a filed Video as Unfiled.
 */

jest.mock("firebase-admin/firestore", () => require("@/lib/workspaces/__tests__/teamVideoFakeFirestore").fakeFirestoreModule);
let mockState: import("@/lib/workspaces/__tests__/teamVideoFakeFirestore").FakeState;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const { makeFakeDb } = require("@/lib/workspaces/__tests__/teamVideoFakeFirestore");
    return mockState.unavailable ? null : makeFakeDb(mockState);
  },
}));
const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: (...a: unknown[]) => mockedLogIdentityResolutionFailure(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedMapper = jest.fn();
jest.mock("@/lib/user/mapStoredVideoVerificationToClientPayload", () => ({ mapStoredVideoVerificationToClientPayload: (...a: unknown[]) => mockedMapper(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/video-verifications/[verificationId]/route";
import { capabilitiesForRole } from "@/lib/workspaces/capabilities";
import { createFakeState, TEAM_W, teamVideoDoc, teamVideoDocWithout, personalVideoDoc } from "@/lib/workspaces/__tests__/teamVideoFakeFirestore";

const VID = "vid-11111111-2222-3333-4444-555555555555";
const P = "p1";
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") => ({ granted: true, workspace: { id: TEAM_W, type: "team" }, membership: { role }, capabilities: [...capabilitiesForRole(role)] });
const foundProject = (overrides: Record<string, unknown> = {}) => ({ status: "found", project: { id: P, workspaceId: TEAM_W, name: "Project p1", status: "active", ...overrides } });
const CONCEALED = { status: 404, body: { ok: false, errorCode: "not_found", message: "Video verification not found." } };

function seed(...docs: ReturnType<typeof teamVideoDoc>[]) {
  mockState.collections.videoVerifications = docs;
}

async function get(query = "", verificationId = VID, uid = "reader-b", workspaceId = TEAM_W) {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/video-verifications/${encodeURIComponent(verificationId)}${query}`), { params: { workspaceId, verificationId } });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState = createFakeState();
  mockedAccess.mockResolvedValue(grant());
  mockedGetProject.mockResolvedValue(foundProject());
  mockedMapper.mockImplementation((id: string) => ({ verificationId: id, fileName: "clip.mp4", verdict: "authentic_captured" }));
});

describe("identity", () => {
  it("missing credentials -> 401 unauthorized, no access lookup, no read", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/video-verifications/${VID}`), { params: { workspaceId: TEAM_W, verificationId: VID } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, errorCode: "unauthorized", message: "Please sign in." });
    expect(mockedAccess).not.toHaveBeenCalled();
    expect(mockState.docGets).toEqual([]);
  });

  it.each(["invalid_bearer_token", "revoked_session", "credential_mismatch", "expired_session"])("auth resolver failure %s -> 401 auth_error", async (reason) => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason });
    const res = await GET(new NextRequest(`http://localhost/api/workspaces/${TEAM_W}/video-verifications/${VID}`), { params: { workspaceId: TEAM_W, verificationId: VID } });
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe("auth_error");
    expect(mockedAccess).not.toHaveBeenCalled();
  });
});

describe("Team Workspace authorization", () => {
  it.each(["team_workspaces_disabled", "workspace_not_found", "workspace_malformed", "wrong_workspace_type", "membership_not_found", "membership_removed", "membership_malformed", "owner_integrity_violation"])("denial %s -> concealed Team Workspace 404, no artifact read", async (reason) => {
    seed(teamVideoDoc(VID));
    mockedAccess.mockResolvedValueOnce({ granted: false, reason });
    const r = await get();
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe("team_workspace_not_found");
    expect(mockState.docGets).toEqual([]);
  });

  it("lookup_failed -> 503, no artifact read", async () => {
    seed(teamVideoDoc(VID));
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    expect((await get()).status).toBe(503);
    expect(mockState.docGets).toEqual([]);
  });

  it("granted without research.read -> 403 insufficient_capability, no artifact read", async () => {
    seed(teamVideoDoc(VID));
    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["workspace.read"] });
    const r = await get();
    expect(r.status).toBe(403);
    expect(r.body.errorCode).toBe("insufficient_capability");
    expect(mockState.docGets).toEqual([]);
  });

  it.each(["owner", "admin", "member", "reviewer", "viewer"] as const)("role %s reads an Unfiled Team Video", async (role) => {
    seed(teamVideoDoc(VID));
    mockedAccess.mockResolvedValueOnce(grant(role));
    expect((await get()).status).toBe(200);
  });

  it("never authorizes by the uploader: a non-uploader member reads it, the uploader without membership does not", async () => {
    seed(teamVideoDoc(VID, { userId: "uploader-a" }));
    expect((await get("", VID, "reader-b")).status).toBe(200);
    mockedAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    expect((await get("", VID, "uploader-a")).status).toBe(404);
  });
});

describe("one concealed 404 for every distinguishable failure", () => {
  it("a missing document", async () => {
    expect(await get()).toEqual(CONCEALED);
  });

  it.each([
    ["a PERSONAL Video row (no Team binding at all)", () => seed(personalVideoDoc(VID))],
    ["a row bound to another Workspace", () => seed(teamVideoDoc(VID, { workspaceId: "ws-other" }))],
    ["an empty workspaceId", () => seed(teamVideoDoc(VID, { workspaceId: "" }))],
    ["an ABSENT projectId field", () => seed(teamVideoDocWithout(VID, ["projectId"]))],
    ["a malformed projectId", () => seed(teamVideoDoc(VID, { projectId: 7 }))],
    ["an empty-string projectId", () => seed(teamVideoDoc(VID, { projectId: "" }))],
    ["a wrong type discriminator (a Claim row)", () => seed(teamVideoDoc(VID, { type: "claim_verification" }))],
    ["a non-Timestamp timestamp", () => seed(teamVideoDoc(VID, { timestamp: "2023-11-14T00:00:00.000Z" }))],
    ["an empty userId", () => seed(teamVideoDoc(VID, { userId: "" }))],
  ])("%s -> the identical concealed 404", async (_l, setup) => {
    setup();
    expect(await get()).toEqual(CONCEALED);
  });

  it.each(["", " ", "  vid-1", "vid-1 ", "a/b", ".", "..", "vid -1"])("a malformed verification id (%j) -> concealed 404 BEFORE any Firestore read", async (badId) => {
    seed(teamVideoDoc(VID));
    expect(await get("", badId)).toEqual(CONCEALED);
    expect(mockState.docGets).toEqual([]);
  });

  it("id syntax is checked before the Workspace access lookup, so it leaks nothing about membership", async () => {
    await get("", "a/b");
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it("a canonical vid-<uuid> id is accepted by the shared run-id syntax helper", async () => {
    seed(teamVideoDoc(VID));
    expect((await get()).status).toBe(200);
    expect(mockState.docGets).toEqual([`videoVerifications/${VID}`]);
  });
});

describe("infrastructure failures are 503, never a concealed 404", () => {
  it("Firestore unavailable -> 503", async () => {
    mockState.unavailable = true;
    expect((await get()).status).toBe(503);
  });

  it("a thrown artifact read -> 503", async () => {
    mockState.throwOnDocGetCollections.add("videoVerifications");
    seed(teamVideoDoc(VID));
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });
});

describe("Project containment via ?projectId", () => {
  it("no ?projectId: any Team Video contained by the Workspace is readable", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    expect((await get()).status).toBe(200);
  });

  it("an exactly matching ?projectId -> 200", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    expect((await get(`?projectId=${P}`)).status).toBe(200);
  });

  it("a WRONG ?projectId -> concealed 404, and no Project is read", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    expect(await get("?projectId=p2")).toEqual(CONCEALED);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("?projectId asserted against an UNFILED Video -> concealed 404", async () => {
    seed(teamVideoDoc(VID));
    expect(await get(`?projectId=${P}`)).toEqual(CONCEALED);
  });

  it.each(["", "a/b", ".", ".."])("a malformed ?projectId (%j) -> concealed 404, never a distinguishable 400", async (bad) => {
    seed(teamVideoDoc(VID, { projectId: P }));
    const r = await get(`?projectId=${encodeURIComponent(bad)}`);
    expect(r).toEqual(CONCEALED);
    expect(r.status).not.toBe(400);
  });
});

describe("Project label semantics", () => {
  it("projectId null -> genuinely Unfiled: project null, zero Project reads", async () => {
    seed(teamVideoDoc(VID));
    const r = await get();
    expect(r.body.team).toEqual({ workspaceId: TEAM_W, projectId: null, project: null, createdAt: expect.any(String) });
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("a filed Video in an ACTIVE Project returns the full label", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    const r = await get();
    expect(r.body.team.projectId).toBe(P);
    expect(r.body.team.project).toEqual({ id: P, name: "Project p1", status: "active" });
  });

  it("an ARCHIVED Project stays readable and reports its real status", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    mockedGetProject.mockResolvedValueOnce(foundProject({ status: "archived" }));
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.team.project).toEqual({ id: P, name: "Project p1", status: "archived" });
  });

  it.each(["not_found", "malformed"])("a %s Project degrades ONLY the label: 200, projectId retained, project null", async (status) => {
    seed(teamVideoDoc(VID, { projectId: P }));
    mockedGetProject.mockResolvedValueOnce({ status });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.team.projectId).toBe(P);
    expect(r.body.team.project).toBeNull();
  });

  it("a missing Project is NEVER rewritten to look Unfiled", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    mockedGetProject.mockResolvedValueOnce({ status: "not_found" });
    const unavailable = await get();
    seed(teamVideoDoc(VID));
    const unfiled = await get();
    expect(unavailable.body.team.projectId).toBe(P);
    expect(unfiled.body.team.projectId).toBeNull();
    expect(unavailable.body.team.projectId).not.toEqual(unfiled.body.team.projectId);
  });

  it("a CROSS-WORKSPACE Project is an integrity anomaly -> concealed 404, not a degraded label", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    mockedGetProject.mockResolvedValueOnce(foundProject({ workspaceId: "ws-other" }));
    expect(await get()).toEqual(CONCEALED);
  });

  it.each(["firestore_unavailable", "read_failed"])("a Project READ failure (%s) -> 503, never a silent null label", async (status) => {
    seed(teamVideoDoc(VID, { projectId: P }));
    mockedGetProject.mockResolvedValueOnce({ status });
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.errorCode).toBe("team_workspace_unavailable");
  });
});

describe("response shape and the mapper boundary", () => {
  it("returns ok, payload and the team envelope", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.payload).toEqual({ verificationId: VID, fileName: "clip.mp4", verdict: "authentic_captured" });
    expect(r.body.team).toEqual({ workspaceId: TEAM_W, projectId: P, project: { id: P, name: "Project p1", status: "active" }, createdAt: "2023-11-14T22:13:20.000Z" });
  });

  it("the mapper runs only AFTER binding validation, authorization and containment", async () => {
    seed(teamVideoDoc(VID, { workspaceId: "ws-other" }));
    await get();
    expect(mockedMapper).not.toHaveBeenCalled();

    seed(teamVideoDoc(VID, { projectId: P }));
    await get("?projectId=p2");
    expect(mockedMapper).not.toHaveBeenCalled();

    mockedAccess.mockResolvedValueOnce({ ...grant(), capabilities: ["workspace.read"] });
    await get();
    expect(mockedMapper).not.toHaveBeenCalled();
  });

  it("a mapper failure -> 500 internal_error, not a concealed 404", async () => {
    seed(teamVideoDoc(VID));
    mockedMapper.mockImplementationOnce(() => { throw new Error("map boom"); });
    const r = await get();
    expect(r).toEqual({ status: 500, body: { ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." } });
  });

  it("the envelope carries no uploader identity, membership or capability data", async () => {
    seed(teamVideoDoc(VID, { userId: "uploader-secret-uid" }));
    const json = JSON.stringify((await get()).body.team);
    for (const leaked of ["uploader-secret-uid", "userId", "userEmail", "capabilities", "membership", "role"]) {
      expect(json).not.toContain(leaked);
    }
  });
});

describe("zero side effects", () => {
  it("no write is attempted on any path, and only the artifact is read", async () => {
    seed(teamVideoDoc(VID, { projectId: P }));
    await get();
    await get("?projectId=p2");
    await get("", "a/b");
    expect(mockState.writeAttempts).toEqual([]);
    expect(mockState.docGets.every((p) => p.startsWith("videoVerifications/"))).toBe(true);
  });

  it("reads the videoVerifications collection, never `verifications`", async () => {
    seed(teamVideoDoc(VID));
    await get();
    expect(mockState.docGets).toEqual([`videoVerifications/${VID}`]);
  });
});
