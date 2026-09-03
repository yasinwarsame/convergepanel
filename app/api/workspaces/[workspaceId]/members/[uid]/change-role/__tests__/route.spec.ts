/**
 * Team Member Management, Phase 12B — POST
 * /api/workspaces/{workspaceId}/members/{uid}/change-role tests. Mocks
 * changeTeamWorkspaceMemberRole() (independently tested elsewhere) — this
 * suite covers auth, request-body shape/validation, status-code mapping,
 * and call-wiring only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedChangeTeamWorkspaceMemberRole = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  changeTeamWorkspaceMemberRole: (...args: unknown[]) => mockedChangeTeamWorkspaceMemberRole(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/members/[uid]/change-role/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const TARGET_UID = "member-1";

function buildRequest(rawBody?: string): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/members/${TARGET_UID}/change-role`, { method: "POST", ...(rawBody !== undefined ? { body: rawBody } : {}) });
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
    const { res } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(401);
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });
});

describe("request body", () => {
  it("accepts {role: <ordinary role>}", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "changed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "member", newRole: "reviewer" });
    const { res } = await callRoute(JSON.stringify({ role: "reviewer" }));
    expect(res.status).toBe(200);
  });

  it("rejects an entirely empty body", async () => {
    const { res, json } = await callRoute();
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it("rejects an empty JSON object (role is required)", async () => {
    const { res, json } = await callRoute("{}");
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it("rejects role: \"owner\" — ownership is never assignable through this action", async () => {
    const { res, json } = await callRoute(JSON.stringify({ role: "owner" }));
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized role string", async () => {
    const { res, json } = await callRoute(JSON.stringify({ role: "superadmin" }));
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it("rejects a non-string role", async () => {
    const { res, json } = await callRoute(JSON.stringify({ role: 123 }));
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
  });

  it("rejects any extra field alongside role — the client submits no actor role, target role, capability, previousRole, or owner UID", async () => {
    const { res, json } = await callRoute(JSON.stringify({ role: "member", actorUid: "someone-else" }));
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_request_body");
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { res } = await callRoute("{not json");
    expect(res.status).toBe(400);
    expect(mockedChangeTeamWorkspaceMemberRole).not.toHaveBeenCalled();
  });
});

describe("success", () => {
  it("changed -> 200, {ok: true, changed: true}", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "changed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "member", newRole: "reviewer" });
    const { res, json } = await callRoute(JSON.stringify({ role: "reviewer" }));
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, changed: true });
    expect(mockedChangeTeamWorkspaceMemberRole).toHaveBeenCalledTimes(1);
  });

  it("role_unchanged -> 200, {ok: true, changed: false} — distinguishable from a genuine change", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "role_unchanged", targetUid: TARGET_UID, workspaceId: WS_ID, role: "member" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, changed: false });
  });
});

describe("denial mapping", () => {
  it("team_workspaces_disabled -> concealed 404", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });

  it("unauthorized: insufficient_capability -> 403, distinguishable", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
  });

  it("unauthorized: membership_not_found (non-member actor) -> concealed 404", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "unauthorized", reason: "membership_not_found" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
  });

  it("target_not_found -> 404, concealed", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "target_not_found" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("member_not_found");
  });

  it("target_malformed -> same concealed 404 as target_not_found", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "target_malformed" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("member_not_found");
  });

  it("target_not_active (removed target) -> same concealed 404 as target_not_found — never reactivates", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "target_not_active" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("member_not_found");
  });

  it("self_change_rejected -> 409, explicit", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "self_change_rejected" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("self_role_change_rejected");
  });

  it("target_is_canonical_owner -> 409, explicit, never a generic 500", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "target_is_canonical_owner" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("target_is_canonical_owner");
  });

  it("target_role_not_manageable -> 403, collapsed with destination denial", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "target_role_not_manageable" });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("role_change_forbidden");
  });

  it("destination_role_not_permitted -> 403, same concealed code as target_role_not_manageable — never reveals which of the two checks fired", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "destination_role_not_permitted" });
    const { res, json } = await callRoute(JSON.stringify({ role: "admin" }));
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("role_change_forbidden");
  });

  it.each(["firestore_unavailable", "change_failed"])("%s -> 500, generic internal error, no raw detail", async (status) => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status });
    const { res, json } = await callRoute(JSON.stringify({ role: "member" }));
    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
  });
});

describe("call wiring", () => {
  it("passes exactly {uid: actor, workspaceId, targetUid, destinationRole} — actor identity comes from the resolved session, target from the URL path, destination from the validated body", async () => {
    mockedChangeTeamWorkspaceMemberRole.mockResolvedValue({ status: "changed", targetUid: TARGET_UID, workspaceId: WS_ID, previousRole: "member", newRole: "reviewer" });
    await callRoute(JSON.stringify({ role: "reviewer" }));
    expect(mockedChangeTeamWorkspaceMemberRole).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, targetUid: TARGET_UID, destinationRole: "reviewer" });
  });

  it("never forwards a client-supplied actor uid or previousRole even if one were smuggled in an extra field (already rejected at the body-validation stage above, but confirm the call site itself never reads one)", () => {
    const source = require("fs").readFileSync(require.resolve("@/app/api/workspaces/[workspaceId]/members/[uid]/change-role/route"), "utf8");
    expect(source).not.toMatch(/rawBody\.uid|body\.actorUid|body\.previousRole/);
  });
});
