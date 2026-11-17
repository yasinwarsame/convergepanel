/**
 * API-1a C-2: resolveManagementIdentity — negative matrix with a fake Firebase Auth port (no network),
 * parity with resolveRequestIdentity's strict cookie/bearer table, the production Firebase entry point,
 * end to end with authorizeOrgManagement, and the DARK / import-boundary pins.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const mockVerifySessionCookie = jest.fn();
const mockVerifyIdToken = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({ verifySessionCookie: (...a: unknown[]) => mockVerifySessionCookie(...a) }));
jest.mock("@/lib/firebase/auth", () => ({ verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a) }));
const mockAdmin: { adminAuth: unknown } = { adminAuth: undefined };
jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return mockAdmin.adminAuth;
  },
}));

import {
  AUTH_TIME_FUTURE_SKEW_SECONDS,
  resolveManagementIdentity,
  resolveManagementIdentityWithFirebase,
  type ManagementAuthPort,
  type ManagementIdentityResult,
} from "@/lib/auth/resolveManagementIdentity";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { authorizeOrgManagement, type ManagementDeps } from "@/lib/apiPlatform/management";
import { API_ERRORS } from "@/lib/apiPlatform/errors";
import { computeApiOrgMembershipId } from "@/lib/apiPlatform/tenantPaths";
import { newOrgId } from "@/lib/apiPlatform/ids";
import type { OrgCapability } from "@/lib/apiPlatform/orgCapabilities";

const NOW = 2_000_000_000;
const now = () => NOW;

function codeErr(code: string): Error & { code: string } {
  return Object.assign(new Error(`Firebase: ${code}`), { code });
}

interface FakeUser { uid: string; disabled: unknown; emailVerified: unknown; tokensValidAfterSeconds: number }
interface FakeToken { kind: "cookie" | "bearer"; uid: string; auth_time?: unknown; exp: number }

/**
 * Behaves like firebase-admin for the paths that matter: an unknown string is auth/argument-error; an expired
 * token throws the *-expired code; ONLY when checkRevoked === true does it throw user-disabled for a disabled
 * account and *-revoked when auth_time predates tokensValidAfterTime (exactly the SDK's rule).
 */
class FakeAuth implements ManagementAuthPort {
  users = new Map<string, FakeUser>();
  tokens = new Map<string, FakeToken>();
  calls: string[] = [];
  getUserError: unknown = null;
  getUserOverride: ((uid: string) => unknown) | null = null;

  user(uid: string, over: Partial<FakeUser> = {}) {
    this.users.set(uid, { uid, disabled: false, emailVerified: true, tokensValidAfterSeconds: 0, ...over });
    return this;
  }
  token(value: string, t: Partial<FakeToken> & { kind: FakeToken["kind"]; uid: string }) {
    this.tokens.set(value, { auth_time: NOW - 60, exp: NOW + 3600, ...t });
    return value;
  }
  private verify(kind: FakeToken["kind"], value: string, checkRevoked: boolean) {
    const t = this.tokens.get(value);
    if (!t || t.kind !== kind) throw codeErr("auth/argument-error");
    if (t.exp <= NOW) throw codeErr(kind === "cookie" ? "auth/session-cookie-expired" : "auth/id-token-expired");
    if (checkRevoked === true) {
      const u = this.users.get(t.uid);
      if (u?.disabled === true) throw codeErr("auth/user-disabled");
      if (u && u.tokensValidAfterSeconds > 0 && typeof t.auth_time === "number" && t.auth_time < u.tokensValidAfterSeconds) {
        throw codeErr(kind === "cookie" ? "auth/session-cookie-revoked" : "auth/id-token-revoked");
      }
    }
    const decoded: { uid: string; auth_time?: unknown } = { uid: t.uid };
    if ("auth_time" in t) decoded.auth_time = t.auth_time;
    return decoded;
  }
  async verifySessionCookie(v: string, checkRevoked: boolean) {
    this.calls.push(`cookie:${checkRevoked}`);
    return this.verify("cookie", v, checkRevoked);
  }
  async verifyIdToken(v: string, checkRevoked: boolean) {
    this.calls.push(`bearer:${checkRevoked}`);
    return this.verify("bearer", v, checkRevoked);
  }
  async getUser(uid: string) {
    this.calls.push(`getUser:${uid}`);
    if (this.getUserError) throw this.getUserError;
    if (this.getUserOverride) return this.getUserOverride(uid);
    const u = this.users.get(uid);
    if (!u) throw codeErr("auth/user-not-found");
    return { uid: u.uid, disabled: u.disabled, emailVerified: u.emailVerified, email: `${uid}@example.test` };
  }
}

