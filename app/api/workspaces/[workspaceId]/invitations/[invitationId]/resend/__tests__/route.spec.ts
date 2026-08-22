/**
 * Team Workspace Invitations, Phase 8D.2 — POST
 * /api/workspaces/{workspaceId}/invitations/{invitationId}/resend tests.
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

const mockedResendWorkspaceInvitation = jest.fn();
jest.mock("@/lib/firestore/workspaceInvitations", () => ({
  resendWorkspaceInvitation: (...args: unknown[]) => mockedResendWorkspaceInvitation(...args),
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
import { POST } from "@/app/api/workspaces/[workspaceId]/invitations/[invitationId]/resend/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const INV_ID = "inv-1";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/invitations/${INV_ID}/resend`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body), { params: { workspaceId: WS_ID, invitationId: INV_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { expectedDeliveryVersion: 1 };

const RESENT_RESULT = {
  status: "resent",
  invitationId: INV_ID,
  workspaceId: WS_ID,
  normalizedEmail: "invitee@example.com",
  role: "member",
  expiresAt: Timestamp.fromDate(new Date("2026-09-08T00:00:00.000Z")),
  deliveryVersion: 2,
  rawToken: "NEW_RAW_TOKEN_MARKER",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: { schemaVersion: 1, id: WS_ID, type: "team", name: "Acme Team", ownerUserId: UID, createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() } });
  mockedSendWorkspaceInvitationEmail.mockResolvedValue({ status: "sent", providerMessageId: "msg-2" });
  mockedRecordDeliveryResult.mockResolvedValue({ status: "recorded" });
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(401);
  expect(mockedResendWorkspaceInvitation).not.toHaveBeenCalled();
});

it("429s on shared email rate limit, zero core call", async () => {
  mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(429);
  expect(mockedResendWorkspaceInvitation).not.toHaveBeenCalled();
});

it("shares the same rate-limit identifier convention as create (team-workspace-invitation-email:<uid>)", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue(RESENT_RESULT);
  await callRoute(VALID_BODY);
  expect(mockedCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identifier: `team-workspace-invitation-email:${UID}` }));
});

it("400s on malformed JSON body", async () => {
  const res = await POST(new NextRequest(`http://localhost/x`, { method: "POST", body: "{{{" }), { params: { workspaceId: WS_ID, invitationId: INV_ID } });
  expect(res.status).toBe(400);
});

it("400s on unknown top-level fields", async () => {
  const { res, json } = await callRoute({ ...VALID_BODY, email: "attacker@example.com" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedResendWorkspaceInvitation).not.toHaveBeenCalled();
});

it("invalid_delivery_version -> 400", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue({ status: "invalid_delivery_version" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(400);
});

it("invitation_version_conflict -> 409", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue({ status: "invitation_version_conflict" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
});

it("stale_superseded -> 409", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue({ status: "stale_superseded" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
});

it("invalid_state -> 409", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue({ status: "invalid_state" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
});

it("role_target_forbidden -> 403", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue({ status: "role_target_forbidden" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(403);
});

it("unauthorized/insufficient_capability -> 403", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(403);
});

it("all denial results produce zero email calls", async () => {
  for (const status of ["team_workspaces_disabled", "invalid_delivery_version", "role_target_forbidden", "invitation_not_found", "invalid_state", "stale_superseded", "invitation_version_conflict", "state_corruption"]) {
    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
    mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
    mockedResendWorkspaceInvitation.mockResolvedValue({ status });
    await callRoute(VALID_BODY);
    expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  }
});

it("resent + send success -> 200, delivered:true, new deliveryVersion in response", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue(RESENT_RESULT);
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.delivered).toBe(true);
  expect(json.invitation.deliveryVersion).toBe(2);
});

it("resent + send failure -> 200 (mutation still succeeded), delivered:false", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue(RESENT_RESULT);
  mockedSendWorkspaceInvitationEmail.mockResolvedValue({ status: "provider_unavailable" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.delivered).toBe(false);
  expect(json.deliveryError).toBe("provider_unavailable");
});

it("resent + metadata write failure -> still 200, delivered reflects the actual send result", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue(RESENT_RESULT);
  mockedRecordDeliveryResult.mockResolvedValue({ status: "stale_delivery_result" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.delivered).toBe(true);
});

it("uses the NEW deliveryVersion for both the email idempotency (via the adapter call args) and the metadata recorder — never the pre-resend version", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue(RESENT_RESULT);
  await callRoute(VALID_BODY);
  expect(mockedSendWorkspaceInvitationEmail).toHaveBeenCalledWith(expect.objectContaining({ deliveryVersion: 2, rawToken: "NEW_RAW_TOKEN_MARKER" }));
  expect(mockedRecordDeliveryResult).toHaveBeenCalledWith(expect.objectContaining({ deliveryVersion: 2 }));
});

it("new raw token is absent from the JSON response", async () => {
  mockedResendWorkspaceInvitation.mockResolvedValue(RESENT_RESULT);
  const { json } = await callRoute(VALID_BODY);
  expect(JSON.stringify(json)).not.toContain("NEW_RAW_TOKEN_MARKER");
});
