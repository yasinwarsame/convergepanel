/**
 * Phase P0.2-VEMAIL-C1 — the client send helper.
 *
 * The defect these guard: a real Production signup silently swallowed the send
 * failure and reported only to PostHog, which is unconfigured in Production.
 * The outcome must now be explicit, and must never overstate what it proves.
 */

const sendEmailVerification = jest.fn();
jest.mock("firebase/auth", () => ({
  sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...(a as [])),
}));

import {
  requestEmailVerification,
  safeFirebaseErrorCode,
  reportEmailVerificationSendOutcome,
} from "../emailVerificationSend";

const unverified = { emailVerified: false } as never;
const verified = { emailVerified: true } as never;

beforeEach(() => sendEmailVerification.mockReset());

describe("requestEmailVerification", () => {
  it("unverified + SDK resolves -> send_accepted", async () => {
    sendEmailVerification.mockResolvedValue(undefined);
    await expect(requestEmailVerification(unverified)).resolves.toEqual({ outcome: "send_accepted" });
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("THE FIX: unverified + SDK rejects -> send_failed, never silently swallowed", async () => {
    sendEmailVerification.mockRejectedValue({ code: "auth/too-many-requests" });
    await expect(requestEmailVerification(unverified)).resolves.toEqual({
      outcome: "send_failed",
      errorCode: "auth/too-many-requests",
    });
  });

  it("already verified -> already_verified, and NO email is requested", async () => {
    await expect(requestEmailVerification(verified)).resolves.toEqual({ outcome: "already_verified" });
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it("never throws into the caller, whatever the SDK does", async () => {
    sendEmailVerification.mockRejectedValue(new Error("boom"));
    await expect(requestEmailVerification(unverified)).resolves.toEqual({
      outcome: "send_failed",
      errorCode: null,
    });
  });
});

describe("safeFirebaseErrorCode — sensitive material must not propagate", () => {
  it("passes a well-formed Firebase code", () => {
    expect(safeFirebaseErrorCode({ code: "auth/invalid-email" })).toBe("auth/invalid-email");
  });

  it.each([
    ["a message instead of a code", { message: "user token abc123" }],
    ["a non-auth namespace", { code: "firestore/permission-denied" }],
    ["an over-long code", { code: "auth/" + "x".repeat(60) }],
    ["uppercase / path-like junk", { code: "auth/../../etc/passwd" }],
    ["a non-string code", { code: 42 }],
    ["null", null],
    ["a bare string", "auth/too-many-requests"],
  ])("drops %s", (_label, input) => {
    expect(safeFirebaseErrorCode(input)).toBeNull();
  });

  it("REGRESSION: does not surface customData, which can carry the email or link", () => {
    const err = {
      code: "auth/too-many-requests",
      message: "sensitive",
      customData: { email: "victim@example.com", link: "https://…oobCode=SECRET" },
    };
    const out = safeFirebaseErrorCode(err);
    expect(out).toBe("auth/too-many-requests");
    expect(JSON.stringify(out)).not.toMatch(/victim@example\.com|oobCode|SECRET|sensitive/);
  });
});

describe("reportEmailVerificationSendOutcome", () => {
  it("does not report for an already-verified identity", async () => {
    const spy = jest.fn();
    jest.doMock("@/lib/client/authedFetch", () => ({ authedFetch: spy }));
    await reportEmailVerificationSendOutcome({} as never, { outcome: "already_verified" }, "resend");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is best-effort: a telemetry failure never throws into signup or resend", async () => {
    jest.doMock("@/lib/client/authedFetch", () => ({
      authedFetch: () => Promise.reject(new Error("network down")),
    }));
    await expect(
      reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "signup")
    ).resolves.toBeUndefined();
  });
});