function req(opts: { cookie?: string; authorization?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `__session=${opts.cookie}`;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  return new NextRequest("http://localhost/api/developer/x", { headers });
}

/**
 * Asymmetric matcher for a failure: exactly the ENUMERABLE keys `ok`, `code`, plus a non-enumerable `reason`.
 * (A plain `{ ok, reason, code }` would not match a correct result, whose `reason` is hidden from serialization.)
 */
const failed = (reason: string, code: string) => ({
  asymmetricMatch: (r: unknown) => {
    if (typeof r !== "object" || r === null) return false;
    const o = r as Record<string, unknown>;
    const d = Object.getOwnPropertyDescriptor(o, "reason");
    return JSON.stringify(Object.keys(o).sort()) === '["code","ok"]' && o.ok === false && o.code === code
      && !!d && d.enumerable === false && d.value === reason && Object.isFrozen(o);
  },
  toString: () => `failed(${reason}, ${code})`,
  toAsymmetricMatcher: () => `failed(${reason}, ${code})`,
});

function world() {
  const auth = new FakeAuth().user("uA").user("uB");
  const cookieA = auth.token("cookie-a", { kind: "cookie", uid: "uA" });
  const bearerA = auth.token("bearer-a", { kind: "bearer", uid: "uA", auth_time: NOW - 30 });
  const bearerB = auth.token("bearer-b", { kind: "bearer", uid: "uB" });
  return { auth, cookieA, bearerA, bearerB };
}

describe("resolveManagementIdentity: accepted credentials", () => {
  it("valid cookie → frozen identity with the VERIFIED token's auth_time; revocation checked", async () => {
    const { auth, cookieA } = world();
    const r = await resolveManagementIdentity(req({ cookie: cookieA }), auth, now);
    expect(r).toEqual({ ok: true, identity: { uid: "uA", authTimeSeconds: NOW - 60, emailVerified: true, disabled: false, source: "session_cookie" } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen((r as { identity: object }).identity)).toBe(true);
    expect(auth.calls).toEqual(["cookie:true", "getUser:uA"]);
  });

  it("valid bearer → bearer_token; verifyIdToken called with checkRevoked = true", async () => {
    const { auth, bearerA } = world();
    const r = await resolveManagementIdentity(req({ authorization: `Bearer ${bearerA}` }), auth, now);
    expect(r).toEqual({ ok: true, identity: { uid: "uA", authTimeSeconds: NOW - 30, emailVerified: true, disabled: false, source: "bearer_token" } });
    expect(auth.calls).toEqual(["bearer:true", "getUser:uA"]);
  });

  it("matching cookie + bearer → matching_cookie_and_bearer, the OLDER auth_time", async () => {
    const { auth, cookieA, bearerA } = world();
    const r = await resolveManagementIdentity(req({ cookie: cookieA, authorization: `Bearer ${bearerA}` }), auth, now);
    expect(r.ok && r.identity).toEqual({ uid: "uA", authTimeSeconds: NOW - 60, emailVerified: true, disabled: false, source: "matching_cookie_and_bearer" });
  });

  it("auth_time is the token's, never request time (an hour-old login stays an hour old)", async () => {
    const { auth } = world();
    const old = auth.token("cookie-old", { kind: "cookie", uid: "uA", auth_time: NOW - 3600 });
    const r = await resolveManagementIdentity(req({ cookie: old }), auth, now);
    expect(r.ok && r.identity.authTimeSeconds).toBe(NOW - 3600);
  });

  it(`auth_time up to ${AUTH_TIME_FUTURE_SKEW_SECONDS} s in the future (clock skew) is accepted`, async () => {
    const { auth } = world();
    const t = auth.token("cookie-skew", { kind: "cookie", uid: "uA", auth_time: NOW + AUTH_TIME_FUTURE_SKEW_SECONDS });
    expect((await resolveManagementIdentity(req({ cookie: t }), auth, now)).ok).toBe(true);
  });
});

describe("resolveManagementIdentity: negative matrix", () => {
  it("no credentials → missing_credentials, no Firebase call", async () => {
    const { auth } = world();
    expect(await resolveManagementIdentity(req(), auth, now)).toEqual(failed("missing_credentials", "session_required"));
    expect(auth.calls).toEqual([]);
  });

  it.each([
    { authorization: `Bearer cpk_live_AAAAAAAAAAAA_${"a".repeat(43)}` },
    { authorization: "bearer cpk_test_x" },
    { authorization: "BEARER   cpk_" },
    { authorization: "  Bearer cpk_live_x" },
    { authorization: `Bearer cpk_live_x`, cookie: "cookie-a" },
    { cookie: `cpk_live_AAAAAAAAAAAA_${"a".repeat(43)}` },
    { cookie: "CPK_test_x", authorization: "Bearer bearer-a" },
  ])("API key on the management path %j → api_key_not_accepted before ANY Firebase call", async (o) => {
    const { auth } = world();
    expect(await resolveManagementIdentity(req(o), auth, now)).toEqual(failed("api_key_not_accepted", "api_key_not_accepted"));
    expect(auth.calls).toEqual([]);
  });

  it("disabled account (verification with checkRevoked) → account_disabled → 401 session_required", async () => {
    const { auth, cookieA, bearerA } = world();
    auth.user("uA", { disabled: true });
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("account_disabled", "session_required"));
    expect(await resolveManagementIdentity(req({ authorization: `Bearer ${bearerA}` }), auth, now)).toEqual(failed("account_disabled", "session_required"));
  });

  it.each([true, undefined, null, "false", 0])("disabled = %p on the live record (disabled after verification) → account_disabled", async (disabled) => {
    const { auth, cookieA } = world();
    auth.getUserOverride = (uid) => ({ uid, disabled, emailVerified: true });
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("account_disabled", "session_required"));
  });

  it.each([false, undefined, null, "true", 1])("emailVerified = %p on the live record → email_not_verified → 403 identity_not_verified", async (emailVerified) => {
    const { auth, cookieA } = world();
    auth.user("uA", { emailVerified });
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("email_not_verified", "identity_not_verified"));
  });

  it("disabled AND unverified → account_disabled (no hint that the account exists)", async () => {
    const { auth, cookieA } = world();
    auth.getUserOverride = (uid) => ({ uid, disabled: true, emailVerified: false });
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("account_disabled", "session_required"));
  });

  it("expired session cookie / expired ID token → expired_session", async () => {
    const { auth } = world();
    const c = auth.token("cookie-exp", { kind: "cookie", uid: "uA", exp: NOW });
    const b = auth.token("bearer-exp", { kind: "bearer", uid: "uA", exp: NOW - 1 });
    expect(await resolveManagementIdentity(req({ cookie: c }), auth, now)).toEqual(failed("expired_session", "session_required"));
    expect(await resolveManagementIdentity(req({ authorization: `Bearer ${b}` }), auth, now)).toEqual(failed("expired_session", "session_required"));
  });

  it("revoked session (tokens revoked after login) → revoked_session; never reaches getUser", async () => {
    const { auth, cookieA, bearerA } = world();
    auth.user("uA", { tokensValidAfterSeconds: NOW - 10 });
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("revoked_session", "session_required"));
    expect(await resolveManagementIdentity(req({ authorization: `Bearer ${bearerA}` }), auth, now)).toEqual(failed("revoked_session", "session_required"));
    expect(auth.calls.filter((c) => c.startsWith("getUser"))).toEqual([]);
  });

  const BAD_AUTH_TIMES: [string, unknown][] = [
    ["missing", undefined],
    ["string", String(NOW - 60)],
    ["float", NOW - 60.5],
    ["milliseconds", (NOW - 60) * 1000],
    ["future beyond skew", NOW + AUTH_TIME_FUTURE_SKEW_SECONDS + 1],
    ["zero", 0],
    ["negative", -5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["null", null],
  ];
  it.each(BAD_AUTH_TIMES)("auth_time %s → invalid_auth_time", async (_n, auth_time) => {
    const { auth } = world();
    const t: Partial<FakeToken> & { kind: "cookie"; uid: string } = { kind: "cookie", uid: "uA", auth_time };
    const value = "cookie-bad-time";
    auth.token(value, t);
    if (auth_time === undefined) delete (auth.tokens.get(value) as Partial<FakeToken>).auth_time;
    expect(await resolveManagementIdentity(req({ cookie: value }), auth, now)).toEqual(failed("invalid_auth_time", "session_required"));
  });

  it("both credentials present: a malformed auth_time on EITHER one fails", async () => {
    const { auth, cookieA } = world();
    const b = auth.token("bearer-ms", { kind: "bearer", uid: "uA", auth_time: NOW * 1000 });
    expect(await resolveManagementIdentity(req({ cookie: cookieA, authorization: `Bearer ${b}` }), auth, now)).toEqual(failed("invalid_auth_time", "session_required"));
  });

  it("cookie/bearer uid mismatch → credential_mismatch, no account read", async () => {
    const { auth, cookieA, bearerB } = world();
    expect(await resolveManagementIdentity(req({ cookie: cookieA, authorization: `Bearer ${bearerB}` }), auth, now)).toEqual(failed("credential_mismatch", "session_required"));
    expect(auth.calls).toEqual(["cookie:true", "bearer:true"]);
  });

  it.each([
    ["valid cookie + invalid bearer", { cookie: "cookie-a", authorization: "Bearer junk" }, "invalid_bearer_token"],
    ["valid cookie + malformed Authorization", { cookie: "cookie-a", authorization: "Basic abc" }, "invalid_bearer_token"],
    ["valid cookie + empty Bearer", { cookie: "cookie-a", authorization: "Bearer " }, "invalid_bearer_token"],
    ["invalid cookie + valid bearer", { cookie: "junk", authorization: "Bearer bearer-a" }, "invalid_session_cookie"],
    ["bearer token presented as a cookie", { cookie: "bearer-a" }, "invalid_session_cookie"],
    ["cookie presented as a bearer", { authorization: "Bearer cookie-a" }, "invalid_bearer_token"],
  ])("%s → %s (no fallback to the other credential)", async (_n, o, reason) => {
    const { auth } = world();
    expect(await resolveManagementIdentity(req(o), auth, now)).toEqual(failed(reason, "session_required"));
  });

  it("Auth getUser failure → auth_unavailable → 503 api_unavailable (never a success)", async () => {
    const { auth, cookieA } = world();
    auth.getUserError = codeErr("auth/internal-error");
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("auth_unavailable", "api_unavailable"));
    auth.getUserError = new Error("ECONNRESET");
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("auth_unavailable", "api_unavailable"));
  });

  it("getUser returns nothing, or a record for another uid → auth_unavailable", async () => {
    const { auth, cookieA } = world();
    auth.getUserOverride = () => null;
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("auth_unavailable", "api_unavailable"));
    auth.getUserOverride = () => ({ uid: "uB", disabled: false, emailVerified: true });
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("auth_unavailable", "api_unavailable"));
  });

  it("deleted account (user-not-found) → account_not_found → 401", async () => {
    const { auth, cookieA } = world();
    auth.users.delete("uA");
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, now)).toEqual(failed("account_not_found", "session_required"));
  });

  it("verification throwing with no code, or a decoded token without uid → invalid, not success", async () => {
    const auth = world().auth;
    const port: ManagementAuthPort = { ...auth, verifySessionCookie: async () => { throw new TypeError("x"); }, verifyIdToken: async () => ({ uid: "" }), getUser: auth.getUser.bind(auth) };
    expect(await resolveManagementIdentity(req({ cookie: "c" }), port, now)).toEqual(failed("invalid_session_cookie", "session_required"));
    expect(await resolveManagementIdentity(req({ authorization: "Bearer t" }), port, now)).toEqual(failed("invalid_bearer_token", "session_required"));
  });

  it("a broken clock or a throwing request accessor → auth_unavailable", async () => {
    const { auth, cookieA } = world();
    expect(await resolveManagementIdentity(req({ cookie: cookieA }), auth, () => NaN)).toEqual(failed("auth_unavailable", "api_unavailable"));
    const bad = { headers: { get: () => { throw new Error("x"); } }, cookies: { get: () => undefined } };
    expect(await resolveManagementIdentity(bad, auth, now)).toEqual(failed("auth_unavailable", "api_unavailable"));
  });

  it("every failure code is an API error code with the documented status", async () => {
    expect(API_ERRORS.session_required.status).toBe(401);
    expect(API_ERRORS.api_key_not_accepted.status).toBe(401);
    expect(API_ERRORS.identity_not_verified).toMatchObject({ status: 403, type: "permission_error" });
    expect(API_ERRORS.api_unavailable.status).toBe(503);
  });
});

