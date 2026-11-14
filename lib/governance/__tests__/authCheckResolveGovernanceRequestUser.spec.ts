/**
 * `resolveGovernanceRequestUser()` — the authentication of the mixed-audience
 * governance handlers.
 *
 * History: Step 7.15 moved it onto the shared strict cookie + bearer resolver
 * (a stale cookie must never win over a different bearer); Phase
 * FIRESTORE-AUTHZ-P0.2 made `emailVerified` travel with the email out of the
 * live record. SEC-3 / S2-b correction (owner ruling D): it is now the
 * privileged-access guard's own authentication without a tier decision, so the
 * same truth table holds, PLUS revocation of every presented credential against
 * the live record and 503 (never 401, never a grant) on a verifier or lookup
 * outage.
 *
 * Doubles live only at the Admin SDK boundary (shared privileged harness).
 */

jest.mock("@/lib/firebase/admin", () => require("@/lib/admin/__tests__/privilegedRouteHarness").firebaseAdminModuleDouble());

import { NextRequest } from "next/server";
import {
  AUTH_TIME,
  authCalls,
  authState,
  installPrivilegedHarness,
  mintCredential,
} from "@/lib/admin/__tests__/privilegedRouteHarness";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";

installPrivilegedHarness();

const A = "user-a";
const B = "user-b";

function cred(kind: "bearer" | "cookie", uid: string, decoded: Record<string, unknown> | Error = {}): string {
  const c = mintCredential(kind, uid);
  const map = kind === "bearer" ? authState.tokens : authState.cookies;
  map.set(c, decoded instanceof Error ? decoded : { uid, sub: uid, auth_time: AUTH_TIME, ...decoded });
  return c;
}
function record(uid: string, over: Record<string, unknown> = {}) {
  authState.records.set(uid, { uid, email: "user@example.com", emailVerified: true, disabled: false, ...over });
}
function req(opts: { cookie?: string; bearer?: string; authorization?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `__session=${opts.cookie}`;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  else if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest("http://localhost/api/governance/audit", { headers });
}
const outage = () => Object.assign(new Error("socket hang up"), { code: "app/network-error" });

describe("resolveGovernanceRequestUser — credential truth table (SP-5)", () => {
  beforeEach(() => {
    record(A);
    record(B);
  });

  it("no credentials -> 401, no live read", async () => {
    await expect(resolveGovernanceRequestUser(req())).resolves.toEqual({ ok: false, status: 401 });
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });

  it("valid cookie only -> ok with the cookie uid and the live email", async () => {
    await expect(resolveGovernanceRequestUser(req({ cookie: cred("cookie", A) }))).resolves.toEqual({
      ok: true, uid: A, email: "user@example.com", emailVerified: true,
    });
  });

  it("valid bearer only -> ok with the bearer uid", async () => {
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", B) }))).resolves.toEqual({
      ok: true, uid: B, email: "user@example.com", emailVerified: true,
    });
  });

  it("valid cookie + valid bearer for the SAME uid -> ok", async () => {
    const r = await resolveGovernanceRequestUser(req({ cookie: cred("cookie", A), bearer: cred("bearer", A) }));
    expect(r).toMatchObject({ ok: true, uid: A });
  });

  it("REGRESSION (Step 7.15 root cause): mismatched valid cookie + bearer -> 401, neither identity used", async () => {
    const r = await resolveGovernanceRequestUser(req({ cookie: cred("cookie", A), bearer: cred("bearer", B) }));
    expect(r).toEqual({ ok: false, status: 401 });
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });

  it("invalid cookie only -> 401", async () => {
    await expect(resolveGovernanceRequestUser(req({ cookie: "garbage" }))).resolves.toEqual({ ok: false, status: 401 });
  });

  it("valid cookie + well-formed but unverifiable bearer -> 401, no fallback to the cookie", async () => {
    const forged = mintCredential("bearer", A); // never registered: the SDK double rejects its signature
    const r = await resolveGovernanceRequestUser(req({ cookie: cred("cookie", A), bearer: forged }));
    expect(r).toEqual({ ok: false, status: 401 });
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });

  it.each([
    ["empty header", ""],
    ["no scheme", "token-without-scheme"],
    ["Bearer with nothing after it", "Bearer "],
    ["not a JWS", "Bearer not-a-jws"],
  ])("malformed Authorization (%s) beside a valid cookie -> 401, no fallback", async (_n, authorization) => {
    const r = await resolveGovernanceRequestUser(req({ cookie: cred("cookie", A), authorization }));
    expect(r).toEqual({ ok: false, status: 401 });
  });

  it("an empty __session cookie beside a valid bearer is a presented credential that failed -> 401", async () => {
    const r = await resolveGovernanceRequestUser(req({ cookie: "", bearer: cred("bearer", A) }));
    expect(r).toEqual({ ok: false, status: 401 });
  });
});

