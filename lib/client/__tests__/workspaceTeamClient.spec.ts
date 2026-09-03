/**
 * Team Workspace Self-Service Onboarding — client contract tests for
 * `workspaceTeamClient.ts`, added corrective to PHASE TEAM-UI-I1C1.
 *
 * `fetchPendingInvitations()` originally required every invitation's
 * `expiresAt` to be a JSON string. The real, live GET
 * `/api/workspaces/{id}/invitations` route (`app/api/workspaces/[workspaceId]/invitations/route.ts`,
 * unmodified by this PR) instead returns raw Firestore Timestamp JSON
 * (`{_seconds, _nanoseconds}`) for its list response — only the
 * POST/create response happens to serialize dates as ISO strings. That
 * mismatch made every real invitation fail client-side validation and the
 * UI showed a false "couldn't load" error despite a successful 200
 * response. `LIVE_GET_INVITATION_FIXTURE` below mirrors the exact JSON
 * shape captured from that real endpoint (values redacted/replaced, keys
 * and value SHAPES unchanged) — not an idealized DTO.
 */

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: (...args: any[]) => mockedAuthedFetch(...args),
}));

import {
  fetchPendingInvitations,
  createInvitation,
  resendInvitation,
  fetchWorkspaceAuditEvents,
  fetchTeamProjectsExistence,
  fetchTeamResearchExistence,
  fetchWorkspaceMembers,
  transferWorkspaceOwnership,
  changeMemberRole,
} from "@/lib/client/workspaceTeamClient";

beforeEach(() => {
  jest.clearAllMocks();
});

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

// Exact structural mirror of a real captured response from
// GET /api/workspaces/{workspaceId}/invitations — Firestore Timestamp
// fields serialize as {_seconds, _nanoseconds}, not ISO strings. Extra
// fields (status, createdAt, updatedAt, invitedByUserId,
// lastDeliveryAttemptAt, lastDeliveryStatus, lastDeliveryVersion) are
// present in the real payload and must be safely ignored, not merely
// absent from a hand-crafted fixture.
const LIVE_GET_INVITATION_FIXTURE = {
  id: "inv-abc123",
  normalizedEmail: "teammate@example.com",
  role: "member",
  status: "pending",
  isExpired: false,
  expiresAt: { _seconds: 1788336970, _nanoseconds: 600000000 },
  createdAt: { _seconds: 1787732170, _nanoseconds: 600000000 },
  updatedAt: { _seconds: 1787732170, _nanoseconds: 600000000 },
  invitedByUserId: "SomeRawUidThatMustNotLeak000",
  deliveryVersion: 1,
  lastDeliveryAttemptAt: { _seconds: 1787732171, _nanoseconds: 46000000 },
  lastDeliveryStatus: "sent",
  lastDeliveryVersion: 1,
};