describe("parity with resolveRequestIdentity's strict cookie/bearer table", () => {
  type State = "absent" | "validA" | "validB" | "invalid" | "expired" | "revoked";
  const STATES: State[] = ["absent", "validA", "validB", "invalid", "expired", "revoked"];
  const errFor = (s: State, kind: "cookie" | "bearer") =>
    s === "expired" ? codeErr(kind === "cookie" ? "auth/session-cookie-expired" : "auth/id-token-expired")
      : s === "revoked" ? codeErr(kind === "cookie" ? "auth/session-cookie-revoked" : "auth/id-token-revoked")
        : codeErr("auth/argument-error");
  const uidFor = (s: State) => (s === "validA" ? "uA" : s === "validB" ? "uB" : null);

  const rows: [State, State][] = STATES.flatMap((c) => STATES.map((b) => [c, b] as [State, State]));
  it.each(rows)("cookie %s / bearer %s: same authenticate-or-fail outcome and uid", async (c, b) => {
    mockVerifySessionCookie.mockReset();
    mockVerifyIdToken.mockReset();
    mockVerifySessionCookie.mockImplementation(async () => {
      if (c === "absent") return null;
      const uid = uidFor(c);
      if (uid) return { uid, isAdmin: false };
      throw errFor(c, "cookie");
    });
    mockVerifyIdToken.mockImplementation(async () => {
      const uid = uidFor(b);
      if (uid) return { uid, auth_time: NOW - 60 };
      throw errFor(b, "bearer");
    });
    const port: ManagementAuthPort = {
      verifySessionCookie: async () => { const uid = uidFor(c); if (uid) return { uid, auth_time: NOW - 60 }; throw errFor(c, "cookie"); },
      verifyIdToken: async () => { const uid = uidFor(b); if (uid) return { uid, auth_time: NOW - 60 }; throw errFor(b, "bearer"); },
      getUser: async (uid) => ({ uid, disabled: false, emailVerified: true }),
    };
    const r = req({ ...(c === "absent" ? {} : { cookie: `c-${c}` }), ...(b === "absent" ? {} : { authorization: `Bearer b-${b}` }) });
    const legacy = await resolveRequestIdentity(r);
    const mgmt = await resolveManagementIdentity(r, port, now);
    const legacyUid = legacy.status === "authenticated" ? legacy.uid : null;
    const mgmtUid = mgmt.ok ? mgmt.identity.uid : null;
    expect([c, b, mgmtUid]).toEqual([c, b, legacyUid]);
    if (legacy.status === "authenticated" && mgmt.ok) expect(mgmt.identity.source).toBe(legacy.source);
    if (legacy.status === "unauthenticated" && !mgmt.ok) expect(mgmt.reason).toBe(legacy.reason);
  });
});

