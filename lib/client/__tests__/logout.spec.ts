/**
 * ZCA L-2 — the shared explicit-logout sequence (`lib/client/logout.ts`).
 *
 * Pins: (1) the order beginLogout → LOCAL Firebase signOut → server clear; (2) the outcome is
 * reported as it is (cleared / failed / timed_out), never as a clean sign-out when the clear did
 * not succeed; (3) a failed local sign-out is never reported as signed out and sends no clear;
 * (4) the clear is bounded for reporting, but it is NOT cancelled (it stays in flight, so R-S0-7's
 * mint-after-DELETE ordering keeps holding for it).
 */
import { performLogout, loginHrefAfterLogout, LOGOUT_CLEAR_TIMEOUT_MS } from "@/lib/client/logout";
import type { Auth } from "firebase/auth";

const auth = { currentUser: { uid: "a" } } as unknown as Auth;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("performLogout", () => {
  afterEach(() => jest.useRealTimers());

  it("runs beginLogout, then the LOCAL sign-out, then the clear — and the clear only starts after signOut resolved", async () => {
    const log: string[] = [];
    const signOutGate = deferred<void>();
    const p = performLogout({
      auth,
      beginLogout: () => log.push("begin"),
      signOut: async () => { log.push("signOut:start"); await signOutGate.promise; log.push("signOut:done"); },
      clear: async () => { log.push("clear"); return true; },
    });
    await Promise.resolve();
    expect(log).toEqual(["begin", "signOut:start"]);
    signOutGate.resolve();
    await expect(p).resolves.toEqual({ signedOut: true, serverCleared: "cleared" });
    expect(log).toEqual(["begin", "signOut:start", "signOut:done", "clear"]);
  });

  it.each([
    ["the clear answers non-2xx (false)", async () => false, "failed"],
    ["the clear rejects (network)", async () => { throw new TypeError("network"); }, "failed"],
  ] as const)("reports a failed clear as failed when %s", async (_n, clear, expected) => {
    const r = await performLogout({ auth, beginLogout: () => undefined, signOut: async () => undefined, clear });
    expect(r).toEqual({ signedOut: true, serverCleared: expected });
  });

  it("a hung clear is reported as timed_out at the bound — and is left running, not cancelled", async () => {
    jest.useFakeTimers();
    const hung = deferred<boolean>();
    let settled = false;
    hung.promise.then(() => { settled = true; });
    const p = performLogout({ auth, beginLogout: () => undefined, signOut: async () => undefined, clear: () => hung.promise });
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(LOGOUT_CLEAR_TIMEOUT_MS - 1);
    let early: unknown = "pending";
    void p.then((v) => { early = v; });
    await Promise.resolve();
    expect(early).toBe("pending");
    jest.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ signedOut: true, serverCleared: "timed_out" });
    expect(settled).toBe(false); // the DELETE is still in flight; nothing aborted it
    hung.resolve(true);
    await hung.promise;
    expect(settled).toBe(true);
  });

  it("a failed LOCAL sign-out is never reported as signed out, and sends no clear", async () => {
    const clear = jest.fn(async () => true);
    const r = await performLogout({ auth, beginLogout: () => undefined, signOut: async () => { throw new Error("indexeddb"); }, clear });
    expect(r).toEqual({ signedOut: false });
    expect(clear).not.toHaveBeenCalled();
  });

  it("beginLogout runs even when the sign-out then fails (protected operations are disabled first)", async () => {
    const begin = jest.fn();
    await performLogout({ auth, beginLogout: begin, signOut: async () => { throw new Error("x"); }, clear: async () => true });
    expect(begin).toHaveBeenCalledTimes(1);
  });
});

describe("loginHrefAfterLogout", () => {
  it("only a confirmed clear goes to the clean signed-out page", () => {
    expect(loginHrefAfterLogout({ signedOut: true, serverCleared: "cleared" })).toBe("/login?signedOut=1");
    expect(loginHrefAfterLogout({ signedOut: true, serverCleared: "failed" })).toBe("/login?signedOut=1&sessionClearFailed=1");
    expect(loginHrefAfterLogout({ signedOut: true, serverCleared: "timed_out" })).toBe("/login?signedOut=1&sessionClearFailed=1");
  });
});