describe("fetchPendingInvitations — the exact defect this phase corrects", () => {
  it("accepts the real, live GET-shaped fixture (Firestore Timestamp expiresAt) — status ok, not error", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: [LIVE_GET_INVITATION_FIXTURE] }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result.status).toBe("ok");
  });

  it("converts the Firestore-shaped timestamp to the expected canonical ISO value", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: [LIVE_GET_INVITATION_FIXTURE] }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const expectedMillis = 1788336970 * 1000 + Math.floor(600000000 / 1_000_000);
    expect(result.invitations[0].expiresAt).toBe(new Date(expectedMillis).toISOString());
  });

  it("accepts an already-ISO-string expiresAt (unchanged prior contract)", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitations: [{ id: "inv-2", normalizedEmail: "a@b.com", role: "reviewer", isExpired: false, expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 }] })
    );
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.invitations[0].expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("empty invitations array remains valid", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: [] }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", invitations: [] });
  });

  it("drops invitedByUserId (raw UID) — normalization never introduces new field exposure", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: [LIVE_GET_INVITATION_FIXTURE] }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(Object.keys(result.invitations[0]).sort()).toEqual(["deliveryVersion", "expiresAt", "id", "isExpired", "normalizedEmail", "role"]);
    expect(JSON.stringify(result.invitations[0])).not.toContain("SomeRawUidThatMustNotLeak000");
  });

  it("role validation is unchanged — an invalid role still fails closed", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: [{ ...LIVE_GET_INVITATION_FIXTURE, role: "owner" }] }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("one malformed invitation in the array still fails the whole response closed (unchanged whole-list policy)", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitations: [LIVE_GET_INVITATION_FIXTURE, { ...LIVE_GET_INVITATION_FIXTURE, id: "inv-bad", expiresAt: { _seconds: "not-a-number", _nanoseconds: 0 } }] })
    );
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchPendingInvitations — malformed timestamp rejection", () => {
  const badExpiresAtCases: Array<[string, unknown]> = [
    ["missing _seconds", { _nanoseconds: 0 }],
    ["missing _nanoseconds", { _seconds: 1700000000 }],
    ["non-numeric _seconds", { _seconds: "1700000000", _nanoseconds: 0 }],
    ["non-numeric _nanoseconds", { _seconds: 1700000000, _nanoseconds: "0" }],
    ["negative _nanoseconds", { _seconds: 1700000000, _nanoseconds: -1 }],
    ["_nanoseconds >= 1e9", { _seconds: 1700000000, _nanoseconds: 1_000_000_000 }],
    ["NaN _seconds", { _seconds: NaN, _nanoseconds: 0 }],
    ["Infinity _seconds", { _seconds: Infinity, _nanoseconds: 0 }],
    ["non-integer _seconds", { _seconds: 1700000000.5, _nanoseconds: 0 }],
    ["arbitrary unrelated object", { foo: "bar" }],
    ["an array", [1700000000, 0]],
    ["null", null],
    ["non-parseable string", "not-a-date"],
    ["empty string", ""],
  ];

  it.each(badExpiresAtCases)("rejects expiresAt: %s", async (_label, badExpiresAt) => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: [{ ...LIVE_GET_INVITATION_FIXTURE, expiresAt: badExpiresAt }] }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchPendingInvitations — infrastructure", () => {
  it("!res.ok -> error", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: false }, false));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("non-array invitations -> error", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitations: "nope" }));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchPendingInvitations({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("createInvitation — POST/create response still accepted", () => {
  it("accepts the existing ISO-string expiresAt contract from the create route", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitation: { id: "inv-new", normalizedEmail: "new@example.com", role: "member", expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 }, delivered: true })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "new@example.com", role: "member" });
    expect(result).toEqual({
      status: "ok",
      invitation: { id: "inv-new", normalizedEmail: "new@example.com", role: "member", isExpired: false, expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 },
      delivered: true,
    });
  });

  it("also accepts a Firestore-shaped expiresAt from the create route, for robustness against the same class of contract drift", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitation: { id: "inv-new", normalizedEmail: "new@example.com", role: "member", expiresAt: { _seconds: 1788336970, _nanoseconds: 0 }, deliveryVersion: 1 }, delivered: true })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "new@example.com", role: "member" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.invitation.expiresAt).toBe(new Date(1788336970 * 1000).toISOString());
  });

  it("rejects a malformed expiresAt on create — fails closed", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitation: { id: "inv-new", normalizedEmail: "new@example.com", role: "member", expiresAt: { foo: "bar" }, deliveryVersion: 1 }, delivered: true })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "new@example.com", role: "member" });
    expect(result).toEqual({ status: "error" });
  });
});