describe("resolveManagementIdentityWithFirebase (production port = adminAuth)", () => {
  afterEach(() => { mockAdmin.adminAuth = undefined; });

  it("passes checkRevoked = true to the real Admin Auth methods for both credential kinds", async () => {
    const { auth, cookieA, bearerA } = world();
    mockAdmin.adminAuth = auth;
    expect((await resolveManagementIdentityWithFirebase(req({ cookie: cookieA, authorization: `Bearer ${bearerA}` }), now)).ok).toBe(true);
    expect(auth.calls).toEqual(["cookie:true", "bearer:true", "getUser:uA"]);
  });

  it("an uninitialised Admin SDK → auth_unavailable", async () => {
    mockAdmin.adminAuth = undefined;
    expect(await resolveManagementIdentityWithFirebase(req({ cookie: "x" }), now)).toEqual(failed("auth_unavailable", "api_unavailable"));
  });
});

describe("end to end: resolveManagementIdentity → authorizeOrgManagement (the future route's composition)", () => {
  const ORG = newOrgId();
  const OTHER = newOrgId();
  type Mem = Record<string, Record<string, unknown>>;
  const mem = (uid: string, role: string, over: Record<string, unknown> = {}): Mem => ({
    [computeApiOrgMembershipId(ORG, uid)]: { orgId: ORG, uid, role, status: "active", ...over },
  });
  const deps = (m: Mem, reads: string[] = []): ManagementDeps => ({ getMembership: async (id) => (reads.push(id), m[id] ?? null), nowSeconds: now });

  async function route(r: NextRequest, auth: ManagementAuthPort, cap: OrgCapability, d: ManagementDeps) {
    const id: ManagementIdentityResult = await resolveManagementIdentity(r, auth, now);
    if (!id.ok) return id.code;
    const decision = await authorizeOrgManagement(r.headers, id.identity, ORG, cap, d);
    return decision.ok ? `ok:${decision.role}` : decision.code;
  }

  it("verified, enabled, fresh owner → allowed", async () => {
    const { auth, cookieA } = world();
    expect(await route(req({ cookie: cookieA }), auth, "keys.live.create", deps(mem("uA", "owner")))).toBe("ok:owner");
  });

  it("stale session (16 min) for a fresh-only capability → fresh_session_required; a non-fresh capability is allowed", async () => {
    const { auth } = world();
    const stale = auth.token("cookie-stale", { kind: "cookie", uid: "uA", auth_time: NOW - 16 * 60 });
    expect(await route(req({ cookie: stale }), auth, "keys.live.create", deps(mem("uA", "owner")))).toBe("fresh_session_required");
    expect(await route(req({ cookie: stale }), auth, "usage.view", deps(mem("uA", "owner")))).toBe("ok:owner");
  });

  it("disabled / unverified / expired / revoked / mismatch / API key / getUser failure never read membership", async () => {
    const reads: string[] = [];
    const cases: [string, (w: ReturnType<typeof world>) => NextRequest, string][] = [
      ["disabled", (w) => (w.auth.user("uA", { disabled: true }), req({ cookie: w.cookieA })), "session_required"],
      ["unverified", (w) => (w.auth.user("uA", { emailVerified: false }), req({ cookie: w.cookieA })), "identity_not_verified"],
      ["expired", (w) => req({ cookie: w.auth.token("c-exp", { kind: "cookie", uid: "uA", exp: NOW - 1 }) }), "session_required"],
      ["revoked", (w) => (w.auth.user("uA", { tokensValidAfterSeconds: NOW }), req({ cookie: w.cookieA })), "session_required"],
      ["mismatch", (w) => req({ cookie: w.cookieA, authorization: `Bearer ${w.bearerB}` }), "session_required"],
      ["api key", (w) => req({ cookie: w.cookieA, authorization: "Bearer cpk_live_AAAAAAAAAAAA_x" }), "api_key_not_accepted"],
      ["getUser failure", (w) => ((w.auth.getUserError = new Error("down")), req({ cookie: w.cookieA })), "api_unavailable"],
      ["missing auth_time", (w) => { const v = "c-noat"; w.auth.token(v, { kind: "cookie", uid: "uA" }); delete (w.auth.tokens.get(v) as Partial<FakeToken>).auth_time; return req({ cookie: v }); }, "session_required"],
    ];
    for (const [name, build, code] of cases) {
      const w = world();
      expect([name, await route(build(w), w.auth, "usage.view", deps(mem("uA", "owner"), reads))]).toEqual([name, code]);
    }
    expect(reads).toEqual([]);
  });

  it("removed membership, wrong-org membership, other-uid record → not_found; insufficient role → insufficient_role", async () => {
    const { auth, cookieA } = world();
    const r = () => req({ cookie: cookieA });
    expect(await route(r(), auth, "usage.view", deps(mem("uA", "owner", { status: "removed" })))).toBe("not_found");
    expect(await route(r(), auth, "usage.view", deps(mem("uA", "owner", { orgId: OTHER })))).toBe("not_found");
    expect(await route(r(), auth, "usage.view", deps(mem("uA", "owner", { uid: "uB" })))).toBe("not_found");
    expect(await route(r(), auth, "usage.view", deps({}))).toBe("not_found");
    expect(await route(r(), auth, "keys.live.create", deps(mem("uA", "developer")))).toBe("insufficient_role");
    expect(await route(r(), auth, "audit.view", deps(mem("uA", "viewer")))).toBe("insufficient_role");
  });

  it("Firestore membership read failure → api_unavailable", async () => {
    const { auth, cookieA } = world();
    const d: ManagementDeps = { getMembership: async () => { throw new Error("firestore down"); }, nowSeconds: now };
    expect(await route(req({ cookie: cookieA }), auth, "usage.view", d)).toBe("api_unavailable");
  });
});

