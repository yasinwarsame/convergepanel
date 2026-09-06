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

import { requestEmailVerification, safeFirebaseErrorCode } from "../emailVerificationSend";

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

/**
 * These reset the module registry per case. `reportEmailVerificationSendOutcome`
 * resolves `authedFetch` through a DYNAMIC import, so a `jest.doMock` after the
 * module has already been loaded is silently ignored and the assertion passes
 * for the wrong reason. Isolating forces each case to exercise its own double.
 */
describe("reportEmailVerificationSendOutcome — bounded and best-effort", () => {
  const load = async (authedFetch: unknown) => {
    jest.resetModules();
    jest.doMock("@/lib/client/authedFetch", () => ({ authedFetch }));
    jest.doMock("firebase/auth", () => ({
      sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...(a as [])),
    }));
    return import("../emailVerificationSend");
  };

  afterEach(() => { jest.useRealTimers(); jest.resetModules(); });

  it("does not report for an already-verified identity", async () => {
    const spy = jest.fn();
    const m = await load(spy);
    await expect(
      m.reportEmailVerificationSendOutcome({} as never, { outcome: "already_verified" }, "resend")
    ).resolves.toBe("skipped");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a telemetry failure never throws into signup or resend", async () => {
    const m = await load(() => Promise.reject(new Error("network down")));
    await expect(
      m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "signup")
    ).resolves.toBe("failed");
  });

  it("passes a live AbortSignal so the request can be cancelled cleanly", async () => {
    let opts: { signal?: AbortSignal } | undefined;
    const m = await load((_u: string, o: { signal?: AbortSignal }) => { opts = o; return Promise.resolve(); });
    await m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "signup");
    expect(opts?.signal).toBeDefined();
    expect(opts?.signal?.aborted).toBe(false);
  });

  it("THE FIX: a request that never resolves is ABORTED and returns timed_out", async () => {
    let seenSignal: AbortSignal | undefined;
    const m = await load((_u: string, o: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        seenSignal = o.signal;
        o.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })
    );
    jest.useFakeTimers();
    const p = m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "resend");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(m.TELEMETRY_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe("timed_out");
    // Genuinely aborted — not merely raced, leaving the request running.
    expect(seenSignal?.aborted).toBe(true);
  });

  it("the bound is short enough not to stall a user flow", async () => {
    const m = await load(() => Promise.resolve());
    expect(m.TELEMETRY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(m.TELEMETRY_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
