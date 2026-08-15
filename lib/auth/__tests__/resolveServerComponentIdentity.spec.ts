/**
 * Phase 5C — resolveServerComponentIdentity(). Proves this is genuinely
 * an adapter around the SAME verification primitive `resolveRequestIdentity()`
 * uses (`verifySessionCookieValue`), not a second, independently-written
 * authentication path — the mock below is the exact function
 * `verifySessionCookie(request)` itself now delegates to.
 */

let cookieValue: string | undefined;
jest.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (name === "__session" && cookieValue !== undefined ? { value: cookieValue } : undefined),
  }),
}));

const mockedVerifySessionCookieValue = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  verifySessionCookieValue: (...args: any[]) => mockedVerifySessionCookieValue(...args),
}));

import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";

beforeEach(() => {
  cookieValue = undefined;
  jest.clearAllMocks();
});

describe("resolveServerComponentIdentity", () => {
  it("no credential (no __session cookie) -> null, without even calling the verifier with a truthy value", async () => {
    mockedVerifySessionCookieValue.mockResolvedValue(null);
    const result = await resolveServerComponentIdentity();
    expect(result).toBeNull();
    expect(mockedVerifySessionCookieValue).toHaveBeenCalledWith(undefined);
  });

  it("valid credential -> resolves the uid via the SAME verification function resolveRequestIdentity() uses", async () => {
    cookieValue = "a-real-session-cookie-value";
    mockedVerifySessionCookieValue.mockResolvedValue({ uid: "owner-1", isAdmin: false });
    const result = await resolveServerComponentIdentity();
    expect(result).toEqual({ uid: "owner-1" });
    expect(mockedVerifySessionCookieValue).toHaveBeenCalledWith("a-real-session-cookie-value");
  });

  it("expired/invalid/revoked credential (verifier throws) -> null, never propagates the raw error", async () => {
    cookieValue = "an-expired-cookie";
    mockedVerifySessionCookieValue.mockRejectedValue(Object.assign(new Error("session expired"), { code: "auth/session-cookie-expired" }));
    const result = await resolveServerComponentIdentity();
    expect(result).toBeNull();
  });

  it("Admin Auth unavailable (verifier throws a non-Firebase-coded error) -> null, fails closed rather than throwing out of the page render", async () => {
    cookieValue = "some-cookie";
    mockedVerifySessionCookieValue.mockRejectedValue(new Error("Firebase Admin Auth is not initialized."));
    const result = await resolveServerComponentIdentity();
    expect(result).toBeNull();
  });

  it("SECURITY: an unsigned/client-supplied cookie value that fails verification never establishes identity — the resolver's own decision (via the mocked verifier) is authoritative, this module adds no bypass", async () => {
    cookieValue = "attacker-forged-value";
    mockedVerifySessionCookieValue.mockResolvedValue(null); // simulates the real Admin SDK rejecting a forged/garbage value
    const result = await resolveServerComponentIdentity();
    expect(result).toBeNull();
  });

  it("returns only {uid} — never isAdmin or any other claim, keeping this module's surface minimal", async () => {
    cookieValue = "a-real-session-cookie-value";
    mockedVerifySessionCookieValue.mockResolvedValue({ uid: "owner-1", isAdmin: true });
    const result = await resolveServerComponentIdentity();
    expect(result).toEqual({ uid: "owner-1" });
    expect(Object.keys(result!)).toEqual(["uid"]);
  });
});