describe("boundaries", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const FILE = "lib/auth/resolveManagementIdentity.ts";
  const src = readFileSync(path.join(ROOT, FILE), "utf8");
  const specifiers = (s: string) => [...s.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);

  it("first statement is server-only; imports only lib/firebase/admin (lazily) — never lib/apiPlatform", () => {
    expect(src.split("\n").find((l) => l.trim() !== "")).toBe('import "server-only";');
    expect(specifiers(src).sort()).toEqual(["@/lib/firebase/admin", "server-only"]);
    expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/apiPlatform/);
  });

  it("positive control + DARK: no non-test file imports the resolver yet (no management route exists)", () => {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(path.join(ROOT, rel))) {
        if (["node_modules", ".git", ".next", "coverage", "__tests__"].includes(name)) continue;
        const r = `${rel}/${name}`;
        if (statSync(path.join(ROOT, r)).isDirectory()) walk(r);
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(r);
      }
    };
    for (const d of ["app", "components", "lib", "scripts", "hooks"]) walk(d);
    expect(out).toContain(FILE);
    const importers = out.filter((f) => f !== FILE && specifiers(readFileSync(path.join(ROOT, f), "utf8")).some((s) => /resolveManagementIdentity$/.test(s)));
    expect(importers).toEqual([]);
  });
});

