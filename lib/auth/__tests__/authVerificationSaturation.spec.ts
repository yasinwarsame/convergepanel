/**
 * R6 C (owner Order C) — bounded admission control under partial, total and
 * ENDLESS upstream hangs, recovery, and the operator saturation signal
 * (`lib/auth/authVerificationDeadline.ts`).
 *
 * Contract pinned here:
 *   - partial hang: in-flight never exceeds the cap; healthy verifications are
 *     admitted until hung calls fill the cap, then refused (`capped`) without
 *     their start function running — never fulfilled;
 *   - total / endless hang: the instance stays at the cap (fail closed) for as
 *     long as the hung calls stay unsettled — the count is never reset, not by
 *     the deadline and not by elapsed time;
 *   - recovery: each slot returns only when ITS call settles; admission resumes
 *     slot by slot;
 *   - saturation signal: `[auth-verification] saturated` (logger.error) at most
 *     once per SATURATION_SIGNAL_INTERVAL_MS while refusals happen or a call is
 *     older than STUCK_IN_FLIGHT_MS; `[auth-verification] saturation_recovered`
 *     (logger.info) once when admission resumes with nothing stuck. No
 *     credential, token or uid is ever in either line.
 *
 * Each test loads a FRESH module (module state is per instance).
 */

const mockError = jest.fn();
const mockWarn = jest.fn();
const mockInfo = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => mockError(...a), warn: (...a: unknown[]) => mockWarn(...a), info: (...a: unknown[]) => mockInfo(...a), debug: jest.fn() },
}));

// Long simulated runs (minutes to an hour of fake time) — generous wall-clock allowance under machine load.
jest.setTimeout(120_000);

type Mod = typeof import("@/lib/auth/authVerificationDeadline");
let mod: Mod;

const DEADLINE = 10_000;
const CAP = 256;

type Hung = { resolve: (v: string) => void; reject: (e: unknown) => void };
let hung: Hung[] = [];
function hang(): Promise<string> {
  return new Promise<string>((resolve, reject) => hung.push({ resolve, reject }));
}

function saturatedSignals() {
  return mockError.mock.calls.filter(([m]) => m === "[auth-verification] saturated").map(([, d]) => d as Record<string, unknown>);
}
function recoveredSignals() {
  return mockInfo.mock.calls.filter(([m]) => m === "[auth-verification] saturation_recovered").map(([, d]) => d as Record<string, unknown>);
}

/** One request-style verification: own deadline, one upstream task. Resolves to its outcome kind. */
async function verify(start: () => Promise<string>, site: "request_identity" | "session_mint" = "request_identity") {
  const d = mod.startVerificationDeadline(site);
  try {
    return (await d.run(start)).kind;
  } finally {
    d.dispose();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  mod = require("@/lib/auth/authVerificationDeadline") as Mod;
  hung = [];
  mockError.mockReset();
  mockWarn.mockReset();
  mockInfo.mockReset();
});
afterEach(async () => {
  for (const h of hung.splice(0)) h.resolve("late");
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(mod.authVerificationsInFlight()).toBe(0);
  jest.useRealTimers();
});

it("exports the signal thresholds: 60 s rate limit; a call is 'stuck' after 60 × the 10 s deadline (beyond the SDK's own finite retry worst case)", () => {
  expect(mod.AUTH_VERIFICATION_DEADLINE_MS).toBe(10_000);
  expect(mod.MAX_INFLIGHT_AUTH_VERIFICATIONS).toBe(CAP);
  expect(mod.SATURATION_SIGNAL_INTERVAL_MS).toBe(60_000);
  expect(mod.STUCK_IN_FLIGHT_MS).toBe(600_000);
});

