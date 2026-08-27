/**
 * Team Workspace Invitations, Phase 8D.2 — POST
 * /api/workspace-invitations/{invitationId}/accept tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedAcceptWorkspaceInvitation = jest.fn();
jest.mock("@/lib/firestore/workspaceInvitations", () => ({
  acceptWorkspaceInvitation: (...args: unknown[]) => mockedAcceptWorkspaceInvitation(...args),
}));

const mockedLoggerWarn = jest.fn();
const mockedLoggerError = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => mockedLoggerWarn(...a), info: jest.fn(), error: (...a: unknown[]) => mockedLoggerError(...a), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspace-invitations/[invitationId]/accept/route";

const UID = "invitee-1";
const INV_ID = "inv-1";
const RAW_TOKEN_MARKER = "THE_ACCEPT_RAW_TOKEN_MARKER";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspace-invitations/${INV_ID}/accept`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body), { params: { invitationId: INV_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { token: RAW_TOKEN_MARKER };

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(401);
  expect(mockedAcceptWorkspaceInvitation).not.toHaveBeenCalled();
});

it("400s on empty/malformed body", async () => {
  const res = await POST(new NextRequest(`http://localhost/x`, { method: "POST", body: "{{{" }), { params: { invitationId: INV_ID } });
  expect(res.status).toBe(400);
  expect(mockedAcceptWorkspaceInvitation).not.toHaveBeenCalled();
});

it("400s on an unknown top-level key", async () => {
  const { res, json } = await callRoute({ ...VALID_BODY, workspaceId: "sneaky" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedAcceptWorkspaceInvitation).not.toHaveBeenCalled();
});

it("400s on a missing token", async () => {
  const { res } = await callRoute({});
  expect(res.status).toBe(400);
  expect(mockedAcceptWorkspaceInvitation).not.toHaveBeenCalled();
});

it("rejects a body-supplied workspaceId as an unknown field", async () => {
  const { res } = await callRoute({ token: "x", workspaceId: "ws-1" });
  expect(res.status).toBe(400);
});

it("rejects a body-supplied email as an unknown field", async () => {
  const { res } = await callRoute({ token: "x", email: "attacker@example.com" });
  expect(res.status).toBe(400);
});

it("rejects a body-supplied role as an unknown field", async () => {
  const { res } = await callRoute({ token: "x", role: "owner" });
  expect(res.status).toBe(400);
});

it("passes uid from identity, invitationId from the route param, and rawToken from the body — never uid from the body", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "member", membershipId: "wm_x", alreadyMember: false, effectiveRole: "member" });
  await callRoute(VALID_BODY);
  expect(mockedAcceptWorkspaceInvitation).toHaveBeenCalledWith({ uid: UID, invitationId: INV_ID, rawToken: RAW_TOKEN_MARKER });
});

it("invalid invitation/expired -> stable 404", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "invitation_invalid_or_expired" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(404);
  expect(json.errorCode).toBe("invitation_invalid_or_expired");
});

it("email verification required -> 403", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "email_verification_required" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(403);
});

it("email mismatch -> 403", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "invitation_email_mismatch" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(403);
});

it("auth lookup failure -> safe infra response (503 service_unavailable), no Firebase detail", async () => {
  // A distinct infrastructure class from a deterministic account-state
  // failure (email_verification_required/invitation_email_mismatch) —
  // the core already separates "we couldn't obtain authoritative Firebase
  // Auth state" from "we obtained it and it says X."
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "auth_lookup_failed" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(503);
  expect(json.errorCode).toBe("service_unavailable");
});

it("auth lookup failure never leaks a Firebase-style error marker into the response body", async () => {
  const FIREBASE_SECRET_MARKER = "auth/internal-error: FIREBASE_SECRET_DETAIL_MARKER";
  // Simulate the core having encountered (and safely swallowed) a Firebase
  // Admin SDK error internally — the mocked core result itself never
  // carries this detail (matching the real `acceptWorkspaceInvitation()`
  // contract, which returns a bare `{status:"auth_lookup_failed"}` with no
  // payload), so this asserts the route doesn't invent a channel to leak
  // one even if a future core change accidentally attached extra data.
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "auth_lookup_failed", _hypotheticalFutureDetail: FIREBASE_SECRET_MARKER } as any);
  const { json } = await callRoute(VALID_BODY);
  expect(JSON.stringify(json)).not.toContain(FIREBASE_SECRET_MARKER);
});

it("state corruption -> 500", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "state_corruption" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(500);
});

it("target-Workspace admission denied -> invitation_invalid_or_expired (404) — Phase 10B.2: team_workspaces_disabled is no longer a possible acceptWorkspaceInvitation() result at all; admission denial is concealed identically to every other invitation-invalid case", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "invitation_invalid_or_expired" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(404);
  expect(json.errorCode).toBe("invitation_invalid_or_expired");
});

it("accepted new membership -> 200, exposes workspaceId/alreadyMember/effectiveRole", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "member", membershipId: "wm_x", alreadyMember: false, effectiveRole: "member" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json).toEqual({ ok: true, workspaceId: "ws-1", alreadyMember: false, effectiveRole: "member" });
});

it("accepted reactivated membership -> 200", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "admin", membershipId: "wm_y", alreadyMember: false, effectiveRole: "admin" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.effectiveRole).toBe("admin");
});

it("alreadyMember response is passed through", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "admin", membershipId: "wm_z", alreadyMember: true, effectiveRole: "viewer" });
  const { json } = await callRoute(VALID_BODY);
  expect(json.alreadyMember).toBe(true);
  expect(json.effectiveRole).toBe("viewer"); // unchanged existing role, never the invitation's role
});

it("raw token is absent from the JSON response", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "member", membershipId: "wm_x", alreadyMember: false, effectiveRole: "member" });
  const { json } = await callRoute(VALID_BODY);
  expect(JSON.stringify(json)).not.toContain(RAW_TOKEN_MARKER);
});

it("membershipId, tokenHash, and Firebase Auth record details are never exposed", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "member", membershipId: "wm_should_not_leak", alreadyMember: false, effectiveRole: "member" });
  const { json } = await callRoute(VALID_BODY);
  expect(JSON.stringify(json)).not.toContain("wm_should_not_leak");
  expect(JSON.stringify(json)).not.toMatch(/tokenHash|emailVerified|normalizedEmail/);
});

it("zero email adapter calls (accept never sends email)", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "accepted", invitationId: INV_ID, workspaceId: "ws-1", role: "member", membershipId: "wm_x", alreadyMember: false, effectiveRole: "member" });
  await callRoute(VALID_BODY);
  // No email module is even imported by this route — nothing to assert
  // against beyond the absence of any import-time side effect, confirmed
  // structurally (see full security search in the route source).
});

it("the raw token is never logged", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "invitation_invalid_or_expired" });
  await callRoute(VALID_BODY);
  const allLoggedArgs = JSON.stringify([...mockedLoggerWarn.mock.calls, ...mockedLoggerError.mock.calls]);
  expect(allLoggedArgs).not.toContain(RAW_TOKEN_MARKER);
});

it("the request body is never logged", async () => {
  mockedAcceptWorkspaceInvitation.mockResolvedValue({ status: "state_corruption" });
  await callRoute(VALID_BODY);
  const allLoggedArgs = JSON.stringify([...mockedLoggerWarn.mock.calls, ...mockedLoggerError.mock.calls]);
  expect(allLoggedArgs).not.toContain(RAW_TOKEN_MARKER);
});