describe("transient verifier failure → 503, never 401 and never success", () => {
  const TRANSIENT = ["auth/internal-error", "app/internal-error", "app/network-error", "app/network-timeout"];
  const NOT_TRANSIENT = ["auth/argument-error", "auth/internal-error-x", "auth/invalid-session-cookie-duration", "network-error", "", "AUTH/INTERNAL-ERROR"];
  const throwing = (code: string): ManagementAuthPort => ({
    verifySessionCookie: async () => { throw codeErr(code); },
    verifyIdToken: async () => { throw codeErr(code); },
    getUser: async (uid) => ({ uid, disabled: false, emailVerified: true }),
  });

  it.each(TRANSIENT)("%s on cookie or bearer verification → auth_unavailable (api_unavailable)", async (code) => {
    expect(await resolveManagementIdentity(req({ cookie: "c" }), throwing(code), now)).toEqual(failed("auth_unavailable", "api_unavailable"));
    expect(await resolveManagementIdentity(req({ authorization: "Bearer t" }), throwing(code), now)).toEqual(failed("auth_unavailable", "api_unavailable"));
  });

  it.each(NOT_TRANSIENT)("%j stays a 401 invalid credential (exact codes only)", async (code) => {
    expect(await resolveManagementIdentity(req({ cookie: "c" }), throwing(code), now)).toEqual(failed("invalid_session_cookie", "session_required"));
    expect(await resolveManagementIdentity(req({ authorization: "Bearer t" }), throwing(code), now)).toEqual(failed("invalid_bearer_token", "session_required"));
  });

  it("transient failure on ONE of two credentials still fails the request (no fallback to the other)", async () => {
    const { auth, bearerA } = world();
    const port: ManagementAuthPort = { ...auth, verifySessionCookie: async () => { throw codeErr("app/network-timeout"); }, verifyIdToken: auth.verifyIdToken.bind(auth), getUser: auth.getUser.bind(auth) };
    expect(await resolveManagementIdentity(req({ cookie: "c", authorization: `Bearer ${bearerA}` }), port, now)).toEqual(failed("auth_unavailable", "api_unavailable"));
  });

  it("non-Error throwables (string, undefined, numeric code) are invalid credentials, never success", async () => {
    for (const thrown of ["boom", undefined, { code: 500 }, null]) {
      const port: ManagementAuthPort = { verifySessionCookie: async () => { throw thrown; }, verifyIdToken: async () => { throw thrown; }, getUser: async (uid) => ({ uid, disabled: false, emailVerified: true }) };
      expect(await resolveManagementIdentity(req({ cookie: "c" }), port, now)).toEqual(failed("invalid_session_cookie", "session_required"));
    }
  });
});

