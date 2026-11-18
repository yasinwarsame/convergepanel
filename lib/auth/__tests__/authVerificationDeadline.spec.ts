/**
 * R5 C — the SHARED end-to-end credential-verification deadline and the
 * per-instance cap on ABANDONED verifications (`lib/auth/authVerificationDeadline.ts`).
 *
 * Used by `resolveRequestIdentity` (every request-identity route) and by the
 * session mint (`POST /api/auth/session`). firebase-admin 12.7.0 has no
 * AbortSignal, so a verification still pending at the deadline is ABANDONED:
 * its result is ignored, but its SDK call (and socket) lives on until the SDK
 * gives up (~133–140 s measured; an upstream that drips bytes resets the SDK's
 * idle timeout and can hold it longer). Contract pinned here:
 *   - one deadline per `startVerificationDeadline()`, AUTH_VERIFICATION_DEADLINE_MS = 10 s;
 *   - a task still pending at the deadline → `deadline` (never its late value);
 *   - each such task counts as ONE abandoned verification until its promise
 *     settles — fulfilled or rejected — and then the count goes back down;
 *   - at MAX_ABANDONED_AUTH_VERIFICATIONS abandoned, a new upstream task is
 *     refused (`capped`) WITHOUT calling its start function;
 *   - a task that makes no upstream call (`upstream: false`) is neither capped nor counted;
 *   - distinct log lines for a deadline cut-off and a cap refusal, carrying no
 *     credential, token or uid.
 */

const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), debug: jest.fn() } }));

import * as deadlineModule from "@/lib/auth/authVerificationDeadline";
import {
  AUTH_VERIFICATION_DEADLINE_MS,
  MAX_ABANDONED_AUTH_VERIFICATIONS,
  abandonedAuthVerificationsInFlight,
  startVerificationDeadline,
  type VerificationOutcome,
} from "@/lib/auth/authVerificationDeadline";

const DEADLINE = 10_000;
const CAP = 100;

/** A controllable upstream call: pending until released either way. */
type Hung = { promise: Promise<string>; resolve: (v: string) => void; reject: (e: unknown) => void };
const hung: Hung[] = [];
function hang(): Promise<string> {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  hung.push({ promise, resolve, reject });
  return promise;
}

function track<T>(p: Promise<VerificationOutcome<T>>) {
  const t: { settled: boolean; value?: VerificationOutcome<T> } = { settled: false };
  p.then((v) => {
    t.settled = true;
    t.value = v;
  });
  return t;
}

