/**
 * Personal Workspace Provisioning, Phase 2 — POST /api/user/workspace tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: any[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedEnsurePersonalWorkspace = jest.fn();
jest.mock("@/lib/workspaces/ensurePersonalWorkspace", () => ({
  ensurePersonalWorkspace: (...args: any[]) => mockedEnsurePersonalWorkspace(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/user/workspace/route";

const UID = "owner-1";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/user/workspace", {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body));
  const json = await res.json();
  return { res, json };
}

const SAMPLE_WORKSPACE = {
  schemaVersion: 1,
  id: "personal-owner-1",
  type: "personal",
  name: "Personal Workspace",
  ownerUserId: UID,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
});

describe("POST /api/user/workspace — auth", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(401);
    expect(json.ok).toBe(false);
    expect(mockedEnsurePersonalWorkspace).not.toHaveBeenCalled();
  });

  it("401s on any other auth failure reason too", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "credential_mismatch" });
    const { res } = await callRoute();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/user/workspace — self-provisioning only, no client-trusted fields", () => {
  it("provisions the AUTHENTICATED uid, ignoring any uid the client attempts to supply in the body", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    await callRoute({ uid: "someone-else-entirely" });
    expect(mockedEnsurePersonalWorkspace).toHaveBeenCalledWith(UID);
    expect(mockedEnsurePersonalWorkspace).not.toHaveBeenCalledWith("someone-else-entirely");
  });

  it("ignores an attempted ownerUserId override in the body — provisions for the authenticated uid regardless", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    await callRoute({ ownerUserId: "attacker-uid" });
    expect(mockedEnsurePersonalWorkspace).toHaveBeenCalledWith(UID);
  });

  it("ignores an attempted workspaceId injection in the body", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    await callRoute({ workspaceId: "personal-someone-else" });
    expect(mockedEnsurePersonalWorkspace).toHaveBeenCalledWith(UID);
  });

  it("ignores an attempted type override (e.g. \"team\") in the body", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    await callRoute({ type: "team" });
    expect(mockedEnsurePersonalWorkspace).toHaveBeenCalledWith(UID);
  });

  it("works with no request body at all", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    const { res } = await callRoute(undefined);
    expect(res.status).toBe(201);
    expect(mockedEnsurePersonalWorkspace).toHaveBeenCalledWith(UID);
  });

  it("never forwards the request object or body to the service — called with exactly the uid string", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    await callRoute({ uid: "attacker" });
    expect(mockedEnsurePersonalWorkspace).toHaveBeenCalledTimes(1);
    expect(mockedEnsurePersonalWorkspace.mock.calls[0]).toEqual([UID]);
  });
});

describe("POST /api/user/workspace — result mapping", () => {
  it("created: 201", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "created", workspace: SAMPLE_WORKSPACE });
    const { res, json } = await callRoute();
    expect(res.status).toBe(201);
    expect(json).toEqual({ ok: true, status: "created", workspace: SAMPLE_WORKSPACE });
  });

  it("existing: 200", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "existing", workspace: SAMPLE_WORKSPACE });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, status: "existing", workspace: SAMPLE_WORKSPACE });
  });

  it("disabled: 503, generic message", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "disabled" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(503);
    expect(json.ok).toBe(false);
    expect(json.errorCode).toBe("provisioning_disabled");
  });

  it("invalid_uid: 400", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "invalid_uid" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
  });

  it.each(["wrong_owner", "wrong_type", "malformed"])("conflict (%s): 409, generic message, never exposes the reason or a conflicting owner uid", async (reason) => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "conflict", reason });
    const { res, json } = await callRoute();
    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    const body = JSON.stringify(json);
    expect(body).not.toContain(reason);
    expect(body.toLowerCase()).not.toContain("owner");
  });

  it("lookup_failed: 500, no raw Firebase error leaked", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "lookup_failed" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toMatch(/firestore|firebase|stack|at Object/i);
  });

  it("create_failed: 500, no raw Firebase error leaked", async () => {
    mockedEnsurePersonalWorkspace.mockResolvedValue({ status: "create_failed" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toMatch(/firestore|firebase|stack|at Object/i);
  });
});
