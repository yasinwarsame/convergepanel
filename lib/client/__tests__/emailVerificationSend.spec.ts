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

describe("THE FIX: the Firebase send itself is bounded", () => {
  const loadWithSend = async (send: unknown) => {
    jest.resetModules();
    jest.doMock("firebase/auth", () => ({ sendEmailVerification: send, reload: jest.fn() }));
    return import("../emailVerificationSend");
  };
  afterEach(() => { jest.useRealTimers(); jest.resetModules(); });

  it("a stalled sendEmailVerification times out instead of pending forever", async () => {
    const m = await loadWithSend(() => new Promise(() => {}));
    jest.useFakeTimers();
    const p = m.requestEmailVerification({ emailVerified: false } as never);
    jest.advanceTimersByTime(m.SEND_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual({ outcome: "send_timed_out" });
  });

  it("a timeout is NOT reported as send_failed — that would assert a rejection we do not know", async () => {
    const m = await loadWithSend(() => new Promise(() => {}));
    jest.useFakeTimers();
    const p = m.requestEmailVerification({ emailVerified: false } as never);
    jest.advanceTimersByTime(m.SEND_TIMEOUT_MS + 10);
    const r = await p;
    expect(r.outcome).not.toBe("send_failed");
    expect(r.outcome).not.toBe("send_accepted");
  });

  it("LATE COMPLETION: a send resolving after the deadline cannot change the outcome", async () => {
    let release: (v?: unknown) => void = () => {};
    const m = await loadWithSend(() => new Promise((res) => { release = res; }));
    jest.useFakeTimers();
    const p = m.requestEmailVerification({ emailVerified: false } as never);
    jest.advanceTimersByTime(m.SEND_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual({ outcome: "send_timed_out" });
    release();                       // Firebase finishes in the background
    await Promise.resolve();
    expect(await p).toEqual({ outcome: "send_timed_out" });
  });

  it("LATE REJECTION after the deadline does not surface as an unhandled rejection", async () => {
    let fail: (e?: unknown) => void = () => {};
    const m = await loadWithSend(() => new Promise((_r, rej) => { fail = rej; }));
    jest.useFakeTimers();
    const p = m.requestEmailVerification({ emailVerified: false } as never);
    jest.advanceTimersByTime(m.SEND_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual({ outcome: "send_timed_out" });
    expect(() => fail(new Error("late"))).not.toThrow();
    await Promise.resolve();
  });

  it("a send that resolves before the deadline is still accepted", async () => {
    const m = await loadWithSend(() => Promise.resolve());
    await expect(m.requestEmailVerification({ emailVerified: false } as never))
      .resolves.toEqual({ outcome: "send_accepted" });
  });

  it("MAX_RESEND_PENDING_MS counts every awaited operation, send included", async () => {
    const m = await loadWithSend(() => Promise.resolve());
    expect(m.MAX_RESEND_PENDING_MS).toBe(
      m.VERIFICATION_REFRESH_TIMEOUT_MS + m.SEND_TIMEOUT_MS + m.TELEMETRY_TIMEOUT_MS
    );
    // Would be the old, false value if the send bound were dropped.
    expect(m.MAX_RESEND_PENDING_MS).toBeGreaterThan(
      m.VERIFICATION_REFRESH_TIMEOUT_MS + m.TELEMETRY_TIMEOUT_MS
    );
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
describe("reportEmailVerificationSendOutcome — bounded END TO END", () => {
  const load = async (authedFetch: unknown) => {
    jest.resetModules();
    jest.doMock("@/lib/client/authedFetch", () => ({ authedFetch }));
    jest.doMock("firebase/auth", () => ({
      sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...(a as [])),
      reload: jest.fn(),
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

  it("passes a live AbortSignal so a started request is genuinely cancelled", async () => {
    let opts: { signal?: AbortSignal } | undefined;
    const m = await load((_u: string, o: { signal?: AbortSignal }) => { opts = o; return Promise.resolve(); });
    await m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "signup");
    expect(opts?.signal).toBeDefined();
    expect(opts?.signal?.aborted).toBe(false);
  });

  it("THE FIX: a stalled FETCH is aborted and returns timed_out", async () => {
    let seenSignal: AbortSignal | undefined;
    const m = await load((_u: string, o: { signal?: AbortSignal }) =>
      new Promise((_r, rej) => { seenSignal = o.signal; o.signal?.addEventListener("abort", () => rej(new Error("aborted"))); })
    );
    jest.useFakeTimers();
    const p = m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "resend");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(m.TELEMETRY_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe("timed_out");
    expect(seenSignal?.aborted).toBe(true);
  });

  it("THE FIX: a stall BEFORE the fetch (token acquisition) still returns timed_out", async () => {
    // authedFetch awaits user.getIdToken() before fetch; the AbortSignal cannot
    // cancel that, which is exactly how the control used to hang.
    const m = await load(() => new Promise(() => { /* never settles at all */ }));
    jest.useFakeTimers();
    const p = m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "resend");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(m.TELEMETRY_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe("timed_out");
  });

  it("THE FIX: late completion after the deadline emits NO diagnostic and cannot change the outcome", async () => {
    let release: (v: unknown) => void = () => {};
    let calls = 0;
    let sawAbortedAtCall: boolean | undefined;
    const m = await load((_u: string, o: { signal?: AbortSignal }) => {
      calls += 1;
      sawAbortedAtCall = o.signal?.aborted;
      return new Promise((res) => { release = res; });
    });
    jest.useFakeTimers();
    const p = m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "resend");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(m.TELEMETRY_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe("timed_out");
    // The stalled work finishes afterwards; the caller already has its answer.
    release(undefined);
    await Promise.resolve();
    expect(await p).toBe("timed_out");   // unchanged by late completion
    expect(calls).toBe(1);               // no second, late request
    expect(sawAbortedAtCall).toBe(false);
  });

  it("documents separate bounds, and a sum covering EVERY awaited operation", async () => {
    // This assertion previously encoded refresh + telemetry only, which was the
    // false 6s claim: it omitted the Firebase send sitting between them.
    const m = await load(() => Promise.resolve());
    expect(m.TELEMETRY_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(m.VERIFICATION_REFRESH_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(m.SEND_TIMEOUT_MS).toBeLessThanOrEqual(10000);
    expect(m.MAX_RESEND_PENDING_MS).toBe(
      m.VERIFICATION_REFRESH_TIMEOUT_MS + m.SEND_TIMEOUT_MS + m.TELEMETRY_TIMEOUT_MS
    );
  });
});

/**
 * THE R2 SURVIVOR. A mutation hard-coding `verification_email_send_accepted`
 * passed the whole suite because nothing inspected what the client actually
 * sent — so a FAILED send would have been logged to operators as resolved.
 * These parse the real body handed to the request layer.
 */
describe("telemetry request BODY reflects the real Firebase outcome", () => {
  const loadCapturing = async () => {
    jest.resetModules();
    const captured: { url?: string; body?: Record<string, unknown> } = {};
    jest.doMock("@/lib/client/authedFetch", () => ({
      authedFetch: (url: string, o: { body?: string }) => {
        captured.url = url;
        captured.body = JSON.parse(o.body ?? "{}");
        return Promise.resolve();
      },
    }));
    jest.doMock("firebase/auth", () => ({ sendEmailVerification: jest.fn(), reload: jest.fn() }));
    const m = await import("../emailVerificationSend");
    return { m, captured };
  };
  afterEach(() => jest.resetModules());

  it("send_accepted -> event verification_email_send_accepted", async () => {
    const { m, captured } = await loadCapturing();
    await m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "resend");
    expect(captured.body?.event).toBe("verification_email_send_accepted");
    expect(captured.body?.errorCode).toBeNull();
  });

  it("THE FIX: send_failed -> event verification_email_send_failed, never accepted", async () => {
    const { m, captured } = await loadCapturing();
    await m.reportEmailVerificationSendOutcome(
      {} as never, { outcome: "send_failed", errorCode: "auth/too-many-requests" }, "resend"
    );
    expect(captured.body?.event).toBe("verification_email_send_failed");
    expect(captured.body?.event).not.toBe("verification_email_send_accepted");
    expect(captured.body?.errorCode).toBe("auth/too-many-requests");
  });

  it("a failed send with no safe code sends errorCode null, not a fabricated one", async () => {
    const { m, captured } = await loadCapturing();
    await m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_failed", errorCode: null }, "signup");
    expect(captured.body?.event).toBe("verification_email_send_failed");
    expect(captured.body?.errorCode).toBeNull();
  });

  it("THE FIX: send_timed_out emits its own event, never accepted and never failed", async () => {
    const { m, captured } = await loadCapturing();
    await m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_timed_out" }, "resend");
    expect(captured.body?.event).toBe("verification_email_send_timed_out");
    expect(captured.body?.event).not.toBe("verification_email_send_accepted");
    expect(captured.body?.event).not.toBe("verification_email_send_failed");
    expect(captured.body?.errorCode).toBeNull();
  });

  it("source is the caller's, for signup and for resend", async () => {
    const a = await loadCapturing();
    await a.m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "signup");
    expect(a.captured.body?.source).toBe("signup");
    const b = await loadCapturing();
    await b.m.reportEmailVerificationSendOutcome({} as never, { outcome: "send_accepted" }, "resend");
    expect(b.captured.body?.source).toBe("resend");
  });

  it("posts to the diagnostic endpoint and carries no sensitive material", async () => {
    const { m, captured } = await loadCapturing();
    await m.reportEmailVerificationSendOutcome(
      {} as never, { outcome: "send_failed", errorCode: "auth/network-request-failed" }, "resend"
    );
    expect(captured.url).toBe("/api/user/email-verification-telemetry");
    expect(Object.keys(captured.body ?? {}).sort()).toEqual(["errorCode", "event", "source"]);
    expect(JSON.stringify(captured.body)).not.toMatch(/@|oobCode|token|password|https?:/i);
  });
});

/**
 * BOUNDED verification refresh. An unbounded reload() inside the resend window
 * was a second way to hang the control.
 */
describe("refreshVerificationStatus", () => {
  const loadWithReload = async (reload: unknown) => {
    jest.resetModules();
    jest.doMock("firebase/auth", () => ({ sendEmailVerification: jest.fn(), reload }));
    return import("../emailVerificationSend");
  };
  afterEach(() => { jest.useRealTimers(); jest.resetModules(); });

  it("verified after reload", async () => {
    const u = { emailVerified: false };
    const m = await loadWithReload(async () => { u.emailVerified = true; });
    await expect(m.refreshVerificationStatus(u as never)).resolves.toBe("verified");
  });

  it("still unverified after reload", async () => {
    const m = await loadWithReload(async () => {});
    await expect(m.refreshVerificationStatus({ emailVerified: false } as never)).resolves.toBe("still_unverified");
  });

  it("a fast failure is check_failed, NOT a send failure", async () => {
    const m = await loadWithReload(async () => { throw new Error("network"); });
    await expect(m.refreshVerificationStatus({ emailVerified: false } as never)).resolves.toBe("check_failed");
  });

  it("THE FIX: a hanging reload times out instead of pending forever", async () => {
    const m = await loadWithReload(() => new Promise(() => {}));
    jest.useFakeTimers();
    const p = m.refreshVerificationStatus({ emailVerified: false } as never);
    jest.advanceTimersByTime(m.VERIFICATION_REFRESH_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe("check_timed_out");
  });

  it("a null user is check_failed and never throws", async () => {
    const m = await loadWithReload(async () => {});
    await expect(m.refreshVerificationStatus(null)).resolves.toBe("check_failed");
  });
});