/** Fills the instance up to the cap with abandoned verifications; returns them (still pending). */
async function fillToCap(): Promise<Hung[]> {
  const before = hung.length;
  const d = startVerificationDeadline("request_identity");
  const n = CAP - abandonedAuthVerificationsInFlight();
  for (let i = 0; i < n; i++) void d.run(() => hang());
  await jest.advanceTimersByTimeAsync(DEADLINE);
  d.dispose();
  expect(abandonedAuthVerificationsInFlight()).toBe(CAP);
  return hung.slice(before);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockWarn.mockReset();
});
afterEach(async () => {
  // Release every hung upstream call so the abandoned count drains — and prove it does.
  for (const h of hung.splice(0)) h.resolve("late");
  await jest.advanceTimersByTimeAsync(0);
  expect(abandonedAuthVerificationsInFlight()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

describe("frozen constants", () => {
  it("the deadline is 10 s and the abandoned-verification cap is 100", () => {
    expect(AUTH_VERIFICATION_DEADLINE_MS).toBe(DEADLINE);
    expect(MAX_ABANDONED_AUTH_VERIFICATIONS).toBe(CAP);
  });

  it("the deadline and cap outcomes are frozen objects", async () => {
    const d = startVerificationDeadline("request_identity");
    const late = track(d.run(() => hang()));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(late.value).toEqual({ kind: "deadline" });
    expect(Object.isFrozen(late.value)).toBe(true);
    d.dispose();
    await fillToCap();
    const d2 = startVerificationDeadline("request_identity");
    const capped = await d2.run(() => hang());
    d2.dispose();
    expect(capped).toEqual({ kind: "capped" });
    expect(Object.isFrozen(capped)).toBe(true);
  });
});

describe("the deadline", () => {
  it("passes through a value or an error that arrives in time; nothing is counted; no timer survives dispose", async () => {
    const d = startVerificationDeadline("session_mint");
    await expect(d.run(async () => "ok")).resolves.toEqual({ kind: "fulfilled", value: "ok" });
    const err = Object.assign(new Error("x"), { code: "auth/id-token-revoked" });
    await expect(d.run(async () => Promise.reject(err))).resolves.toEqual({ kind: "rejected", error: err });
    // a start function that throws synchronously is a rejection, not a crash
    await expect(d.run(() => { throw err; })).resolves.toEqual({ kind: "rejected", error: err });
    d.dispose();
    expect(abandonedAuthVerificationsInFlight()).toBe(0);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("a pending task is still pending 1 ms before the deadline and is `deadline` AT it; its late value is never returned", async () => {
    const d = startVerificationDeadline("request_identity");
    const t = track(d.run(() => hang()));
    await jest.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(t.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual({ kind: "deadline" });
    hung[0].resolve("valid-but-late");
    await jest.advanceTimersByTimeAsync(0);
    expect(t.value).toEqual({ kind: "deadline" });
    d.dispose();
  });

  it("ONE deadline per startVerificationDeadline: a second task started at 6 s is cut at 10 s, not 16 s", async () => {
    const d = startVerificationDeadline("session_mint");
    await jest.advanceTimersByTimeAsync(6_000);
    const t = track(d.run(() => hang()));
    await jest.advanceTimersByTimeAsync(3_999);
    expect(t.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual({ kind: "deadline" });
    d.dispose();
  });

  it("a task started AFTER the deadline fired is `deadline` without its upstream call ever starting", async () => {
    const d = startVerificationDeadline("session_mint");
    void d.run(() => hang());
    await jest.advanceTimersByTimeAsync(DEADLINE);
    const start = jest.fn(async () => "never");
    await expect(d.run(start)).resolves.toEqual({ kind: "deadline" });
    expect(start).not.toHaveBeenCalled();
    d.dispose();
  });
});

describe("abandoned-verification accounting", () => {
  it("a task pending at the deadline counts as ONE abandoned verification until it settles (fulfilled)", async () => {
    const d = startVerificationDeadline("request_identity");
    void d.run(() => hang());
    await jest.advanceTimersByTimeAsync(DEADLINE);
    d.dispose();
    expect(abandonedAuthVerificationsInFlight()).toBe(1);
    hung.shift()!.resolve("late");
    await jest.advanceTimersByTimeAsync(0);
    expect(abandonedAuthVerificationsInFlight()).toBe(0);
  });

  it("…and goes back down when it settles by REJECTION, with no unhandled rejection", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const d = startVerificationDeadline("request_identity");
      void d.run(() => hang());
      void d.run(() => hang());
      await jest.advanceTimersByTimeAsync(DEADLINE);
      d.dispose();
      expect(abandonedAuthVerificationsInFlight()).toBe(2);
      hung.shift()!.reject(Object.assign(new Error("socket hang up"), { code: "app/network-error" }));
      hung.shift()!.reject(new Error("anything"));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(0);
      expect(abandonedAuthVerificationsInFlight()).toBe(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("a task that settled in time is never counted, even though the same deadline later cuts another task", async () => {
    const d = startVerificationDeadline("request_identity");
    await d.run(async () => "fast");
    void d.run(() => hang());
    await jest.advanceTimersByTimeAsync(DEADLINE);
    d.dispose();
    expect(abandonedAuthVerificationsInFlight()).toBe(1);
  });

  it("an `upstream: false` task (no network call possible) is neither counted nor capped", async () => {
    const d = startVerificationDeadline("request_identity");
    void d.run(() => hang(), { upstream: false });
    await jest.advanceTimersByTimeAsync(DEADLINE);
    d.dispose();
    expect(abandonedAuthVerificationsInFlight()).toBe(0);
    await fillToCap();
    const d2 = startVerificationDeadline("request_identity");
    const start = jest.fn(async () => null);
    await expect(d2.run(start, { upstream: false })).resolves.toEqual({ kind: "fulfilled", value: null });
    expect(start).toHaveBeenCalledTimes(1);
    d2.dispose();
  });
});

describe("the per-instance cap", () => {
  it("at the cap, a new verification fails fast as `capped` and its upstream call is NEVER started", async () => {
    await fillToCap();
    const d = startVerificationDeadline("request_identity");
    const start = jest.fn(async () => "would-be-valid");
    await expect(d.run(start)).resolves.toEqual({ kind: "capped" });
    expect(start).not.toHaveBeenCalled();
    d.dispose();
  });

  it("one below the cap, a verification still starts", async () => {
    const filled = await fillToCap();
    filled[0].resolve("late");
    await jest.advanceTimersByTimeAsync(0);
    expect(abandonedAuthVerificationsInFlight()).toBe(CAP - 1);
    const d = startVerificationDeadline("session_mint");
    const start = jest.fn(async () => "ok");
    await expect(d.run(start)).resolves.toEqual({ kind: "fulfilled", value: "ok" });
    expect(start).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("the cap is shared by every site on the instance (request identity and session mint draw on the same sockets)", async () => {
    await fillToCap(); // filled through request_identity
    const d = startVerificationDeadline("session_mint");
    const start = jest.fn(async () => "ok");
    await expect(d.run(start)).resolves.toEqual({ kind: "capped" });
    expect(start).not.toHaveBeenCalled();
    d.dispose();
  });

  it("recovers once abandoned calls settle (no latch, no leak)", async () => {
    const filled = await fillToCap();
    for (const h of filled) h.reject(new Error("gave up"));
    await jest.advanceTimersByTimeAsync(0);
    expect(abandonedAuthVerificationsInFlight()).toBe(0);
    const d = startVerificationDeadline("request_identity");
    await expect(d.run(async () => "ok")).resolves.toEqual({ kind: "fulfilled", value: "ok" });
    d.dispose();
  });
});

describe("log lines (no credential, token or uid)", () => {
  it("a deadline cut-off logs ONE `deadline_exceeded` line per deadline, counting the tasks it abandoned", async () => {
    const d = startVerificationDeadline("request_identity");
    void d.run(() => hang());
    void d.run(() => hang());
    await jest.advanceTimersByTimeAsync(DEADLINE);
    d.dispose();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith("[auth-verification] deadline_exceeded", {
      site: "request_identity",
      deadlineMs: DEADLINE,
      abandoned: 2,
      abandonedInFlight: 2,
    });
  });

  it("a cap refusal logs `abandoned_cap_refused`, distinct from a deadline cut-off", async () => {
    await fillToCap();
    mockWarn.mockReset();
    const d = startVerificationDeadline("session_mint");
    await d.run(async () => "x");
    d.dispose();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith("[auth-verification] abandoned_cap_refused", {
      site: "session_mint",
      abandonedInFlight: CAP,
      cap: CAP,
    });
  });

  it("a fast answer — valid OR a fast outage error — logs nothing here (the caller's own outage log covers it)", async () => {
    const d = startVerificationDeadline("request_identity");
    await d.run(async () => "ok");
    await d.run(async () => Promise.reject(Object.assign(new Error("x"), { code: "auth/internal-error" })));
    await jest.advanceTimersByTimeAsync(DEADLINE);
    d.dispose();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

/**
 * R5 C review (MINOR-1, reviewer of 773add4): the cap must be a HARD bound on
 * upstream verification calls in flight — counted from START (inside the 10 s
 * window too), released exactly once when the call settles (in time or after
 * being abandoned). Counting only calls abandoned at the deadline let every
 * call started inside a window through: 1,000 hung starts in 5 s all started,
 * and each dip below the cap admitted another full window.
 */
describe("hard bound on in-flight upstream verifications (review overshoot scenarios)", () => {
  const mod = deadlineModule as unknown as Record<string, unknown>;
  const inFlight = () => (mod.authVerificationsInFlight as () => number)();
  const HARD_CAP = 256;

  it("the in-flight cap is 256", () => {
    expect(mod.MAX_INFLIGHT_AUTH_VERIFICATIONS).toBe(HARD_CAP);
  });

  it("(review a) 1,000 hung starts over 5 s during a full hang: exactly 256 start; in flight never exceeds 256", async () => {
    let started = 0;
    let peak = 0;
    const outcomes: Array<Promise<VerificationOutcome<string>>> = [];
    const ds: Array<ReturnType<typeof startVerificationDeadline>> = [];
    for (let i = 0; i < 1000; i++) {
      const d = startVerificationDeadline("request_identity");
      ds.push(d);
      outcomes.push(d.run(() => { started += 1; return hang(); }));
      peak = Math.max(peak, inFlight());
      if (i % 200 === 199) await jest.advanceTimersByTimeAsync(1_000);
    }
    await jest.advanceTimersByTimeAsync(10_000);
    peak = Math.max(peak, inFlight());
    expect(started).toBe(HARD_CAP);
    expect(peak).toBe(HARD_CAP);
    const kinds = (await Promise.all(outcomes)).map((o) => o.kind);
    expect(kinds.filter((k) => k === "capped")).toHaveLength(1000 - HARD_CAP);
    expect(kinds.filter((k) => k === "deadline")).toHaveLength(HARD_CAP);
    expect(abandonedAuthVerificationsInFlight()).toBe(HARD_CAP);
    ds.forEach((d) => d.dispose());
  });

  it("(review b) at the cap, one call settles, 500 arrive: exactly ONE starts; in flight stays at 256", async () => {
    let started = 0;
    const fill = startVerificationDeadline("request_identity");
    for (let i = 0; i < HARD_CAP; i++) void fill.run(() => { started += 1; return hang(); });
    await jest.advanceTimersByTimeAsync(DEADLINE);
    fill.dispose();
    expect(inFlight()).toBe(HARD_CAP);
    hung.shift()!.resolve("late");
    await jest.advanceTimersByTimeAsync(0);
    expect(inFlight()).toBe(HARD_CAP - 1);
    started = 0;
    const ds: Array<ReturnType<typeof startVerificationDeadline>> = [];
    for (let i = 0; i < 500; i++) {
      const d = startVerificationDeadline("request_identity");
      ds.push(d);
      void d.run(() => { started += 1; return hang(); });
    }
    await jest.advanceTimersByTimeAsync(DEADLINE);
    expect(started).toBe(1);
    expect(inFlight()).toBe(HARD_CAP);
    ds.forEach((d) => d.dispose());
  });

  it("calls still INSIDE their window count: 256 slow-but-pending calls → the 257th is refused before start; one answering in time frees a slot", async () => {
    const d = startVerificationDeadline("session_mint");
    for (let i = 0; i < HARD_CAP; i++) void d.run(() => hang());
    expect(inFlight()).toBe(HARD_CAP);
    expect(abandonedAuthVerificationsInFlight()).toBe(0); // none abandoned yet: all inside the window
    const start = jest.fn(async () => "x");
    await expect(d.run(start)).resolves.toEqual({ kind: "capped" });
    expect(start).not.toHaveBeenCalled();
    hung.shift()!.resolve("in-time");
    await jest.advanceTimersByTimeAsync(0);
    expect(inFlight()).toBe(HARD_CAP - 1);
    await expect(d.run(start)).resolves.toEqual({ kind: "fulfilled", value: "x" });
    expect(start).toHaveBeenCalledTimes(1);
    d.dispose();
  });

  it("each call is released EXACTLY once — in time, abandoned-then-fulfilled, abandoned-then-rejected, or synchronous throw", async () => {
    const d = startVerificationDeadline("request_identity");
    await d.run(async () => "fast");
    await d.run(() => { throw new Error("sync"); });
    expect(inFlight()).toBe(0);
    void d.run(() => hang());
    void d.run(() => hang());
    expect(inFlight()).toBe(2);
    await jest.advanceTimersByTimeAsync(DEADLINE);
    d.dispose();
    expect(inFlight()).toBe(2);
    expect(abandonedAuthVerificationsInFlight()).toBe(2);
    hung.shift()!.resolve("late");
    hung.shift()!.reject(new Error("late failure"));
    await jest.advanceTimersByTimeAsync(0);
    expect(inFlight()).toBe(0);
    expect(abandonedAuthVerificationsInFlight()).toBe(0);
  });

  it("`upstream: false` work is not counted in flight", async () => {
    const d = startVerificationDeadline("request_identity");
    void d.run(() => hang(), { upstream: false });
    expect(inFlight()).toBe(0);
    hung.shift()!.resolve("x");
    await jest.advanceTimersByTimeAsync(0);
    d.dispose();
  });

  it("the cap-refusal log reports the in-flight total (not just abandoned calls)", async () => {
    const d = startVerificationDeadline("session_mint");
    for (let i = 0; i < HARD_CAP; i++) void d.run(() => hang());
    mockWarn.mockReset();
    await d.run(async () => "x");
    expect(mockWarn).toHaveBeenCalledWith("[auth-verification] in_flight_cap_refused", {
      site: "session_mint",
      inFlight: HARD_CAP,
      abandonedInFlight: 0,
      cap: HARD_CAP,
    });
    d.dispose();
  });
});