// PHASE TEAM-INVITE-DELIVERY-R1 / TEAM-UI-I1C1 — the backend's own honest
// `delivered`/`deliveryError` signal must never collapse into a generic
// "ok" that a caller could mistake for "email sent". A 2xx response always
// means the invitation record itself persisted (create) or the resend
// itself succeeded — `delivered` is the ONLY thing that says whether email
// dispatch was accepted by the provider.
describe("createInvitation — delivered outcome (PHASE TEAM-INVITE-DELIVERY-R1 correction)", () => {
  it("2xx + delivered:true -> status ok, delivered:true", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitation: { id: "inv-1", normalizedEmail: "a@b.com", role: "member", expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 }, delivered: true })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "a@b.com", role: "member" });
    expect(result).toEqual({ status: "ok", delivered: true, invitation: { id: "inv-1", normalizedEmail: "a@b.com", role: "member", isExpired: false, expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 } });
  });

  it("2xx + delivered:false -> status ok, delivered:false (invitation still valid/created, NOT an error)", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        invitation: { id: "inv-1", normalizedEmail: "a@b.com", role: "member", expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 },
        delivered: false,
        deliveryError: "preview_delivery_disabled",
      })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "a@b.com", role: "member" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.delivered).toBe(false);
    expect(result.invitation.id).toBe("inv-1");
  });

  it("the raw deliveryError string never reaches the parsed result — only the boolean is exposed", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        invitation: { id: "inv-1", normalizedEmail: "a@b.com", role: "member", expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 },
        delivered: false,
        deliveryError: "provider_rejected",
      })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "a@b.com", role: "member" });
    expect(JSON.stringify(result)).not.toContain("provider_rejected");
  });

  it("missing delivered field -> fails closed to error (never silently assumes true)", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitation: { id: "inv-1", normalizedEmail: "a@b.com", role: "member", expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 } }));
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "a@b.com", role: "member" });
    expect(result).toEqual({ status: "error" });
  });

  it("non-boolean delivered field -> fails closed to error", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, invitation: { id: "inv-1", normalizedEmail: "a@b.com", role: "member", expiresAt: "2027-01-01T00:00:00.000Z", deliveryVersion: 1 }, delivered: "true" })
    );
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "a@b.com", role: "member" });
    expect(result).toEqual({ status: "error" });
  });

  it("non-2xx response is still a plain request failure (denied), independent of any delivered field", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ errorCode: "insufficient_capability", message: "You do not have permission to invite at this role." }) });
    const result = await createInvitation({ user: null, authReady: true, workspaceId: "ws-1", email: "a@b.com", role: "admin" });
    expect(result).toEqual({ status: "denied", errorCode: "insufficient_capability", message: "You do not have permission to invite at this role." });
  });
});

