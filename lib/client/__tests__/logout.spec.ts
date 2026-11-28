/**
 * The shared explicit-logout sequence (`lib/client/logout.ts`), ZCA L-2 then P3 R2.
 *
 * Converted from the L-2 spec: the bounded server clear (cleared / failed / timed_out) and the
 * "session clear failed" login URL flag were DELETED with the client DELETE (there is no server session).
 * Pins now: (1) beginLogout → LOCAL Firebase signOut, nothing else, no request of any kind;
 * (2) a THROWING local sign-out calls cancelLogout exactly once and is reported as completed only
 * when Firebase reports nobody (R2 L-1); (3) a successful sign-out never calls cancelLogout.
 */
import * as logoutModule from "@/lib/client/logout";
import { performLogout, LOGIN_HREF_AFTER_LOGOUT } from "@/lib/client/logout";
import type { Auth } from "firebase/auth";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const SAVED_FETCH = (globalThis as { fetch?: unknown }).fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled(); // R2 MA: logout sends no request at all
});
afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = SAVED_FETCH;
});

describe("performLogout", () => {
  it("runs beginLogout, then the LOCAL sign-out — and nothing after it", async () => {
    const log: string[] = [];
    const signOutGate = deferred<void>();
    const auth = { currentUser: { uid: "a" } } as unknown as Auth;
    const p = performLogout({
      auth,
      beginLogout: () => log.push("begin"),
      cancelLogout: () => log.push("cancel"),
      signOut: async () => { log.push("signOut:start"); await signOutGate.promise; log.push("signOut:done"); },
    });
    await Promise.resolve();
    expect(log).toEqual(["begin", "signOut:start"]);
    signOutGate.resolve();
    await expect(p).resolves.toEqual({ signedOut: true });
    expect(log).toEqual(["begin", "signOut:start", "signOut:done"]);
  });

  it("R2 MB: a THROWING local sign-out with the user still present → cancelLogout exactly once, NOT reported as signed out", async () => {
    const log: string[] = [];
    const auth = { currentUser: { uid: "a" } } as unknown as Auth;
    const result = await performLogout({
      auth,
      beginLogout: () => log.push("begin"),
      cancelLogout: () => log.push("cancel"),
      signOut: async () => { throw new Error("storage unavailable"); },
    });
    expect(result).toEqual({ signedOut: false });
    expect(log).toEqual(["begin", "cancel"]);
  });

  it("R2 L-1: a THROWING local sign-out after which Firebase reports NOBODY → cancelLogout once, reported as signed out", async () => {
    const log: string[] = [];
    const auth = { currentUser: { uid: "a" } } as { currentUser: unknown };
    const result = await performLogout({
      auth: auth as unknown as Auth,
      beginLogout: () => log.push("begin"),
      cancelLogout: () => log.push("cancel"),
      signOut: async () => { auth.currentUser = null; throw new Error("partial failure after clearing the user"); },
    });
    expect(result).toEqual({ signedOut: true });
    expect(log).toEqual(["begin", "cancel"]);
  });

  it("a successful sign-out never calls cancelLogout", async () => {
    const cancelLogout = jest.fn();
    await performLogout({ auth: { currentUser: null } as unknown as Auth, beginLogout: () => undefined, cancelLogout, signOut: async () => undefined });
    expect(cancelLogout).not.toHaveBeenCalled();
  });

  it("the login destination is the plain signed-out URL (no sessionClear* flag exists any more)", () => {
    expect(LOGIN_HREF_AFTER_LOGOUT).toBe("/login?signedOut=1");
    expect(Object.keys(logoutModule).sort()).toEqual(["LOGIN_HREF_AFTER_LOGOUT", "performLogout"]);
  });
});
