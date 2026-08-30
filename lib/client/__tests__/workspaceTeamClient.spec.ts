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

import { fetchPendingInvitations, createInvitation, resendInvitation } from "@/lib/client/workspaceTeamClient";

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