describe("resendInvitation — delivered outcome (PHASE TEAM-INVITE-DELIVERY-R1 correction)", () => {
  it("2xx + delivered:true -> status ok, delivered:true", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitation: { id: "inv-1" }, delivered: true }));
    const result = await resendInvitation({ user: null, authReady: true, workspaceId: "ws-1", invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "ok", delivered: true });
  });

  it("2xx + delivered:false -> status ok, delivered:false (resend itself succeeded, email dispatch did not)", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitation: { id: "inv-1" }, delivered: false, deliveryError: "preview_delivery_disabled" }));
    const result = await resendInvitation({ user: null, authReady: true, workspaceId: "ws-1", invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "ok", delivered: false });
  });

  it("missing delivered field -> fails closed to error", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, invitation: { id: "inv-1" } }));
    const result = await resendInvitation({ user: null, authReady: true, workspaceId: "ws-1", invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "error" });
  });

  it("non-2xx response is a plain request failure (denied)", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ errorCode: "stale_delivery_version", message: "This invitation has changed. Refresh and try again." }) });
    const result = await resendInvitation({ user: null, authReady: true, workspaceId: "ws-1", invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "denied", errorCode: "stale_delivery_version", message: "This invitation has changed. Refresh and try again." });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await resendInvitation({ user: null, authReady: true, workspaceId: "ws-1", invitationId: "inv-1", expectedDeliveryVersion: 1 });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchWorkspaceAuditEvents — Workspace Audit Log, Phase TEAM-GOV-I1", () => {
  const VALID_EVENT = {
    eventType: "workspace_member_removed",
    occurredAt: "2026-08-31T20:46:25.000Z",
    actor: { displayName: "Olivia Owner" },
    target: { displayName: "Bob Member" },
    previousRole: "member",
  };

  it("ok response is parsed into events/hasMore/nextCursor", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [VALID_EVENT], hasMore: true, nextCursor: "cur-1" }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", events: [VALID_EVENT], hasMore: true, nextCursor: "cur-1" });
  });

  it("ok response with no nextCursor omits it", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [], hasMore: false }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", events: [], hasMore: false });
  });

  it("a malformed event in the array (bad eventType) fails the whole response closed — never a partial/trusted-shape list", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [{ ...VALID_EVENT, eventType: "something_else" }], hasMore: false }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("an unrecognized previousRole fails closed", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [{ ...VALID_EVENT, previousRole: "owner" }], hasMore: false }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("an invalid occurredAt (unparsable date) fails closed", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [{ ...VALID_EVENT, occurredAt: "not-a-date" }], hasMore: false }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("non-2xx response maps to denied with the server's errorCode/message", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ errorCode: "insufficient_capability", message: "You do not have permission to view this Workspace's audit log." }) });
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "denied", errorCode: "insufficient_capability", message: "You do not have permission to view this Workspace's audit log." });
  });

  it("cursor param is included in the request URL when provided", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [], hasMore: false }));
    await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1", cursor: "abc def" });
    const calledUrl = mockedAuthedFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("abc def"));
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchWorkspaceMembers — Ownership Transfer UI, Phase TEAM-MGMT-12C: OCC token exposure", () => {
  const VALID_TOKEN = { seconds: 1723600000, nanoseconds: 0 };
  const VALID_MEMBER = { uid: "member-1", displayName: "Test Member", role: "member", isCanonicalOwner: false, joinedAt: "2026-01-01T00:00:00.000Z", updateTimeToken: VALID_TOKEN };

  it("ok response is parsed into members + workspaceUpdateToken", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, members: [VALID_MEMBER], workspaceUpdateToken: VALID_TOKEN }));
    const result = await fetchWorkspaceMembers({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", members: [VALID_MEMBER], workspaceUpdateToken: VALID_TOKEN });
  });

  it("a member missing updateTimeToken fails the whole response closed", async () => {
    const { updateTimeToken: _drop, ...memberWithoutToken } = VALID_MEMBER;
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, members: [memberWithoutToken], workspaceUpdateToken: VALID_TOKEN }));
    const result = await fetchWorkspaceMembers({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("a missing top-level workspaceUpdateToken fails the whole response closed", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, members: [VALID_MEMBER] }));
    const result = await fetchWorkspaceMembers({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("a malformed workspaceUpdateToken (non-numeric seconds) fails closed", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, members: [VALID_MEMBER], workspaceUpdateToken: { seconds: "not-a-number", nanoseconds: 0 } }));
    const result = await fetchWorkspaceMembers({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("!res.ok -> error", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: false }, false));
    const result = await fetchWorkspaceMembers({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchWorkspaceMembers({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("transferWorkspaceOwnership — Ownership Transfer UI, Phase TEAM-MGMT-12C", () => {
  const TOKEN = { seconds: 1723600000, nanoseconds: 0 };

  it("2xx -> status ok", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, workspace: {}, oldOwnerMembership: {}, newOwnerMembership: {} }));
    const result = await transferWorkspaceOwnership({
      user: null,
      authReady: true,
      workspaceId: "ws-1",
      newOwnerUid: "target-uid",
      expectedWorkspaceUpdateTime: TOKEN,
      expectedOldOwnerMembershipUpdateTime: TOKEN,
      expectedNewOwnerMembershipUpdateTime: TOKEN,
    });
    expect(result).toEqual({ status: "ok" });
  });

  it("sends exactly one POST request, to the transfer-ownership route, with the target uid and all three OCC tokens verbatim", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true }));
    await transferWorkspaceOwnership({
      user: null,
      authReady: true,
      workspaceId: "ws-1",
      newOwnerUid: "target-uid",
      expectedWorkspaceUpdateTime: TOKEN,
      expectedOldOwnerMembershipUpdateTime: { seconds: 1, nanoseconds: 2 },
      expectedNewOwnerMembershipUpdateTime: { seconds: 3, nanoseconds: 4 },
    });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockedAuthedFetch.mock.calls[0];
    expect(url).toBe("/api/workspaces/ws-1/transfer-ownership");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      newOwnerUid: "target-uid",
      expectedWorkspaceUpdateTime: TOKEN,
      expectedOldOwnerMembershipUpdateTime: { seconds: 1, nanoseconds: 2 },
      expectedNewOwnerMembershipUpdateTime: { seconds: 3, nanoseconds: 4 },
    });
  });

  it("non-2xx (conflict) response maps to denied with the server's errorCode/message, never fabricated", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ errorCode: "conflict", message: "This Workspace changed since you last loaded it. Please refresh and try again." }) });
    const result = await transferWorkspaceOwnership({
      user: null,
      authReady: true,
      workspaceId: "ws-1",
      newOwnerUid: "target-uid",
      expectedWorkspaceUpdateTime: TOKEN,
      expectedOldOwnerMembershipUpdateTime: TOKEN,
      expectedNewOwnerMembershipUpdateTime: TOKEN,
    });
    expect(result).toEqual({ status: "denied", errorCode: "conflict", message: "This Workspace changed since you last loaded it. Please refresh and try again." });
  });

  it("non-2xx with an unparsable body still fails closed to a safe generic denied message, never throwing", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("not json"); } });
    const result = await transferWorkspaceOwnership({
      user: null,
      authReady: true,
      workspaceId: "ws-1",
      newOwnerUid: "target-uid",
      expectedWorkspaceUpdateTime: TOKEN,
      expectedOldOwnerMembershipUpdateTime: TOKEN,
      expectedNewOwnerMembershipUpdateTime: TOKEN,
    });
    expect(result).toEqual({ status: "denied", errorCode: "unknown_error", message: "We couldn't transfer ownership. Please try again." });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await transferWorkspaceOwnership({
      user: null,
      authReady: true,
      workspaceId: "ws-1",
      newOwnerUid: "target-uid",
      expectedWorkspaceUpdateTime: TOKEN,
      expectedOldOwnerMembershipUpdateTime: TOKEN,
      expectedNewOwnerMembershipUpdateTime: TOKEN,
    });
    expect(result).toEqual({ status: "error" });
  });
});