describe("`reason` is never serialized", () => {
  it("a failure's JSON, spread and keys carry only ok and code; reason is readable server-side", async () => {
    const { auth, cookieA } = world();
    auth.user("uA", { emailVerified: false });
    const r = await resolveManagementIdentity(req({ cookie: cookieA }), auth, now);
    expect(JSON.stringify(r)).toBe('{"ok":false,"code":"identity_not_verified"}');
    expect({ ...r }).toStrictEqual({ ok: false, code: "identity_not_verified" });
    expect(Object.keys(r)).toEqual(["ok", "code"]);
    expect(!r.ok && r.reason).toBe("email_not_verified");
    expect(() => { (r as { reason: string }).reason = "x"; }).toThrow(TypeError);
  });

  it("the API error body built from the result names no reason", async () => {
    const { apiErrorBody } = jest.requireActual("@/lib/apiPlatform/errors") as typeof import("@/lib/apiPlatform/errors");
    const { auth } = world();
    const old = auth.token("cookie-rev", { kind: "cookie", uid: "uA" });
    auth.user("uA", { tokensValidAfterSeconds: NOW });
    const r = await resolveManagementIdentity(req({ cookie: old }), auth, now);
    if (r.ok) throw new Error("expected failure");
    const body = JSON.stringify(apiErrorBody(r.code, "req_x"));
    expect(body).not.toContain("revoked");
    expect(body).not.toContain(r.reason);
  });

  it("positive control: the failed() matcher rejects a wrong reason, an enumerable reason and an extra key", () => {
    const hidden = (reason: string, extra: Record<string, unknown> = {}) => {
      const o = { ok: false, code: "session_required", ...extra };
      Object.defineProperty(o, "reason", { value: reason, enumerable: false });
      return Object.freeze(o);
    };
    const m = failed("expired_session", "session_required");
    expect(m.asymmetricMatch(hidden("expired_session"))).toBe(true);
    expect(m.asymmetricMatch(hidden("revoked_session"))).toBe(false);
    expect(m.asymmetricMatch(Object.freeze({ ok: false, code: "session_required", reason: "expired_session" }))).toBe(false);
    expect(m.asymmetricMatch(hidden("expired_session", { uid: "uA" }))).toBe(false);
    expect(m.asymmetricMatch({ ...hidden("expired_session") })).toBe(false);
  });
});

describe("revocation checking is pinned to checkRevoked === true on both credential kinds", () => {
  it("a port that only refuses revoked tokens when checkRevoked is strictly true: both paths refuse", async () => {
    const seen: unknown[] = [];
    const port: ManagementAuthPort = {
      verifySessionCookie: async (_v, checkRevoked) => { seen.push(checkRevoked); if (checkRevoked === true) throw codeErr("auth/session-cookie-revoked"); return { uid: "uA", auth_time: NOW - 60 }; },
      verifyIdToken: async (_v, checkRevoked) => { seen.push(checkRevoked); if (checkRevoked === true) throw codeErr("auth/id-token-revoked"); return { uid: "uA", auth_time: NOW - 60 }; },
      getUser: async (uid) => ({ uid, disabled: false, emailVerified: true }),
    };
    expect(await resolveManagementIdentity(req({ cookie: "c" }), port, now)).toEqual(failed("revoked_session", "session_required"));
    expect(await resolveManagementIdentity(req({ authorization: "Bearer t" }), port, now)).toEqual(failed("revoked_session", "session_required"));
    expect(seen).toEqual([true, true]);
  });
});
