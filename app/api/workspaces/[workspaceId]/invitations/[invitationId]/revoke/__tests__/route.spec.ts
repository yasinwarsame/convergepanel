/**
 * Team Workspace Invitations, Phase 8D.2 — POST
 * /api/workspaces/{workspaceId}/invitations/{invitationId}/revoke tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedRevokeWorkspaceInvitation = jest.fn();
jest.mock("@/lib/firestore/workspaceInvitations", () => ({
  revokeWorkspaceInvitation: (...args: unknown[]) => mockedRevokeWorkspaceInvitation(...args),
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
import { POST } from "@/app/api/workspaces/[workspaceId]/invitations/[invitationId]/revoke/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const INV_ID = "inv-1";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/invitations/${INV_ID}/revoke`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body), { params: { workspaceId: WS_ID, invitationId: INV_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { expectedDeliveryVersion: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(401);
  expect(mockedRevokeWorkspaceInvitation).not.toHaveBeenCalled();
});

it("400s on malformed body", async () => {
  const res = await POST(new NextRequest(`http://localhost/x`, { method: "POST", body: "{{{" }), { params: { workspaceId: WS_ID, invitationId: INV_ID } });
  expect(res.status).toBe(400);
});

it("400s on unknown top-level keys", async () => {
  const { res, json } = await callRoute({ ...VALID_BODY, role: "admin" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedRevokeWorkspaceInvitation).not.toHaveBeenCalled();
});

it("invalid_delivery_version -> 400", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "invalid_delivery_version" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(400);
});

it("invitation_version_conflict -> 409", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "invitation_version_conflict" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
});

it("stale_superseded -> 409", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "stale_superseded" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
});

it("members.manage denial (unauthorized/insufficient_capability) -> 403", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(403);
});

it("role_target_forbidden -> 403", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "role_target_forbidden" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(403);
});

it("invalid_state_for_revoke -> 409", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "invalid_state_for_revoke" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
});

it("successful revoke -> 200", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "revoked", invitationId: INV_ID });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json).toEqual({ ok: true, invitationId: INV_ID, status: "revoked" });
});

it("idempotent already-revoked outcome -> 200 (core collapses both into the same 'revoked' status)", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "revoked", invitationId: INV_ID });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
});

it("zero email calls on any outcome", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "revoked", invitationId: INV_ID });
  await callRoute(VALID_BODY);
  expect(mockedSendWorkspaceInvitationEmail).not.toHaveBeenCalled();
});

it("zero delivery-metadata calls on any outcome", async () => {
  mockedRevokeWorkspaceInvitation.mockResolvedValue({ status: "revoked", invitationId: INV_ID });
  await callRoute(VALID_BODY);
  expect(mockedRecordDeliveryResult).not.toHaveBeenCalled();
});