describe("live record: deletion, disablement, revocation", () => {
  it("deleted account -> 401", async () => {
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A) }))).resolves.toEqual({ ok: false, status: 401 });
  });

  it.each([["true", true], ["absent", undefined], ["non-boolean", "false"]])("disabled %s -> 401 (only an explicit false admits)", async (_n, disabled) => {
    record(A, { disabled });
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A) }))).resolves.toEqual({ ok: false, status: 401 });
  });

  const cutoff = (secondsAfterAuth: number) => new Date((AUTH_TIME + secondsAfterAuth) * 1000).toUTCString();

  it.each(["bearer", "cookie"] as const)("%s issued BEFORE tokensValidAfterTime -> 401", async (kind) => {
    record(A, { tokensValidAfterTime: cutoff(60) });
    await expect(resolveGovernanceRequestUser(req({ [kind]: cred(kind, A) }))).resolves.toEqual({ ok: false, status: 401 });
  });

  it("revoked bearer + fresh same-uid cookie -> 401 (every presented credential is checked)", async () => {
    record(A, { tokensValidAfterTime: cutoff(60) });
    const freshCookie = cred("cookie", A, { auth_time: AUTH_TIME + 120 });
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A), cookie: freshCookie }))).resolves.toEqual({ ok: false, status: 401 });
  });

  it("auth_time EQUAL to the cutoff is not revoked; an unparseable cutoff is", async () => {
    record(A, { tokensValidAfterTime: cutoff(0) });
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A) }))).resolves.toMatchObject({ ok: true });
    record(A, { tokensValidAfterTime: "not a date" });
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A) }))).resolves.toEqual({ ok: false, status: 401 });
  });

  it("the SDK is never asked to check revocation (no second lookup), and the record is read once", async () => {
    record(A);
    await resolveGovernanceRequestUser(req({ bearer: cred("bearer", A), cookie: cred("cookie", A) }));
    expect(authCalls.verifyIdToken.mock.calls.map((c) => c[1])).toEqual([false]);
    expect(authCalls.verifySessionCookie.mock.calls.map((c) => c[1])).toEqual([false]);
    expect(authCalls.getUser.mock.calls).toEqual([[A]]);
  });
});

describe("outage is 503, never a grant and never a silent 401 (A-2 / SP-2)", () => {
  it("verifier outage on the bearer -> 503, no live read", async () => {
    record(A);
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A, outage()) }))).resolves.toEqual({ ok: false, status: 503 });
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });

  it("verifier outage on the cookie -> 503", async () => {
    record(A);
    await expect(resolveGovernanceRequestUser(req({ cookie: cred("cookie", A, outage()) }))).resolves.toEqual({ ok: false, status: 503 });
  });

  it("getUser outage -> 503", async () => {
    authState.records.set(A, outage());
    await expect(resolveGovernanceRequestUser(req({ bearer: cred("bearer", A) }))).resolves.toEqual({ ok: false, status: 503 });
  });

  it("Admin SDK uninitialised -> 503", async () => {
    authState.available = false;
    await expect(resolveGovernanceRequestUser(req({ bearer: mintCredential("bearer", A) }))).resolves.toEqual({ ok: false, status: 503 });
  });
});

/**
 * Phase FIRESTORE-AUTHZ-P0.2 — VERIFICATION PROVENANCE (DATA CONTRACT): the
 * resolver propagates Firebase Auth's verification state out of the live
 * record it reads and never manufactures it. Authority does NOT flow through
 * this field (see verifiedGovernanceAuthority.spec.ts); it must still be true.
 */
describe("emailVerified provenance — read from the live Auth record, never manufactured", () => {
  it.each([
    ["verified", { emailVerified: true }, true],
    ["UNVERIFIED (the load-bearing case)", { emailVerified: false }, false],
    ["absent", { emailVerified: undefined }, false],
    ["null", { emailVerified: null }, false],
    ['string "true"', { emailVerified: "true" }, false],
    ["number 1", { emailVerified: 1 }, false],
  ])("record %s -> emailVerified %s", async (_n, over, expected) => {
    record(A, over);
    await expect(resolveGovernanceRequestUser(req({ cookie: cred("cookie", A) }))).resolves.toEqual({
      ok: true, uid: A, email: "user@example.com", emailVerified: expected,
    });
  });

  it("email and verification come from the SAME single record read", async () => {
    record(A, { email: "other@example.com", emailVerified: false });
    await expect(resolveGovernanceRequestUser(req({ cookie: cred("cookie", A) }))).resolves.toEqual({
      ok: true, uid: A, email: "other@example.com", emailVerified: false,
    });
    expect(authCalls.getUser.mock.calls).toEqual([[A]]);
  });
});
