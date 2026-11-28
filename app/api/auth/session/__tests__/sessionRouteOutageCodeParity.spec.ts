/**
 * Stage 0 F1 — the session handshake and `resolveRequestIdentity` classify "the verifier could not run" with ONE
 * predicate. Every one of the nine outage codes from the `checkRevoked` live read (`verifyIdToken(…, true)`) answers
 * 503 auth_unavailable; every credential verdict stays 401. Parity is asserted against the exported predicate over a
 * broad code list, so a future divergence fails here. (ZCA P3 R2: the cookie-creation rows were DELETED with cookie
 * creation; every response carries only the `__session` expiry.)
 */
const mockVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: require("./handshakeHarness").strictAdminAuth((...args: unknown[]) => mockVerifyIdToken(...args)),
}));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/authTelemetry", () => ({ logAuthSessionEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/auth/session/route";
import { isVerifierUnavailableCode } from "@/lib/auth/resolveRequestIdentity";
import { expectExpiryOnly, forbiddenAdminAccess } from "./handshakeHarness";

const NINE = [
  "auth/internal-error",
  "auth/quota-exceeded",
  "auth/insufficient-permission",
  "auth/invalid-credential",
  "app/internal-error",
  "app/network-error",
  "app/network-timeout",
  "app/unable-to-parse-response",
  "app/invalid-credential",
];
const CREDENTIAL_VERDICTS = [
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/user-not-found",
  "auth/id-token-expired",
  "auth/argument-error",
  "auth/invalid-id-token",
  "auth/session-cookie-revoked",
  "auth/invalid-argument",
  "app/network-error ", // near miss (trailing space)
  "AUTH/INTERNAL-ERROR", // near miss (case)
  "",
];
const UNAVAILABLE = { error: "Authentication service unavailable", code: "auth_unavailable" };

const post = () =>
  POST(new NextRequest("http://localhost/api/auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: "synthetic-token" }) }));
const fbErr = (code: string) => Object.assign(new Error("upstream detail"), { code });
beforeEach(() => {
  jest.clearAllMocks();
  forbiddenAdminAccess.length = 0;
});
afterEach(() => expect(forbiddenAdminAccess).toEqual([]));

describe("Stage 0 F1 — handshake outage classification equals resolveRequestIdentity's", () => {
  it("the shared predicate is exactly the nine codes (control for the parity rows below)", () => {
    for (const c of NINE) expect(isVerifierUnavailableCode(c)).toBe(true);
    for (const c of CREDENTIAL_VERDICTS) expect(isVerifierUnavailableCode(c)).toBe(false);
  });

  it.each(NINE)("verifyIdToken(checkRevoked) outage %s → 503 auth_unavailable, only the expiry", async (code) => {
    mockVerifyIdToken.mockRejectedValue(fbErr(code));
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expectExpiryOnly(res);
    expect(mockVerifyIdToken).toHaveBeenCalledWith("synthetic-token", true); // revocation check preserved
  });

  it.each(CREDENTIAL_VERDICTS)("verifyIdToken credential verdict %p is NOT reclassified as an outage → 401 without the code", async (code) => {
    mockVerifyIdToken.mockRejectedValue(fbErr(code));
    const res = await post();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired token" });
    expectExpiryOnly(res);
  });
});
