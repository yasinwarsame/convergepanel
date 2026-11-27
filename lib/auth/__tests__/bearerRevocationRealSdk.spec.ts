/**
 * BEARERREV — resolveRequestIdentity through the REAL lib/firebase/auth.ts,
 * lib/firebase/auth-helpers.ts and the REAL firebase-admin 12.x BaseAuth
 * prototype. Only the network edges are stubbed: the JWT verifiers
 * (signature / expiry — they decode the synthetic token's own payload) and
 * `getUser` (the live Auth record). If the bearer path dropped checkRevoked,
 * the SDK would never call getUser for a bearer and the revoked / disabled /
 * outage cases below would authenticate.
 */

type Rec = { uid: string; disabled: boolean; tokensValidAfterTime?: string };
const mockUsers = new Map<string, Rec | Error>();
const mockGetUser = jest.fn();
const mockOutage: { cookie: string | null; bearer: string | null } = { cookie: null, bearer: null };

function decodePayload(t: string): Record<string, unknown> {
  const part = String(t).split(".")[1];
  if (!part) throw Object.assign(new Error("Decoding Firebase ID token failed."), { code: "auth/argument-error" });
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

jest.mock("@/lib/firebase/admin", () => {
  const proto = Object.getPrototypeOf(require("firebase-admin/auth").Auth.prototype);
  const auth = Object.create(proto);
  const verifier = {
    verifyJWT: async (t: string) => {
      const p = decodePayload(t);
      if (typeof p.exp === "number" && p.exp < Math.floor(Date.now() / 1000)) {
        throw Object.assign(new Error("expired"), { code: "auth/id-token-expired" });
      }
      return { ...p, uid: p.sub };
    },
  };
  auth.idTokenVerifier = verifier;
  auth.sessionCookieVerifier = verifier;
  auth.getUser = (...a: unknown[]) => mockGetUser(...a);
  // Per-credential outage injection, independent of evaluation order: the SDK passes
  // SESSION_COOKIE_REVOKED for cookies and ID_TOKEN_REVOKED for ID tokens.
  auth.verifyDecodedJWTNotRevokedOrDisabled = function (decoded: unknown, info: { code?: string }) {
    const kind = String(info?.code ?? "").includes("session-cookie") ? "cookie" : "bearer";
    const code = mockOutage[kind];
    if (code) return Promise.reject(Object.assign(new Error("upstream"), { code }));
    return proto.verifyDecodedJWTNotRevokedOrDisabled.call(this, decoded, info);
  };
  return { adminAuth: auth, adminDb: undefined, FIREBASE_PROJECT_ID: "test-proj", getInitializedFirebaseProjectId: () => "test-proj" };
});
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { adminAuth } from "@/lib/firebase/admin";

const NOW = Math.floor(Date.now() / 1000);
const AUTH_TIME = NOW - 600;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub: string, extra: Record<string, unknown> = {}): string {
  return [
    b64({ alg: "RS256", kid: "k1", typ: "JWT" }),
    b64({ sub, aud: "test-proj", iss: "https://securetoken.google.com/test-proj", iat: NOW - 60, exp: NOW + 3000, auth_time: AUTH_TIME, ...extra }),
    "sig",
  ].join(".");
}
const REVOKED_AT = new Date((AUTH_TIME + 60) * 1000).toUTCString();
const OLD = new Date((AUTH_TIME - 3600) * 1000).toUTCString();