describe("changeMemberRole — Team Member Management, Phase 12B", () => {
  it("2xx with changed: true -> {status: 'ok', changed: true}", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, changed: true }));
    const result = await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "reviewer" });
    expect(result).toEqual({ status: "ok", changed: true });
  });

  it("2xx with changed: false (no-op) -> {status: 'ok', changed: false} — never collapsed into the same shape as a genuine change", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, changed: false }));
    const result = await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "member" });
    expect(result).toEqual({ status: "ok", changed: false });
  });

  it("sends exactly one POST request to the change-role route with only the target uid (in the URL) and the requested role in the body", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, changed: true }));
    await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "admin" });
    expect(mockedAuthedFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockedAuthedFetch.mock.calls[0];
    expect(url).toBe("/api/workspaces/ws-1/members/target-uid/change-role");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ role: "admin" });
  });

  it("non-2xx (role_change_forbidden) response maps to denied with the server's errorCode/message, never fabricated", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ errorCode: "role_change_forbidden", message: "You do not have permission to change this member's role." }) });
    const result = await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "admin" });
    expect(result).toEqual({ status: "denied", errorCode: "role_change_forbidden", message: "You do not have permission to change this member's role." });
  });

  it("2xx response missing/malformed 'changed' field -> error, never a fabricated true/false", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "member" });
    expect(result).toEqual({ status: "error" });
  });

  it("non-2xx with an unparsable body still fails closed to a safe generic denied message, never throwing", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("not json"); } });
    const result = await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "member" });
    expect(result).toEqual({ status: "denied", errorCode: "unknown_error", message: "We couldn't change this member's role. Please try again." });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await changeMemberRole({ user: null, authReady: true, workspaceId: "ws-1", targetUid: "target-uid", role: "member" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchWorkspaceAuditEvents — Phase 12B: workspace_member_role_changed acceptance", () => {
  it("accepts a workspace_member_role_changed event, including newRole", async () => {
    const roleChangedEvent = {
      eventType: "workspace_member_role_changed",
      occurredAt: "2026-09-01T20:46:25.000Z",
      actor: { displayName: "Olivia Owner" },
      target: { displayName: "Mo Member" },
      previousRole: "member",
      newRole: "reviewer",
    };
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [roleChangedEvent], hasMore: false }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", events: [roleChangedEvent], hasMore: false });
  });

  it("rejects a workspace_member_role_changed event missing newRole — fails closed rather than rendering an incomplete event", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        events: [{ eventType: "workspace_member_role_changed", occurredAt: "2026-09-01T20:46:25.000Z", actor: { displayName: "A" }, target: { displayName: "B" }, previousRole: "member" }],
        hasMore: false,
      })
    );
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("rejects a workspace_member_role_changed event with newRole: 'owner'", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        events: [{ eventType: "workspace_member_role_changed", occurredAt: "2026-09-01T20:46:25.000Z", actor: { displayName: "A" }, target: { displayName: "B" }, previousRole: "member", newRole: "owner" }],
        hasMore: false,
      })
    );
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchWorkspaceAuditEvents — Phase TEAM-MGMT-12C: workspace_ownership_transferred acceptance", () => {
  it("accepts a workspace_ownership_transferred event", async () => {
    const transferEvent = {
      eventType: "workspace_ownership_transferred",
      occurredAt: "2026-08-31T20:46:25.000Z",
      actor: { displayName: "Olivia Owner" },
      target: { displayName: "Adam Admin" },
      previousRole: "admin",
    };
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, events: [transferEvent], hasMore: false }));
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", events: [transferEvent], hasMore: false });
  });

  it("still rejects an unrecognized eventType (fails closed, forward-compatible)", async () => {
    mockedAuthedFetch.mockResolvedValue(
      jsonResponse({ ok: true, events: [{ eventType: "some_future_event", occurredAt: "2026-08-31T20:46:25.000Z", actor: { displayName: "A" }, target: { displayName: "B" }, previousRole: "member" }], hasMore: false })
    );
    const result = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchTeamProjectsExistence — Phase 12A.1 activation-state cheap existence check", () => {
  it("requests with ?limit=1 — never a full list fetch", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, items: [], hasMore: false }));
    await fetchTeamProjectsExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    const calledUrl = mockedAuthedFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/workspaces/ws-1/projects");
    expect(calledUrl).toContain("limit=1");
  });

  it("non-empty items -> hasAny: true", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, items: [{ id: "p1" }], hasMore: false }));
    const result = await fetchTeamProjectsExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", hasAny: true });
  });

  it("empty items -> hasAny: false", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, items: [], hasMore: false }));
    const result = await fetchTeamProjectsExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", hasAny: false });
  });

  it("non-2xx response -> error", async () => {
    mockedAuthedFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const result = await fetchTeamProjectsExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("malformed body (items missing) -> error, never a crash", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const result = await fetchTeamProjectsExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchTeamProjectsExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});

describe("fetchTeamResearchExistence — Phase 12A.1 activation-state cheap existence check", () => {
  it("requests with ?limit=1 against the runs endpoint", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, items: [], hasMore: false }));
    await fetchTeamResearchExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    const calledUrl = mockedAuthedFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/workspaces/ws-1/runs");
    expect(calledUrl).toContain("limit=1");
  });

  it("non-empty items -> hasAny: true", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, items: [{ id: "r1" }], hasMore: false }));
    const result = await fetchTeamResearchExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", hasAny: true });
  });

  it("empty items -> hasAny: false", async () => {
    mockedAuthedFetch.mockResolvedValue(jsonResponse({ ok: true, items: [], hasMore: false }));
    const result = await fetchTeamResearchExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "ok", hasAny: false });
  });

  it("thrown fetch -> error, never throws", async () => {
    mockedAuthedFetch.mockRejectedValue(new Error("network down"));
    const result = await fetchTeamResearchExistence({ user: null, authReady: true, workspaceId: "ws-1" });
    expect(result).toEqual({ status: "error" });
  });
});