it("partial hang: 2 of every 40 verifications/s hang; in-flight never exceeds the cap; healthy ones are admitted until the cap fills, then refused without starting; recovery resumes admission", async () => {
  let started = 0;
  let maxInFlight = 0;
  const healthy = () => {
    started += 1;
    maxInFlight = Math.max(maxInFlight, mod.authVerificationsInFlight());
    return Promise.resolve("ok");
  };
  const hanging = () => {
    started += 1;
    maxInFlight = Math.max(maxInFlight, mod.authVerificationsInFlight());
    return hang();
  };
  const tally: Record<string, number> = { fulfilled: 0, capped: 0, deadline: 0, rejected: 0 };
  let firstRefusalSecond = -1;
  const all: Array<Promise<string>> = [];
  for (let s = 0; s < 160; s++) {
    for (let i = 0; i < 40; i++) {
      all.push(
        verify(i < 2 ? hanging : healthy).then((k) => {
          tally[k] += 1;
          if (k === "capped" && firstRefusalSecond < 0) firstRefusalSecond = s;
          return k;
        })
      );
    }
    await jest.advanceTimersByTimeAsync(1_000);
  }
  await jest.advanceTimersByTimeAsync(DEADLINE);
  await Promise.all(all);
  expect(maxInFlight).toBeLessThanOrEqual(CAP);
  expect(mod.authVerificationsInFlight()).toBe(CAP);
  expect(hung).toHaveLength(CAP); // exactly CAP hanging calls were ever started
  // Each batch's 40 calls are admitted together (in flight at once) on top of the 2·s hung ones,
  // so refusals start once 2·s + 40 > CAP (second 109) — never before — and from second 128 the
  // hung calls alone hold every slot.
  expect(firstRefusalSecond).toBe(109);
  expect(tally.capped).toBeGreaterThan(0);
  expect(tally.rejected).toBe(0);
  // Every admitted call ran its start function exactly once; refused ones never did.
  expect(started).toBe(tally.fulfilled + tally.deadline);
  // Hung calls answer `deadline`, never their late value.
  expect(tally.deadline).toBe(CAP);

  // Recovery: 10 hung calls settle → exactly 10 slots return; 10 healthy are admitted, the 11th refused.
  for (const h of hung.splice(0, 10)) h.resolve("late");
  await jest.advanceTimersByTimeAsync(0);
  expect(mod.authVerificationsInFlight()).toBe(CAP - 10);
  const pending = Array.from({ length: 10 }, () => verify(hanging));
  expect(mod.authVerificationsInFlight()).toBe(CAP);
  expect(await verify(healthy)).toBe("capped");
  await jest.advanceTimersByTimeAsync(DEADLINE);
  for (const k of await Promise.all(pending)) expect(k).toBe("deadline");
});

it("total ENDLESS hang: the instance stays at the cap for an hour — never reset by the deadline or by elapsed time — and fails closed on every attempt", async () => {
  const fill = Array.from({ length: CAP }, () => verify(hang));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  for (const k of await Promise.all(fill)) expect(k).toBe("deadline");
  expect(mod.abandonedAuthVerificationsInFlight()).toBe(CAP);

  const start = jest.fn(async () => "would-be-valid");
  for (let s = 0; s < 3_600; s++) {
    expect(await verify(start)).toBe("capped");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mod.authVerificationsInFlight()).toBe(CAP);
  }
  expect(start).not.toHaveBeenCalled();
  expect(mod.abandonedAuthVerificationsInFlight()).toBe(CAP);
  expect(mod.oldestAuthVerificationInFlightMs()).toBeGreaterThanOrEqual(3_600_000);
});

it("saturation signal: one `saturated` error per 60 s while refusals continue, carrying counts only; the per-refusal flood is gone", async () => {
  const fill = Array.from({ length: CAP }, () => verify(hang));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  await Promise.all(fill);
  mockError.mockReset();
  mockWarn.mockReset();

  // 10 refusals per second for 5 minutes = 3,000 refusals.
  for (let s = 0; s < 300; s++) {
    for (let i = 0; i < 10; i++) expect(await verify(async () => "secret-token-value", "session_mint")).toBe("capped");
    await jest.advanceTimersByTimeAsync(1_000);
  }
  const sig = saturatedSignals();
  expect(sig).toHaveLength(5);
  expect(sig[0]).toEqual({
    site: "session_mint",
    trigger: "cap_refused",
    inFlight: CAP,
    abandonedInFlight: CAP,
    cap: CAP,
    refusedSinceLastSignal: 1,
    refusedTotal: 1,
    stuckInFlight: 0,
    oldestInFlightMs: DEADLINE,
    stuckThresholdMs: 600_000,
  });
  // Each later signal reports the refusals suppressed since the previous one (60 s × 10/s).
  for (const later of sig.slice(1)) expect(later.refusedSinceLastSignal).toBe(600);
  expect(sig[4].refusedTotal).toBe(2_401);
  expect(mod.authVerificationRefusalsTotal()).toBe(3_000);
  // No per-refusal warn line any more.
  expect(mockWarn.mock.calls.filter(([m]) => String(m).includes("cap_refused"))).toHaveLength(0);
  expect(JSON.stringify([mockError.mock.calls, mockWarn.mock.calls, mockInfo.mock.calls])).not.toContain("secret-token-value");
});

