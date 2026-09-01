/**
 * Team Member Management, Phase 12A — POST
 * /api/workspaces/{workspaceId}/members/{uid}/remove tests. Mocks
 * removeWorkspaceMembership() (independently tested elsewhere) — this
 * suite covers auth, request-body shape, status-code mapping, and
 * call-wiring only.
 *
 * Governance Audit Durability, Phase TEAM-GOV-I1C1 — the route no longer
 * calls a separate event-writing function at all: the canonical removal
 * event is now written atomically INSIDE removeWorkspaceMembership()'s
 * own transaction (see lib/firestore/__tests__/workspaceMemberships.spec.ts
 * for that proof). This file's job shrank accordingly — it only proves
 * the route does not duplicate that responsibility.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedRemoveWorkspaceMembership = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  removeWorkspaceMembership: (...args: unknown[]) => mockedRemoveWorkspaceMembership(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/members/[uid]/remove/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const TARGET_UID = "member-1";

function buildRequest(rawBody?: string): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/members/${TARGET_UID}/remove`, { method: "POST", ...(rawBody !== undefined ? { body: rawBody } : {}) });
}
async function callRoute(rawBody?: string) {
  const res = await POST(buildRequest(rawBody), { params: { workspaceId: WS_ID, uid: TARGET_UID } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

describe("authentication", () => {
  it("401s when unauthenticated, zero core call", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callRoute();
    expect(res.status).toBe(401);
    expect(mockedRemoveWorkspaceMembership).not.toHaveBeenCalled();
  });
});

describe("request body", () => {
  it("accepts an entirely empty body", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "removed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "member" });
    const { res } = await callRoute();
    expect(res.status).toBe(200);
  });

  it("accepts an empty JSON object", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "removed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "member" });
    const { res } = await callRoute("{}");
    expect(res.status).toBe(200);
  });

  it("rejects any field in the body — the client submits no actor role, target role, capability, or owner UID", async () => {
    const { res, json } = await callRoute(JSON.stringify({ expectedDeliveryVersion: 1 }));
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
    expect(mockedRemoveWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { res } = await callRoute("{not json");
    expect(res.status).toBe(400);
    expect(mockedRemoveWorkspaceMembership).not.toHaveBeenCalled();
  });
});

describe("success", () => {
  it("removed -> 200, response shape unchanged; the route calls removeWorkspaceMembership() exactly once and returns its result directly — no second, separate event-writing call exists in the route's source at all (that responsibility now lives entirely inside the transaction)", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "removed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "reviewer" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, removed: true });
    expect(mockedRemoveWorkspaceMembership).toHaveBeenCalledTimes(1);
  });

  it("already_removed -> 200, idempotent shape", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "already_removed" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, removed: true, alreadyRemoved: true });
  });

  it("route source no longer imports lib/workspaces/workspaceMembershipEvents at all — the atomic write lives exclusively in removeWorkspaceMembership()'s own transaction", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "app/api/workspaces/[workspaceId]/members/[uid]/remove/route.ts"), "utf8");
    expect(source).not.toMatch(/workspaceMembershipEvents/);
  });
});

describe("denial mapping", () => {
  it("team_workspaces_disabled -> concealed 404, same shape as every other Team read denial", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });

  it("unauthorized: insufficient_capability -> 403, distinguishable", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
  });

  it("unauthorized: membership_not_found (non-member actor) -> concealed 404, same shape as insufficient other reasons", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "unauthorized", reason: "membership_not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });

  it("target_not_found -> 404, concealed, distinct error code from Workspace-not-found", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "target_not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("member_not_found");
  });

  it("target_malformed -> same concealed 404 as target_not_found", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "target_malformed" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("member_not_found");
  });

  it("self_removal_rejected -> 409, explicit", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "self_removal_rejected" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("self_removal_rejected");
  });

  it("target_is_canonical_owner -> 409, explicit, never a generic 500", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "target_is_canonical_owner" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("target_is_canonical_owner");
  });

  it("target_role_not_manageable -> 403, explicit", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "target_role_not_manageable" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("role_target_forbidden");
  });

  it.each(["firestore_unavailable", "state_corruption", "remove_failed"])("%s -> 500, generic internal error, no raw detail", async (status) => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
  });
});

describe("call wiring", () => {
  it("passes exactly {uid: actor, workspaceId, targetUid} — actor identity comes from the resolved session, target comes from the URL path, never from the request body", async () => {
    mockedRemoveWorkspaceMembership.mockResolvedValue({ status: "removed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "member" });
    await callRoute();
    expect(mockedRemoveWorkspaceMembership).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, targetUid: TARGET_UID });
  });

  it("never forwards a client-supplied actor uid even if one were smuggled in an unexpected field (that request is already rejected at the body-validation stage above, but confirm the call site itself never reads a body-derived uid)", () => {
    const source = require("fs").readFileSync(require.resolve("@/app/api/workspaces/[workspaceId]/members/[uid]/remove/route"), "utf8");
    expect(source).not.toMatch(/rawBody\.uid|body\.actorUid|body\.removedByUserId/);
  });
});