function req(opts: { bearer?: string; cookie?: string; rawAuth?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.rawAuth !== undefined) headers.authorization = opts.rawAuth;
  else if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = `__session=${opts.cookie}`;
  return new NextRequest("http://localhost/api/x", { headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST; // emulator mode forces checkRevoked — would mask the defect
  mockUsers.clear();
  mockOutage.cookie = null;
  mockOutage.bearer = null;
  mockUsers.set("valid", { uid: "valid", disabled: false, tokensValidAfterTime: OLD });
  mockUsers.set("valid2", { uid: "valid2", disabled: false });
  mockUsers.set("revoked", { uid: "revoked", disabled: false, tokensValidAfterTime: REVOKED_AT });
  mockUsers.set("disabled", { uid: "disabled", disabled: true, tokensValidAfterTime: OLD });
  mockGetUser.mockImplementation(async (uid: string) => {
    const r = mockUsers.get(uid);
    if (r instanceof Error) throw r;
    if (!r) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    return r;
  });
});

it("ANCHOR: adminAuth is the real SDK prototype (verifyIdToken is not a stub)", () => {
  const proto = Object.getPrototypeOf(require("firebase-admin/auth").Auth.prototype);
  expect(proto.constructor.name).toBe("BaseAuth");
  expect((adminAuth as unknown as { verifyIdToken: unknown }).verifyIdToken).toBe(proto.verifyIdToken);
});

describe("bearer only", () => {
  it("valid → authenticated via bearer_token, and the live record WAS read (checkRevoked wiring)", async () => {
    await expect(resolveRequestIdentity(req({ bearer: token("valid") }))).resolves.toEqual({ status: "authenticated", uid: "valid", source: "bearer_token" });
    expect(mockGetUser).toHaveBeenCalledWith("valid");
  });
  it("revoked (auth_time < tokensValidAfterTime) → unauthenticated revoked_session", async () => {
    await expect(resolveRequestIdentity(req({ bearer: token("revoked") }))).resolves.toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });
  it("disabled → unauthenticated (invalid_bearer_token)", async () => {
    await expect(resolveRequestIdentity(req({ bearer: token("disabled") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
  it("deleted (user-not-found) → unauthenticated", async () => {
    await expect(resolveRequestIdentity(req({ bearer: token("ghost") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
  it("expired → expired_session (no live read needed)", async () => {
    await expect(resolveRequestIdentity(req({ bearer: token("valid", { exp: NOW - 10 }) }))).resolves.toEqual({ status: "unauthenticated", reason: "expired_session" });
  });
  it.each(["auth/internal-error", "app/internal-error", "app/network-error", "app/network-timeout"])(
    "live-read outage %s → unauthenticated auth_unavailable (NEVER authenticated)",
    async (code) => {
      mockUsers.set("valid", Object.assign(new Error("upstream"), { code }));
      await expect(resolveRequestIdentity(req({ bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
    }
  );
  it("an unclassified live-read failure → unauthenticated invalid_bearer_token (fail closed)", async () => {
    mockUsers.set("valid", new Error("weird, no code"));
    await expect(resolveRequestIdentity(req({ bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
});

describe("dual-credential rules are unchanged (parity matrix)", () => {
  const cases: Array<[string, { bearer?: string; cookie?: string; rawAuth?: string }, unknown]> = [
    ["no credentials", {}, { status: "unauthenticated", reason: "missing_credentials" }],
    // ZCA L-8: a cookie ALONE is the anonymous answer, whatever its state (it is not verified at all).
    ["cookie valid only → missing_credentials (ZCA L-8)", { cookie: token("valid") }, { status: "unauthenticated", reason: "missing_credentials" }],
    ["cookie revoked only → missing_credentials (ZCA L-8)", { cookie: token("revoked") }, { status: "unauthenticated", reason: "missing_credentials" }],
    ["cookie A + bearer A (both valid)", { cookie: token("valid"), bearer: token("valid") }, { status: "authenticated", uid: "valid", source: "matching_cookie_and_bearer" }],
    ["cookie A + bearer B (both valid) → mismatch", { cookie: token("valid"), bearer: token("valid2") }, { status: "unauthenticated", reason: "credential_mismatch" }],
    ["cookie valid + bearer revoked (same uid space) → bearer reason, no cookie fallback", { cookie: token("valid"), bearer: token("revoked") }, { status: "unauthenticated", reason: "revoked_session" }],
    ["cookie revoked + bearer valid → cookie reason, no bearer fallback", { cookie: token("revoked"), bearer: token("valid") }, { status: "unauthenticated", reason: "revoked_session" }],
    ["cookie valid + bearer disabled → unauthenticated", { cookie: token("valid"), bearer: token("disabled") }, { status: "unauthenticated", reason: "invalid_bearer_token" }],
    ["cookie valid + malformed Authorization header → unauthenticated", { cookie: token("valid"), rawAuth: "Basic abc" }, { status: "unauthenticated", reason: "invalid_bearer_token" }],
    ["cookie disabled + bearer disabled → cookie reason", { cookie: token("disabled"), bearer: token("disabled") }, { status: "unauthenticated", reason: "invalid_session_cookie" }],
  ];
  it.each(cases)("%s", async (_n, opts, expected) => {
    await expect(resolveRequestIdentity(req(opts))).resolves.toEqual(expected);
  });
});

describe("dual-credential rules under a verifier OUTAGE (fail closed; no fallback to the other credential)", () => {
  const OUT = "app/network-error";
  it("ANCHOR: the outage hook still delegates to the real SDK check when no outage is set", async () => {
    await expect(resolveRequestIdentity(req({ bearer: token("revoked") }))).resolves.toEqual({ status: "unauthenticated", reason: "revoked_session" });
  });
  it("cookie valid + bearer outage → unauthenticated auth_unavailable (never authenticated via the cookie)", async () => {
    mockOutage.bearer = OUT;
    await expect(resolveRequestIdentity(req({ cookie: token("valid"), bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
  });
  it("cookie outage + bearer valid → unauthenticated auth_unavailable (never authenticated via the bearer)", async () => {
    mockOutage.cookie = OUT;
    await expect(resolveRequestIdentity(req({ cookie: token("valid"), bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
  });
  it("both outage → unauthenticated auth_unavailable", async () => {
    mockOutage.cookie = OUT;
    mockOutage.bearer = OUT;
    await expect(resolveRequestIdentity(req({ cookie: token("valid"), bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
  });
  it("cookie outage alone → missing_credentials (ZCA L-8: a lone cookie is never verified); bearer outage alone → auth_unavailable", async () => {
    mockOutage.cookie = OUT;
    await expect(resolveRequestIdentity(req({ cookie: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "missing_credentials" });
    mockOutage.cookie = null;
    mockOutage.bearer = OUT;
    await expect(resolveRequestIdentity(req({ bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "auth_unavailable" });
  });
  it("cookie A valid + bearer B outage → still unauthenticated (no mismatch-bypass via outage)", async () => {
    mockOutage.bearer = OUT;
    const r = await resolveRequestIdentity(req({ cookie: token("valid"), bearer: token("valid2") }));
    expect(r.status).toBe("unauthenticated");
  });
});

describe("transient classification is EXACT-match (near-miss codes are credential failures)", () => {
  it.each([
    "auth/internal-error-extra",
    "x-app/network-error",
    "app/network-error ",
    "APP/NETWORK-ERROR",
    "auth/internal",
    "app/network-timeout/retry",
  ])("near-miss %p → invalid_bearer_token, NOT auth_unavailable", async (code) => {
    mockUsers.set("valid", Object.assign(new Error("upstream"), { code }));
    await expect(resolveRequestIdentity(req({ bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: "invalid_bearer_token" });
  });
});

describe("cookie and bearer live reads run concurrently (latency: one Auth round trip, not two)", () => {
  it("both getUser calls are issued before either resolves", async () => {
    const pending: Array<() => void> = [];
    mockGetUser.mockImplementation(
      (uid: string) => new Promise((resolve) => pending.push(() => resolve(mockUsers.get(uid))))
    );
    const p = resolveRequestIdentity(req({ cookie: token("valid"), bearer: token("valid") }));
    for (let i = 0; i < 50 && pending.length < 2; i++) await new Promise((r) => setImmediate(r));
    expect(pending.length).toBe(2); // sequential evaluation would have issued only the cookie's read here
    pending.forEach((release) => release());
    await expect(p).resolves.toEqual({ status: "authenticated", uid: "valid", source: "matching_cookie_and_bearer" });
  });
});

describe("CONTROL: the SDK default (checkRevoked=false) would accept the revoked / disabled bearer", () => {
  it.each(["revoked", "disabled"])("%s", async (uid) => {
    await expect(adminAuth!.verifyIdToken(token(uid))).resolves.toMatchObject({ uid });
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe("R4 — Auth getUser lookups per request type (availability / quota cost of checkRevoked)", () => {
  const cases: Array<[string, { bearer?: string; cookie?: string; rawAuth?: string }, number]> = [
    ["no credentials", {}, 0],
    ["bearer only", { bearer: token("valid") }, 1],
    ["cookie only (ZCA L-8: never verified, no live read)", { cookie: token("valid") }, 0],
    ["cookie + bearer, same uid", { cookie: token("valid"), bearer: token("valid") }, 2],
    ["cookie A + bearer B (mismatch)", { cookie: token("valid"), bearer: token("valid2") }, 2],
    ["cookie + EXPIRED bearer (expiry fails before the live read)", { cookie: token("valid"), bearer: token("valid", { exp: NOW - 10 }) }, 1],
    ["cookie + malformed Authorization header (never reaches the SDK)", { cookie: token("valid"), rawAuth: "Basic abc" }, 1],
    ["undecodable bearer only", { bearer: "not-a-jwt" }, 0],
  ];
  it.each(cases)("%s → %p lookup(s)", async (_n, opts, expected) => {
    await resolveRequestIdentity(req(opts));
    expect(mockGetUser).toHaveBeenCalledTimes(expected);
  });
});

describe("R4 — classification of EVERY firebase-admin Auth/App error code raised by the live read (pinned table)", () => {
  // The oracle is the SDK's own code catalogue, not our classifier's set.
  const sdkErrors = require(require("path").join(require("path").dirname(require.resolve("firebase-admin/auth")), "../utils/error.js"));
  const authCodes: string[] = Object.values(sdkErrors.AuthClientErrorCode as Record<string, { code: string }>).map((i) => `auth/${i.code}`);
  const appCodes: string[] = Object.values(sdkErrors.AppErrorCodes as Record<string, string>).map((c) => `app/${c}`);
  // Infrastructure: the verifier could not run (outage, quota, the server's own credential/permission). Pinned, exact.
  const INFRA = new Set([
    "auth/internal-error",
    "auth/quota-exceeded",
    "auth/insufficient-permission",
    "auth/invalid-credential",
    "app/internal-error",
    "app/network-error",
    "app/network-timeout",
    "app/unable-to-parse-response",
    "app/invalid-credential",
  ]);
  const expected = (code: string) =>
    INFRA.has(code) ? "auth_unavailable" : code.includes("revoked") ? "revoked_session" : code.includes("expired") ? "expired_session" : "invalid_bearer_token";

  it("ANCHOR: the catalogue is the real one (non-trivial, contains the codes this table relies on)", () => {
    expect(authCodes.length).toBeGreaterThan(80);
    for (const c of ["auth/quota-exceeded", "auth/user-disabled", "auth/id-token-revoked", "auth/argument-error"]) expect(authCodes).toContain(c);
    for (const c of ["app/network-error", "app/unable-to-parse-response", "app/invalid-credential"]) expect(appCodes).toContain(c);
    for (const c of INFRA) expect([...authCodes, ...appCodes]).toContain(c); // no pinned code is a typo
  });
  it.each([...new Set([...authCodes, ...appCodes])])("%s", async (code) => {
    mockUsers.set("valid", Object.assign(new Error("upstream"), { code }));
    await expect(resolveRequestIdentity(req({ bearer: token("valid") }))).resolves.toEqual({ status: "unauthenticated", reason: expected(code) });
  });
});