it("stuck signal: below the cap, a call unsettled for > 600 s raises `saturated` (trigger stuck_in_flight) on the next admission; settling it emits `saturation_recovered` once", async () => {
  const stuck = verify(hang);
  await jest.advanceTimersByTimeAsync(DEADLINE);
  expect(await stuck).toBe("deadline");

  // 599 s old: not stuck yet.
  await jest.advanceTimersByTimeAsync(600_000 - DEADLINE - 1_000);
  expect(await verify(async () => "ok")).toBe("fulfilled");
  expect(saturatedSignals()).toHaveLength(0);

  await jest.advanceTimersByTimeAsync(2_000);
  expect(await verify(async () => "ok")).toBe("fulfilled"); // still admitted: below the cap
  expect(saturatedSignals()).toEqual([
    {
      site: "request_identity",
      trigger: "stuck_in_flight",
      inFlight: 1,
      abandonedInFlight: 1,
      cap: CAP,
      refusedSinceLastSignal: 0,
      refusedTotal: 0,
      stuckInFlight: 1,
      oldestInFlightMs: 601_000,
      stuckThresholdMs: 600_000,
    },
  ]);
  // Rate-limited: more admissions inside 60 s do not repeat it.
  expect(await verify(async () => "ok")).toBe("fulfilled");
  expect(saturatedSignals()).toHaveLength(1);
  expect(recoveredSignals()).toHaveLength(0);

  hung.shift()!.resolve("late");
  await jest.advanceTimersByTimeAsync(0);
  expect(await verify(async () => "ok")).toBe("fulfilled");
  expect(await verify(async () => "ok")).toBe("fulfilled");
  expect(recoveredSignals()).toEqual([{ site: "request_identity", inFlight: 0, abandonedInFlight: 0, cap: CAP }]);
});

it("recovery after total saturation: slots return one per settled call; the first admission with nothing stuck emits `saturation_recovered` once", async () => {
  const fill = Array.from({ length: CAP }, () => verify(hang));
  await jest.advanceTimersByTimeAsync(DEADLINE);
  await Promise.all(fill);
  expect(await verify(async () => "ok")).toBe("capped");
  expect(saturatedSignals()).toHaveLength(1);

  hung.shift()!.resolve("late");
  await jest.advanceTimersByTimeAsync(0);
  expect(mod.authVerificationsInFlight()).toBe(CAP - 1);
  const admitted = verify(hang);
  expect(mod.authVerificationsInFlight()).toBe(CAP);
  expect(recoveredSignals()).toHaveLength(1);
  expect(await verify(async () => "ok")).toBe("capped");

  for (const h of hung.splice(0)) h.resolve("late");
  await jest.advanceTimersByTimeAsync(0);
  expect(await admitted).toBe("fulfilled"); // settled inside its own deadline
  expect(mod.authVerificationsInFlight()).toBe(0);
  for (let i = 0; i < 5; i++) expect(await verify(async () => "ok")).toBe("fulfilled");
  // At most one `saturation_recovered` per emitted `saturated`: the refusal inside the 60 s window
  // was counted but not signalled, so clean admissions do not repeat the recovery line.
  expect(recoveredSignals()).toHaveLength(1);
  expect(saturatedSignals()).toHaveLength(1);
  expect(mod.authVerificationRefusalsTotal()).toBe(2);

  // Past the window, the next refusal is signalled again with the suppressed count.
  const refill = Array.from({ length: CAP }, () => verify(hang));
  await jest.advanceTimersByTimeAsync(60_000);
  await Promise.all(refill);
  expect(await verify(async () => "ok")).toBe("capped");
  expect(saturatedSignals()).toHaveLength(2);
  expect(saturatedSignals()[1]).toMatchObject({ trigger: "cap_refused", refusedSinceLastSignal: 2, refusedTotal: 3 });
});

it("concurrency: 1,000 verifications started in one tick — exactly CAP start; the rest refused synchronously; none is ever fulfilled by a refused call", async () => {
  let started = 0;
  const kinds: string[] = [];
  const all = Array.from({ length: 1_000 }, () =>
    verify(() => {
      started += 1;
      return hang();
    }).then((k) => (kinds.push(k), k))
  );
  await jest.advanceTimersByTimeAsync(0);
  expect(started).toBe(CAP);
  expect(kinds.filter((k) => k === "capped")).toHaveLength(1_000 - CAP);
  for (const h of hung.splice(0)) h.resolve("late-valid");
  await jest.advanceTimersByTimeAsync(0);
  await Promise.all(all);
  expect(kinds.filter((k) => k === "fulfilled")).toHaveLength(CAP);
  expect(saturatedSignals()).toHaveLength(1);
  expect(saturatedSignals()[0].refusedSinceLastSignal).toBe(1);
});
