/**
 * Team Workspace Invitations, Phase 8D.2 — POST/GET
 * /api/workspaces/{workspaceId}/invitations tests. Every boundary this
 * route talks to is mocked (identity, rate limit, the 8D.1 core, the
 * Workspace read, the email adapter, delivery-metadata recording) — this
 * suite covers auth, request parsing, orchestration order, and HTTP
 * mapping only, using the REAL POST/GET handlers.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockedCheckRateLimit(...args),
}));

const mockedCreateWorkspaceInvitation = jest.fn();
const mockedListWorkspaceInvitations = jest.fn();
jest.mock("@/lib/firestore/workspaceInvitations", () => ({
  createWorkspaceInvitation: (...args: unknown[]) => mockedCreateWorkspaceInvitation(...args),
  listWorkspaceInvitations: (...args: unknown[]) => mockedListWorkspaceInvitations(...args),
}));

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({
  getWorkspace: (...args: unknown[]) => mockedGetWorkspace(...args),
}));

const mockedSendWorkspaceInvitationEmail = jest.fn();
jest.mock("@/lib/email/workspaceInvitations", () => ({
  sendWorkspaceInvitationEmail: (...args: unknown[]) => mockedSendWorkspaceInvitationEmail(...args),
}));

const mockedRecordDeliveryResult = jest.fn();
jest.mock("@/lib/firestore/workspaceInvitationDelivery", () => ({
  recordWorkspaceInvitationDeliveryResult: (...args: unknown[]) => mockedRecordDeliveryResult(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { POST, GET } from "@/app/api/workspaces/[workspaceId]/invitations/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";

function buildRequest(method: "GET" | "POST", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/invitations`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function callPost(body?: unknown) {
  const res = await POST(buildRequest("POST", body), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}
async function callGet() {
  const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { email: "invitee@example.com", role: "member" };

const CREATED_RESULT = {
  status: "created",
  invitationId: "inv-1",
  workspaceId: WS_ID,
  normalizedEmail: "invitee@example.com",
  role: "member",
  expiresAt: Timestamp.fromDate(new Date("2026-09-01T00:00:00.000Z")),
  deliveryVersion: 1,
  rawToken: "THE_RAW_TOKEN_MARKER",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: { schemaVersion: 1, id: WS_ID, type: "team", name: "Acme Team", ownerUserId: UID, createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() } });
  mockedSendWorkspaceInvitationEmail.mockResolvedValue({ status: "sent", providerMessageId: "msg-1" });
  mockedRecordDeliveryResult.mockResolvedValue({ status: "recorded" });
});

describe("POST — auth, rate limit, body", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockedCreateWorkspaceInvitation).not.toHaveBeenCalled();
  });

  it("429s when rate limited, zero core call, zero email", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(), retryAfter: 30 });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(429);
    expect(mockedCreateWorkspaceInvitation).not.toHaveBeenCalled();
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("rate limit is checked BEFORE body parsing", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await POST(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/invitations`, { method: "POST", body: "not json {{{" }), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(429);
  });

  it("400s on malformed JSON", async () => {
    const res = await POST(new NextRequest(`http://localhost/api/workspaces/${WS_ID}/invitations`, { method: "POST", body: "not json {{{" }), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect(mockedCreateWorkspaceInvitation).not.toHaveBeenCalled();
  });

  it("400s on a non-object body", async () => {
    const { res } = await callPost([1, 2, 3]);
    expect(res.status).toBe(400);
  });

  it("400s on an unknown top-level field", async () => {
    const { res, json } = await callPost({ ...VALID_BODY, workspaceId: "sneaky-override" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
    expect(mockedCreateWorkspaceInvitation).not.toHaveBeenCalled();
  });

  it("rejects a body-supplied uid override as an unknown field", async () => {
    const { res, json } = await callPost({ ...VALID_BODY, uid: "attacker-controlled" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
  });
});

describe("POST — core domain mapping (no email on denial)", () => {
  it("invalid_email -> 400, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "invalid_email" });
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_email");
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("invalid_role -> 400, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "invalid_role" });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(400);
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("team_workspaces_disabled -> 503, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(503);
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("unauthorized/insufficient_capability -> 403, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("unauthorized/membership_not_found -> 404 concealed, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "unauthorized", reason: "membership_not_found" });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(404);
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("role_target_forbidden -> 403, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "role_target_forbidden" });
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("role_target_forbidden");
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("duplicate_live_invitation -> 409, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "duplicate_live_invitation" });
    const { res } = await callPost(VALID_BODY);
    expect(res.status).toBe(409);
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("state_corruption -> 500 concealed internal_error, zero email calls", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue({ status: "state_corruption" });
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("internal_error");
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });
});

describe("POST — created + delivery orchestration", () => {
  it("commit-before-send: createWorkspaceInvitation is called and resolved before sendWorkspaceInvitationEmail", async () => {
    const callOrder: string[] = [];
    mockedCreateWorkspaceInvitation.mockImplementation(async () => {
      callOrder.push("create");
      return CREATED_RESULT;
    });
    mockedSendWorkspaceInvitationEmail.mockImplementation(async () => {
      callOrder.push("send");
      return { status: "sent", providerMessageId: "msg-1" };
    });
    mockedRecordDeliveryResult.mockImplementation(async () => {
      callOrder.push("record");
      return { status: "recorded" };
    });
    await callPost(VALID_BODY);
    expect(callOrder).toEqual(["create", "send", "record"]);
  });

  it("201 + delivered:true on send success", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.delivered).toBe(true);
    expect(json.invitation).toEqual({ id: "inv-1", normalizedEmail: "invitee@example.com", role: "member", expiresAt: "2026-09-01T00:00:00.000Z", deliveryVersion: 1 });
  });

  it("created + send config missing -> 201, delivered:false, deliveryError present, invitation still reported created", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    mockedSendWorkspaceInvitationEmail.mockResolvedValue({ status: "configuration_missing" });
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.delivered).toBe(false);
    expect(json.deliveryError).toBe("configuration_missing");
  });

  it("created + provider failure -> 201, delivered:false", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    mockedSendWorkspaceInvitationEmail.mockResolvedValue({ status: "provider_unavailable" });
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(201);
    expect(json.delivered).toBe(false);
    expect(json.deliveryError).toBe("provider_unavailable");
  });

  it("created + metadata write failure -> still 201, delivered reflects the actual send result, no error thrown", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    mockedSendWorkspaceInvitationEmail.mockResolvedValue({ status: "sent", providerMessageId: "msg-1" });
    mockedRecordDeliveryResult.mockResolvedValue({ status: "stale_delivery_result" });
    const { res, json } = await callPost(VALID_BODY);
    expect(res.status).toBe(201);
    expect(json.delivered).toBe(true);
  });

  it("send called before metadata recorder, using the SAME committed deliveryVersion", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    await callPost(VALID_BODY);
    expect(mockedSendWorkspaceInvitationEmail).toHaveBeenCalledWith(expect.objectContaining({ invitationId: "inv-1", deliveryVersion: 1, rawToken: "THE_RAW_TOKEN_MARKER" }));
    expect(mockedRecordDeliveryResult).toHaveBeenCalledWith(expect.objectContaining({ uid: UID, invitationId: "inv-1", deliveryVersion: 1, status: "sent", providerMessageId: "msg-1" }));
  });

  it("raw token is absent from the JSON response", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    const { json } = await callPost(VALID_BODY);
    expect(JSON.stringify(json)).not.toContain("THE_RAW_TOKEN_MARKER");
  });

  it("providerMessageId is absent from the JSON response", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    const { json } = await callPost(VALID_BODY);
    expect(JSON.stringify(json)).not.toContain("msg-1");
  });

  it("tokenHash is absent from the JSON response", async () => {
    mockedCreateWorkspaceInvitation.mockResolvedValue(CREATED_RESULT);
    const { json } = await callPost(VALID_BODY);
    expect(json.invitation.tokenHash).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/tokenHash/);
  });
});

describe("GET — list", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet();
    expect(res.status).toBe(401);
    expect(mockedListWorkspaceInvitations).not.toHaveBeenCalled();
  });

  it("team_workspaces_disabled -> 503", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res } = await callGet();
    expect(res.status).toBe(503);
  });

  it("concealed Workspace denial -> 404", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "workspace_not_found" });
    const { res } = await callGet();
    expect(res.status).toBe(404);
  });

  it("insufficient_capability -> 403", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "insufficient_capability" });
    const { res } = await callGet();
    expect(res.status).toBe(403);
  });

  it("lookup_failed -> 500 internal_error", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "lookup_failed" });
    const { res, json } = await callGet();
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("internal_error");
  });

  it("state_corruption -> 500", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "state_corruption" });
    const { res } = await callGet();
    expect(res.status).toBe(500);
  });

  it("empty list -> 200, invitations: []", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "listed", invitations: [] });
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, invitations: [] });
  });

  it("rows are preserved as-is from the core, no token/hash/provider/guard fields added", async () => {
    const row = { id: "inv-1", normalizedEmail: "a@example.com", role: "member", status: "pending", isExpired: false, expiresAt: "x", createdAt: "y", updatedAt: "z", invitedByUserId: "owner-1", deliveryVersion: 1, lastDeliveryAttemptAt: null, lastDeliveryStatus: null, lastDeliveryVersion: null };
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "listed", invitations: [row] });
    const { json } = await callGet();
    expect(json.invitations).toEqual([row]);
    expect(JSON.stringify(json)).not.toMatch(/tokenHash|rawToken|providerMessageId|currentInvitationId/);
  });

  it("GET never calls the email adapter", async () => {
    mockedListWorkspaceInvitations.mockResolvedValue({ status: "listed", invitations: [] });
    await callGet();
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });
});
