/**
 * Team Workspace Core Foundation, Phase 8B, route namespace corrected in
 * Phase 8B.1 — POST /api/workspaces/[workspaceId]/transfer-ownership
 * tests. Mocks `transferTeamWorkspaceOwnership()` (already independently,
 * and far more thoroughly, tested in
 * lib/firestore/__tests__/workspaceMemberships.spec.ts) — this suite
 * proves the route layer parses/validates the three OCC tokens correctly
 * and passes the CALLER-SUPPLIED tokens straight through, never
 * substituting anything it read itself (this route never reads any
 * document). No feature-flag/disabled scenario exists here — Phase 8B.1
 * removed `TEAM_WORKSPACES_ENABLED` entirely.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

const mockedTransfer = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  transferTeamWorkspaceOwnership: (...args: unknown[]) => mockedTransfer(...args),
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { POST } from "@/app/api/workspaces/[workspaceId]/transfer-ownership/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const VALID_TOKEN = { seconds: 1_700_000_000, nanoseconds: 0 };

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/transfer-ownership`, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = {
  newOwnerUid: "new-owner-1",
  expectedWorkspaceUpdateTime: VALID_TOKEN,
  expectedOldOwnerMembershipUpdateTime: VALID_TOKEN,
  expectedNewOwnerMembershipUpdateTime: VALID_TOKEN,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(401);
  expect(mockedTransfer).not.toHaveBeenCalled();
});

it("400s on an unexpected field", async () => {
  const { res, json } = await callRoute({ ...VALID_BODY, ownerUserId: "attacker-controlled" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedTransfer).not.toHaveBeenCalled();
});

it("400s on a missing newOwnerUid", async () => {
  const { expectedWorkspaceUpdateTime, expectedOldOwnerMembershipUpdateTime, expectedNewOwnerMembershipUpdateTime } = VALID_BODY;
  const { res } = await callRoute({ expectedWorkspaceUpdateTime, expectedOldOwnerMembershipUpdateTime, expectedNewOwnerMembershipUpdateTime });
  expect(res.status).toBe(400);
  expect(mockedTransfer).not.toHaveBeenCalled();
});

it.each(["expectedWorkspaceUpdateTime", "expectedOldOwnerMembershipUpdateTime", "expectedNewOwnerMembershipUpdateTime"])("400s on a malformed %s token, never calling the service function", async (field) => {
  const { res, json } = await callRoute({ ...VALID_BODY, [field]: { seconds: "not-a-number", nanoseconds: 0 } });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("invalid_update_time");
  expect(mockedTransfer).not.toHaveBeenCalled();
});

it("400s when any one of the three tokens is entirely missing — never defaults a missing token", async () => {
  const { newOwnerUid, expectedOldOwnerMembershipUpdateTime, expectedNewOwnerMembershipUpdateTime } = VALID_BODY;
  const { res } = await callRoute({ newOwnerUid, expectedOldOwnerMembershipUpdateTime, expectedNewOwnerMembershipUpdateTime });
  expect(res.status).toBe(400);
  expect(mockedTransfer).not.toHaveBeenCalled();
});

it("passes the CALLER-SUPPLIED tokens straight through as Timestamps — never substitutes a value it read itself (this route reads nothing)", async () => {
  mockedTransfer.mockResolvedValue({ status: "transferred", workspace: {}, oldOwnerMembership: {}, newOwnerMembership: {} });
  await callRoute(VALID_BODY);
  expect(mockedTransfer).toHaveBeenCalledTimes(1);
  const callArgs = mockedTransfer.mock.calls[0][0];
  expect(callArgs.workspaceId).toBe(WS_ID);
  expect(callArgs.callerUid).toBe(UID);
  expect(callArgs.newOwnerUid).toBe("new-owner-1");
  expect(callArgs.expectedWorkspaceUpdateTime).toBeInstanceOf(Timestamp);
  expect(callArgs.expectedWorkspaceUpdateTime.seconds).toBe(VALID_TOKEN.seconds);
  expect(callArgs.expectedOldOwnerMembershipUpdateTime.seconds).toBe(VALID_TOKEN.seconds);
  expect(callArgs.expectedNewOwnerMembershipUpdateTime.seconds).toBe(VALID_TOKEN.seconds);
});

it("derives callerUid exclusively from the authenticated identity, never from the request body", async () => {
  mockedTransfer.mockResolvedValue({ status: "transferred", workspace: {}, oldOwnerMembership: {}, newOwnerMembership: {} });
  await callRoute(VALID_BODY); // body has no callerUid field to begin with — parser doesn't even accept one
  expect(mockedTransfer.mock.calls[0][0].callerUid).toBe(UID);
});

it("200s and returns the transfer result on success", async () => {
  mockedTransfer.mockResolvedValue({
    status: "transferred",
    workspace: { id: WS_ID, ownerUserId: "new-owner-1" },
    oldOwnerMembership: { role: "admin" },
    newOwnerMembership: { role: "owner" },
  });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.workspace.ownerUserId).toBe("new-owner-1");
});

it.each([
  ["workspace_not_found", 403],
  ["caller_not_owner", 403],
  ["self_transfer_rejected", 409],
  ["new_owner_membership_not_found", 409],
  ["new_owner_not_eligible", 409],
  ["workspace_stale", 409],
  ["old_owner_membership_stale", 409],
  ["new_owner_membership_stale", 409],
  ["stale_precondition", 409],
  ["team_workspaces_disabled", 503],
  ["firestore_unavailable", 500],
  ["transaction_failed", 500],
])("maps service status %s -> HTTP %d", async (status, expectedHttp) => {
  mockedTransfer.mockResolvedValue({ status });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(expectedHttp);
});
