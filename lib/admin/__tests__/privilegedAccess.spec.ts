/**
 * SEC-3 / S2-a — UNIT SUITE FOR THE PRIVILEGED-ACCESS GUARD (design §7.1).
 *
 * Every Firebase Admin call goes through a recording fake, so each test can
 * assert not only the decision but HOW it was reached: `checkRevoked === false`
 * on every verification, and exactly one `getUser(uid)` per request.
 *
 * The guard is dark at this step: the last block proves no file under `app/`
 * imports it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AuthClientErrorCode, FirebaseAuthError } from "firebase-admin/auth";
/** The SDK marks the real `(info, message)` constructor `@internal`, so the public typings hide it. */
const SdkAuthError = FirebaseAuthError as unknown as new (info: { code: string; message: string }, message?: string) => FirebaseAuthError;
import { NextRequest } from "next/server";

const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const PORTAL_EMAIL = "portal-only@test-invented.example";
const GOV_EMAIL = "governance-only@test-invented.example";
const BOTH_EMAIL = "on-both-lists@test-invented.example";
const OUTSIDER_EMAIL = "outsider@test-invented.example";

const UID = "uid-alpha";
const OTHER_UID = "uid-beta";
const AUTH_TIME = 1_700_000_000; // seconds

/**
 * CREDENTIAL FIXTURES. Since the correction round every credential is
 * structurally pre-validated BEFORE the SDK is called, so the fixtures are real
 * compact JWS strings addressed to this project; the signature segment is
 * arbitrary bytes and "verification" is the recording fake's lookup of the
 * exact string. An UNREGISTERED well-formed token is rejected by the fake the
 * way the real SDK rejects a token Google did not sign: `auth/argument-error`
 * with the SDK's fixed "has invalid signature." text (token-verifier.js:271).
 */
const PROJECT_ID = "test-project-invented";
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const ISSUER = { bearer: "https://securetoken.google.com/", cookie: "https://session.firebase.google.com/" } as const;
const SDK_DOCS = {
  bearer: " See https://firebase.google.com/docs/auth/admin/verify-id-tokens for details on how to retrieve an ID token.",
  cookie: " See https://firebase.google.com/docs/auth/admin/manage-cookies for details on how to retrieve a session cookie.",
} as const;
const JWT_NAME = { bearer: "Firebase ID token", cookie: "Firebase session cookie" } as const;
const GOOD_HEADER = { alg: "RS256", kid: "test-kid", typ: "JWT" };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
type Kind = "bearer" | "cookie";
function claims(kind: Kind, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: PROJECT_ID, iss: ISSUER[kind] + PROJECT_ID, sub: UID, iat: NOW_SECONDS - 60, exp: NOW_SECONDS + 3600, auth_time: AUTH_TIME, ...over };
}
function mint(kind: Kind, over: Record<string, unknown> = {}, header: unknown = GOOD_HEADER, signature = "c2lnbmF0dXJl"): string {
  return `${b64(header)}.${b64(claims(kind, over))}.${signature}`;
}
const TOK_A = mint("bearer");
const TOK_X = mint("bearer", {}, GOOD_HEADER, "eHNpZw"); // distinct bytes; registered per test to throw
const COOKIE_A = mint("cookie");
const COOKIE_B = mint("cookie", { sub: OTHER_UID });
const COOKIE_X = mint("cookie", {}, GOOD_HEADER, "eHNpZw");

type Decoded = Record<string, unknown>;
type Rec = Record<string, unknown>;

const mockState: {
  auth: unknown;
  projectId: unknown;
  tokens: Record<string, Decoded | Error>;
  cookies: Record<string, Decoded | Error>;
  /** Successive getUser results; the last one repeats. */
  records: Array<Rec | Error | null>;
} = { auth: null, projectId: PROJECT_ID, tokens: {}, cookies: {}, records: [] };

function sdkInvalidSignature(kind: Kind): Error {
  return new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, `${JWT_NAME[kind]} has invalid signature.${SDK_DOCS[kind]}`);
}
const verifyIdToken = jest.fn(async (token: string, _checkRevoked?: boolean) => {
  const v = mockState.tokens[token];
  if (v === undefined) throw sdkInvalidSignature("bearer");
  if (v instanceof Error) throw v;
  return v;
});
const verifySessionCookie = jest.fn(async (cookie: string, _checkRevoked?: boolean) => {
  const v = mockState.cookies[cookie];
  if (v === undefined) throw sdkInvalidSignature("cookie");
  if (v instanceof Error) throw v;
  return v;
});
let getUserCall = 0;
const getUser = jest.fn(async (_uid: string) => {
  const list = mockState.records;
  const v = list[Math.min(getUserCall, list.length - 1)];
  getUserCall += 1;
  if (v instanceof Error) throw v;
  return v;
});
const FAKE_AUTH = {
  verifyIdToken: (t: string, c?: boolean) => verifyIdToken(t, c),
  verifySessionCookie: (t: string, c?: boolean) => verifySessionCookie(t, c),
  getUser: (u: string) => getUser(u),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminAuth() {
    return mockState.auth;
  },
  getInitializedFirebaseProjectId: () => mockState.projectId,
}));

const logged: Array<{ level: string; message: string; data: unknown }> = [];
jest.mock("@/lib/logger", () => ({
  logger: {
    info: (message: string, data?: unknown) => logged.push({ level: "info", message, data }),
    warn: (message: string, data?: unknown) => logged.push({ level: "warn", message, data }),
    error: (message: string, data?: unknown) => logged.push({ level: "error", message, data }),
    debug: () => undefined,
  },
}));

import {
  privilegedDenialResponse,
  requirePrivilegedAccess,
  type PrivilegedDecision,
  type PrivilegedDenial,
  type PrivilegedTier,
} from "@/lib/admin/privilegedAccess";
import {
  deriveVerifiedAdminScopes,
  readLiveAuthSnapshot,
  resolveVerifiedAdminScopes,
  type LiveAuthSnapshot,
} from "@/lib/admin/verifiedAdminIdentity";

const TIERS: PrivilegedTier[] = ["SYSTEM_ADMIN", "ADMIN_PORTAL", "GOVERNANCE_ADMIN"];

function token(over: Decoded = {}): Decoded {
  return { uid: UID, sub: UID, auth_time: AUTH_TIME, ...over };
}
function record(over: Rec = {}): Rec {
  return {
    uid: UID,
    email: OUTSIDER_EMAIL,
    emailVerified: true,
    disabled: false,
    customClaims: { admin: true },
    tokensValidAfterTime: undefined,
    ...over,
  };
}

function req(opts: { authorization?: string; cookie?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  if (opts.cookie !== undefined) headers.cookie = `__session=${opts.cookie}`;
  return new NextRequest("http://localhost/api/admin/example", { headers });
}
const bearer = (t = TOK_A) => req({ authorization: `Bearer ${t}` });

async function check(r: NextRequest, tier: PrivilegedTier): Promise<PrivilegedDecision> {
  return requirePrivilegedAccess(r, tier, { route: "/api/admin/example" });
}
function denial(d: PrivilegedDecision): PrivilegedDenial {
  if (d.ok) throw new Error(`expected a denial, got a grant for ${d.actor.uid}`);
  return d;
}
function expectDenied(d: PrivilegedDecision, status: number, reason: string): void {
  expect(d.ok).toBe(false);
  const x = denial(d);
  expect([x.status, x.reason]).toEqual([status, reason]);
}
function expectGranted(d: PrivilegedDecision): asserts d is Extract<PrivilegedDecision, { ok: true }> {
  if (!d.ok) throw new Error(`expected a grant, got ${d.status} ${d.reason}`);
}
const events = (message: string) => logged.filter((l) => l.message === message);

beforeEach(() => {
  process.env.ADMIN_EMAILS = `${PORTAL_EMAIL},${BOTH_EMAIL}`;
  process.env.GOVERNANCE_ADMIN_EMAILS = `${GOV_EMAIL},${BOTH_EMAIL}`;
  mockState.auth = FAKE_AUTH;
  mockState.projectId = PROJECT_ID;
  mockState.tokens = { [TOK_A]: token() };
  mockState.cookies = { [COOKIE_A]: token() };
  mockState.records = [record()];
  getUserCall = 0;
  verifyIdToken.mockClear();
  verifySessionCookie.mockClear();
  getUser.mockClear();
  logged.length = 0;
});

describe("call contract", () => {
  it("verifies the bearer with checkRevoked=false and reads the live record exactly once, for the token's uid", async () => {
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
    expect(verifyIdToken.mock.calls).toEqual([[TOK_A, false]]);
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(getUser.mock.calls).toEqual([[UID]]);
  });

  it("verifies a cookie with checkRevoked=false (PORTAL accepts a cookie)", async () => {
    const d = await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL");
    expectGranted(d);
    expect(d.actor.credential).toBe("cookie");
    expect(verifySessionCookie.mock.calls).toEqual([[COOKIE_A, false]]);
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(getUser.mock.calls).toEqual([[UID]]);
  });

  it("when both credentials are present, verifies BOTH and still reads the record once", async () => {
    const d = await check(req({ authorization: `Bearer ${TOK_A}`, cookie: COOKIE_A }), "ADMIN_PORTAL");
    expectGranted(d);
    expect(d.actor.credential).toBe("bearer");
    expect(verifyIdToken.mock.calls).toEqual([[TOK_A, false]]);
    expect(verifySessionCookie.mock.calls).toEqual([[COOKIE_A, false]]);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("the granted actor carries the snapshot-derived fields", async () => {
    mockState.records = [record({ email: BOTH_EMAIL, tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() })];
    const d = await check(bearer(), "SYSTEM_ADMIN");
    expectGranted(d);
    expect(d.actor).toEqual({
      uid: UID,
      tier: "SYSTEM_ADMIN",
      heldTiers: { systemAdmin: true, adminPortal: true, governanceAdmin: true },
      email: BOTH_EMAIL,
      emailVerified: true,
      credential: "bearer",
      authTime: AUTH_TIME,
      snapshotTokensValidAfter: new Date(AUTH_TIME * 1000).toUTCString(),
      tokenClaimAdmin: false,
    });
    expect(Object.isFrozen(d.actor)).toBe(true);
  });
});

describe("live claim beats the token claim (SP-1)", () => {
  it("live admin:true, token admin:false — SYSTEM is granted without a token refresh, mismatch logged", async () => {
    mockState.tokens[TOK_A] = token({ admin: false });
    const d = await check(bearer(), "SYSTEM_ADMIN");
    expectGranted(d);
    expect(d.actor.tokenClaimAdmin).toBe(false);
    expect(d.actor.heldTiers.systemAdmin).toBe(true);
    expect(events("privileged_claim_mismatch").map((e) => e.data)).toEqual([
      { uid: UID, route: "/api/admin/example", presentedClaimAdmin: false, liveAdmin: true },
    ]);
  });

  it("live claim absent, token admin:true — SYSTEM 403, mismatch logged", async () => {
    mockState.tokens[TOK_A] = token({ admin: true });
    mockState.records = [record({ customClaims: {} })];
    const d = await check(bearer(), "SYSTEM_ADMIN");
    expect(denial(d)).toEqual({ ok: false, status: 403, reason: "tier_not_held", tier: "SYSTEM_ADMIN" });
    expect(events("privileged_claim_mismatch").map((e) => e.data)).toEqual([
      { uid: UID, route: "/api/admin/example", presentedClaimAdmin: true, liveAdmin: false },
    ]);
  });

  it("live claim absent, token admin:true — PORTAL also 403 for an off-list address (the claim branch is live)", async () => {
    mockState.tokens[TOK_A] = token({ admin: true });
    mockState.records = [record({ customClaims: undefined })];
    expectDenied(await check(bearer(), "ADMIN_PORTAL"), 403, "tier_not_held");
  });

  it("matching claims log no mismatch", async () => {
    mockState.tokens[TOK_A] = token({ admin: true });
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
    expect(events("privileged_claim_mismatch")).toEqual([]);
  });

  it.each([["true"], [1], [{}], [null], ["1"], [[]], [false]])("live admin value %p denies SYSTEM and PORTAL even with token admin:true", async (v) => {
    mockState.tokens[TOK_A] = token({ admin: true });
    mockState.records = [record({ customClaims: { admin: v } })];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 403, "tier_not_held");
    expectDenied(await check(bearer(), "ADMIN_PORTAL"), 403, "tier_not_held");
  });

  it("the live claim never confers GOVERNANCE_ADMIN", async () => {
    expectDenied(await check(bearer(), "GOVERNANCE_ADMIN"), 403, "tier_not_held");
  });
});

describe("disabled predicate is `=== false` (undefined denies)", () => {
  const qualifying: Record<PrivilegedTier, Rec> = {
    SYSTEM_ADMIN: { customClaims: { admin: true } },
    ADMIN_PORTAL: { customClaims: {}, email: PORTAL_EMAIL },
    GOVERNANCE_ADMIN: { customClaims: {}, email: GOV_EMAIL },
  };
  it.each(TIERS)("control: %s is granted with disabled === false", async (tier) => {
    mockState.records = [record({ ...qualifying[tier], disabled: false })];
    expectGranted(await check(bearer(), tier));
  });
  it.each(
    TIERS.flatMap((tier) => [true, undefined, "false", null, 0].map((v) => [tier, v] as const))
  )("%s with disabled %p is 401 account_disabled", async (tier, v) => {
    const r = record({ ...qualifying[tier] });
    if (v === undefined) delete r.disabled;
    else r.disabled = v;
    mockState.records = [r];
    expectDenied(await check(bearer(), tier), 401, "account_disabled");
  });
});

describe("revocation against the live tokensValidAfterTime", () => {
  const at = (ms: number) => new Date(ms).toUTCString();
  const iso = (ms: number) => new Date(ms).toISOString();

  it("auth_time*1000 < validSince denies (bearer)", async () => {
    mockState.records = [record({ tokensValidAfterTime: iso(AUTH_TIME * 1000 + 1) })];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "credential_revoked");
  });
  it("one second later (UTC string form) denies", async () => {
    mockState.records = [record({ tokensValidAfterTime: at((AUTH_TIME + 1) * 1000) })];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "credential_revoked");
  });
  it("equal allows (the SDK's strict `<`)", async () => {
    mockState.records = [record({ tokensValidAfterTime: at(AUTH_TIME * 1000) })];
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
  });
  it("earlier allows", async () => {
    mockState.records = [record({ tokensValidAfterTime: at((AUTH_TIME - 1) * 1000) })];
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
  });
  it.each([["absent", undefined], ["null", null]])("%s allows", async (_n, v) => {
    const r = record();
    if (v === undefined) delete r.tokensValidAfterTime;
    else r.tokensValidAfterTime = v;
    mockState.records = [r];
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
  });
  it.each([["unparseable", "not a date"], ["empty string", ""], ["a number", AUTH_TIME * 1000], ["an object", {}]])(
    "%s denies",
    async (_n, v) => {
      mockState.records = [record({ tokensValidAfterTime: v })];
      expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "credential_revoked");
    }
  );
  it("applies to a cookie credential on PORTAL", async () => {
    mockState.records = [record({ tokensValidAfterTime: at((AUTH_TIME + 60) * 1000) })];
    expectDenied(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "credential_revoked");
  });
  it("applies to EVERY presented credential: a fresh bearer does not launder a revoked same-uid cookie", async () => {
    mockState.tokens[TOK_A] = token({ auth_time: AUTH_TIME + 120 });
    mockState.cookies[COOKIE_A] = token({ auth_time: AUTH_TIME });
    mockState.records = [record({ tokensValidAfterTime: at((AUTH_TIME + 60) * 1000) })];
    expectDenied(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "credential_revoked");
    // control: the bearer alone is fresh
    expectGranted(await check(bearer(), "ADMIN_PORTAL"));
  });
  it.each([
    ["missing", undefined],
    ["NaN", NaN],
    ["negative", -5],
    ["zero", 0],
    ["fractional", AUTH_TIME + 0.5],
    ["Infinity", Infinity],
    ["a numeric string", String(AUTH_TIME)],
  ])("auth_time %s is 401 invalid_credential", async (_n, v) => {
    const t = token();
    if (v === undefined) delete t.auth_time;
    else t.auth_time = v;
    mockState.tokens[TOK_A] = t;
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "invalid_credential");
  });
  it("NaN auth_time is not saved by a far-future validSince being absent", async () => {
    mockState.tokens[TOK_A] = token({ auth_time: NaN });
    const r = record();
    delete r.tokensValidAfterTime;
    mockState.records = [r];
    expectDenied(await check(bearer(), "ADMIN_PORTAL"), 401, "invalid_credential");
  });
});

describe("email tiers come from the live verified record only", () => {
  it("verified ADMIN_EMAILS: PORTAL yes, SYSTEM no, GOV no", async () => {
    mockState.records = [record({ customClaims: {}, email: PORTAL_EMAIL })];
    const d = await check(bearer(), "ADMIN_PORTAL");
    expectGranted(d);
    expect(d.actor.heldTiers).toEqual({ systemAdmin: false, adminPortal: true, governanceAdmin: false });
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 403, "tier_not_held");
    expectDenied(await check(bearer(), "GOVERNANCE_ADMIN"), 403, "tier_not_held");
  });
  it("verified GOVERNANCE_ADMIN_EMAILS: GOV yes, PORTAL no, SYSTEM no", async () => {
    mockState.records = [record({ customClaims: {}, email: GOV_EMAIL })];
    const d = await check(bearer(), "GOVERNANCE_ADMIN");
    expectGranted(d);
    expect(d.actor.heldTiers).toEqual({ systemAdmin: false, adminPortal: false, governanceAdmin: true });
    expectDenied(await check(bearer(), "ADMIN_PORTAL"), 403, "tier_not_held");
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 403, "tier_not_held");
  });
  it("an address on both lists holds PORTAL and GOV but not SYSTEM", async () => {
    mockState.records = [record({ customClaims: {}, email: BOTH_EMAIL })];
    expectGranted(await check(bearer(), "ADMIN_PORTAL"));
    expectGranted(await check(bearer(), "GOVERNANCE_ADMIN"));
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 403, "tier_not_held");
  });
  it.each([[false], [undefined], ["true"], [1]])("emailVerified %p grants no email tier", async (v) => {
    mockState.records = [record({ customClaims: {}, email: BOTH_EMAIL, emailVerified: v })];
    for (const tier of TIERS) expectDenied(await check(bearer(), tier), 403, "tier_not_held");
  });
  it("the token's email never substitutes for the record's", async () => {
    mockState.tokens[TOK_A] = token({ email: BOTH_EMAIL, email_verified: true });
    mockState.records = [record({ customClaims: {}, email: OUTSIDER_EMAIL })];
    for (const tier of TIERS) expectDenied(await check(bearer(), tier), 403, "tier_not_held");
  });
  it("case and outer whitespace are normalised per lib/admin/config.ts", async () => {
    mockState.records = [record({ customClaims: {}, email: `  ${PORTAL_EMAIL.toUpperCase()} ` })];
    expectGranted(await check(bearer(), "ADMIN_PORTAL"));
    mockState.records = [record({ customClaims: {}, email: ` ${GOV_EMAIL.replace("g", "G")}` })];
    expectGranted(await check(bearer(), "GOVERNANCE_ADMIN"));
  });
});

describe("credentials: one principal, no fallback (SP-4, SP-5, D5)", () => {
  it("no credentials is 401 missing_credentials, with no Auth calls", async () => {
    for (const tier of TIERS) expectDenied(await check(req(), tier), 401, "missing_credentials");
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });
  it("cookie-only to SYSTEM is 401 cookie_not_accepted_for_tier, before any verification", async () => {
    expectDenied(await check(req({ cookie: COOKIE_A }), "SYSTEM_ADMIN"), 401, "cookie_not_accepted_for_tier");
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    // control: the same cookie reaches PORTAL
    expectGranted(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"));
  });
  it.each(TIERS)("mixed uids (bearer A, cookie B) is 401 credential_mismatch on %s, with no record read", async (tier) => {
    mockState.cookies[COOKIE_B] = token({ uid: OTHER_UID, sub: OTHER_UID });
    mockState.records = [record({ email: BOTH_EMAIL })];
    expectDenied(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: COOKIE_B }), tier), 401, "credential_mismatch");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("same uid on both credentials is granted (control for the mismatch case)", async () => {
    expectGranted(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: COOKIE_A }), "SYSTEM_ADMIN"));
  });
  it.each([["Bearer "], ["Bearer"], ["Bearer    "], ["Basic dXNlcjpwYXNz"], [TOK_A], [`Token ${TOK_A}`]])(
    "Authorization %p with a valid cookie is 401 invalid_credential — no cookie fallback",
    async (h) => {
      expectDenied(await check(req({ authorization: h, cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "invalid_credential");
      expect(getUser).not.toHaveBeenCalled();
    }
  );
  it("an expired bearer with a valid cookie is 401 — no cookie fallback", async () => {
    mockState.tokens[TOK_X] = Object.assign(new Error("expired"), { code: "auth/id-token-expired" });
    expectDenied(await check(req({ authorization: `Bearer ${TOK_X}`, cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "invalid_credential");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("a valid bearer with an invalid cookie is 401 — no bearer fallback", async () => {
    mockState.cookies[COOKIE_X] = Object.assign(new Error("revoked"), { code: "auth/session-cookie-revoked" });
    expectDenied(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: COOKIE_X }), "SYSTEM_ADMIN"), 401, "invalid_credential");
  });
  it("the Bearer prefix is case-insensitive", async () => {
    expectGranted(await check(req({ authorization: `bearer ${TOK_A}` }), "SYSTEM_ADMIN"));
    expectGranted(await check(req({ authorization: `BEARER   ${TOK_A}` }), "SYSTEM_ADMIN"));
  });
  it("the SDK accepting the bytes but reporting no subject is a 503 anomaly (the bytes carry one), with no record read", async () => {
    mockState.tokens[TOK_A] = { auth_time: AUTH_TIME };
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
    expect(getUser).not.toHaveBeenCalled();
    expect(events("privileged_auth_unavailable").map((e) => (e.data as { errorCode: string }).errorCode)).toEqual(["decoded_subject_mismatch"]);
  });
  it("the SDK reporting a DIFFERENT subject than the bytes carry is a 503 anomaly, and the other uid is never looked up", async () => {
    mockState.tokens[TOK_A] = token({ uid: OTHER_UID, sub: OTHER_UID });
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe("failures are 503 and never ok (SP-2)", () => {
  const networkError = () => Object.assign(new Error("socket hang up"), { code: "app/network-error" });

  it.each(TIERS)("getUser network error is 503 auth_unavailable on %s", async (tier) => {
    mockState.records = [networkError()];
    expectDenied(await check(bearer(), tier), 503, "auth_unavailable");
  });
  it("getUser error without a code is 503", async () => {
    mockState.records = [new Error("boom")];
    expectDenied(await check(bearer(), "ADMIN_PORTAL"), 503, "auth_unavailable");
  });
  it("getUser auth/internal-error is 503", async () => {
    mockState.records = [Object.assign(new Error("internal"), { code: "auth/internal-error" })];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
  });
  it("getUser user-not-found is 401 account_not_found", async () => {
    mockState.records = [Object.assign(new Error("no user"), { code: "auth/user-not-found" })];
    for (const tier of TIERS) expectDenied(await check(bearer(), tier), 401, "account_not_found");
  });
  it("getUser returning nothing is 503", async () => {
    mockState.records = [null];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
  });
  it("a record for a different uid is 503 (integrity anomaly)", async () => {
    mockState.records = [record({ uid: OTHER_UID })];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
  });
  it.each([
    ["network code", () => networkError()],
    ["no code", () => new Error("ECONNRESET")],
    ["internal-error", () => Object.assign(new Error("x"), { code: "auth/internal-error" })],
    ["public-key fetch failure", () => Object.assign(new Error("Error fetching public keys for Google certs: timeout"), { code: "auth/argument-error" })],
  ])("verifyIdToken non-auth error (%s) is 503 on every tier, with no record read", async (_n, mk) => {
    mockState.tokens[TOK_A] = mk();
    for (const tier of TIERS) expectDenied(await check(bearer(), tier), 503, "auth_unavailable");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("verifySessionCookie non-auth error is 503", async () => {
    mockState.cookies[COOKIE_A] = networkError();
    expectDenied(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"), 503, "auth_unavailable");
  });
  it("an availability failure on either slot outranks a credential failure on the other", async () => {
    mockState.tokens[TOK_X] = Object.assign(new Error("expired"), { code: "auth/id-token-expired" });
    mockState.cookies[COOKIE_A] = networkError();
    expectDenied(await check(req({ authorization: `Bearer ${TOK_X}`, cookie: COOKIE_A }), "ADMIN_PORTAL"), 503, "auth_unavailable");
  });
  it.each([
    ["auth/id-token-expired"],
    ["auth/id-token-revoked"],
    ["auth/invalid-id-token"],
  ])("verifyIdToken credential error %s is 401 invalid_credential whatever its message", async (code) => {
    mockState.tokens[TOK_A] = Object.assign(new Error("bad"), { code });
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "invalid_credential");
  });
  it("auth/argument-error with text that is NOT one of the SDK's two fixed credential messages is the key-fetch class: 503 (A-2)", async () => {
    mockState.tokens[TOK_A] = Object.assign(new Error("bad"), { code: "auth/argument-error" });
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
    expect(getUser).not.toHaveBeenCalled();
  });
  it.each(TIERS)("adminAuth null is 503 admin_sdk_uninitialized on %s", async (tier) => {
    mockState.auth = null;
    expectDenied(await check(bearer(), tier), 503, "admin_sdk_uninitialized");
  });
  it("an unexpected throw inside the guard is 503, not ok, and the guard does not throw", async () => {
    const r = bearer();
    Object.defineProperty(r, "cookies", { get: () => { throw new Error("unexpected"); } });
    expectDenied(await check(r, "ADMIN_PORTAL"), 503, "auth_unavailable");
  });
  it("no error path returns ok, even for a principal whose token claims admin", async () => {
    const scenarios: Array<() => void> = [
      () => { mockState.records = [networkError()]; },
      () => { mockState.records = [new Error("x")]; },
      () => { mockState.records = [null]; },
      () => { mockState.tokens[TOK_A] = networkError(); },
      () => { mockState.auth = null; },
    ];
    for (const set of scenarios) {
      mockState.auth = FAKE_AUTH;
      mockState.tokens = { [TOK_A]: token({ admin: true }) };
      mockState.records = [record({ email: BOTH_EMAIL })];
      set();
      for (const tier of TIERS) {
        const d = await check(bearer(), tier);
        expect(d.ok).toBe(false);
        expect(denial(d).status).toBe(503);
      }
    }
  });
  it("every 503 emits privileged_auth_unavailable with the error code", async () => {
    mockState.records = [networkError()];
    await check(bearer(), "SYSTEM_ADMIN");
    expect(events("privileged_auth_unavailable").map((e) => [e.level, e.data])).toEqual([
      ["error", { route: "/api/admin/example", tier: "SYSTEM_ADMIN", reason: "auth_unavailable", errorCode: "app/network-error" }],
    ]);
    expect(events("privileged_access_granted")).toEqual([]);
  });
});

describe("one snapshot per request", () => {
  it("a fake returning different successive records: only the first is used (claim, email, disabled)", async () => {
    mockState.records = [
      record({ customClaims: { admin: true }, email: BOTH_EMAIL, disabled: false }),
      record({ customClaims: {}, email: OUTSIDER_EMAIL, disabled: true, emailVerified: false }),
    ];
    const d = await check(bearer(), "SYSTEM_ADMIN");
    expectGranted(d);
    expect(d.actor.email).toBe(BOTH_EMAIL);
    expect(d.actor.heldTiers).toEqual({ systemAdmin: true, adminPortal: true, governanceAdmin: true });
    expect(getUser).toHaveBeenCalledTimes(1);
  });
  it("reverse order: a denying first record is not rescued by a granting second one", async () => {
    mockState.records = [
      record({ customClaims: {}, email: OUTSIDER_EMAIL }),
      record({ customClaims: { admin: true }, email: BOTH_EMAIL }),
    ];
    for (const tier of TIERS) {
      getUserCall = 0;
      expectDenied(await check(bearer(), tier), 403, "tier_not_held");
    }
    mockState.records = [
      record({ disabled: true }),
      record({ disabled: false }),
    ];
    getUserCall = 0;
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "account_disabled");
  });
  it("no cross-request cache: a demotion between two requests takes effect on the next request (SP-3)", async () => {
    mockState.records = [record(), record({ customClaims: {} })];
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 403, "tier_not_held");
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("no cross-request cache: a grant between two requests takes effect on the next request", async () => {
    mockState.records = [record({ customClaims: {} }), record()];
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 403, "tier_not_held");
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
    expect(getUser).toHaveBeenCalledTimes(2);
  });
  it("no cross-request cache: a disable between two PORTAL requests takes effect", async () => {
    mockState.records = [record({ customClaims: {}, email: PORTAL_EMAIL }), record({ customClaims: {}, email: PORTAL_EMAIL, disabled: true })];
    expectGranted(await check(bearer(), "ADMIN_PORTAL"));
    expectDenied(await check(bearer(), "ADMIN_PORTAL"), 401, "account_disabled");
  });
});

describe("logging is structured and carries no credential", () => {
  it("a grant emits privileged_access_granted with route, tier, uid and credential kind", async () => {
    mockState.tokens[TOK_A] = token({ admin: true });
    await check(bearer(), "SYSTEM_ADMIN");
    expect(events("privileged_access_granted").map((e) => [e.level, e.data])).toEqual([
      ["info", { route: "/api/admin/example", tier: "SYSTEM_ADMIN", uid: UID, credential: "bearer" }],
    ]);
    expect(JSON.stringify(logged)).not.toContain(TOK_A);
  });
  it("a denial emits privileged_access_denied with the reason", async () => {
    mockState.records = [record({ customClaims: {} })];
    await check(bearer(), "SYSTEM_ADMIN");
    expect(events("privileged_access_denied").map((e) => [e.level, e.data])).toEqual([
      ["warn", { route: "/api/admin/example", tier: "SYSTEM_ADMIN", status: 403, reason: "tier_not_held" }],
    ]);
  });
});

describe("privilegedDenialResponse", () => {
  it.each([
    [{ ok: false, status: 401, reason: "account_disabled" } as PrivilegedDenial, "Unauthorized"],
    [{ ok: false, status: 403, reason: "tier_not_held", tier: "SYSTEM_ADMIN" } as PrivilegedDenial, "Forbidden"],
    [{ ok: false, status: 503, reason: "auth_unavailable" } as PrivilegedDenial, "Authorization is temporarily unavailable"],
  ])("renders %p uniformly and uncached", async (d, msg) => {
    const res = privilegedDenialResponse(d);
    expect(res.status).toBe(d.status);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe(d.status === 503 ? "5" : null);
    expect(await res.json()).toEqual({ error: msg, reason: d.reason });
  });
  it("refuses to render a grant", () => {
    expect(() => privilegedDenialResponse({ ok: true } as unknown as PrivilegedDenial)).toThrow();
  });
  it("renders a real guard decision", async () => {
    mockState.records = [record({ disabled: true })];
    const res = privilegedDenialResponse(denial(await check(bearer(), "SYSTEM_ADMIN")));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized", reason: "account_disabled" });
  });
});

describe("snapshot form of verifiedAdminIdentity", () => {
  it("readLiveAuthSnapshot performs exactly one getUser and returns a frozen snapshot", async () => {
    const r = await readLiveAuthSnapshot(UID);
    expect(getUser.mock.calls).toEqual([[UID]]);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(Object.isFrozen(r.snapshot)).toBe(true);
  });
  it("deriveVerifiedAdminScopes refuses a snapshot this module did not build", async () => {
    const forged = {
      requestedUid: UID,
      recordUid: UID,
      email: BOTH_EMAIL,
      emailVerified: true,
      disabled: false,
      claimAdmin: true,
      tokensValidAfterTime: undefined,
    } as LiveAuthSnapshot;
    const s = deriveVerifiedAdminScopes(forged);
    expect([s.lookupStatus, s.adminPortal, s.governanceAdmin, s.disabled]).toEqual(["lookup_failed", false, false, true]);
    // control: a built snapshot with the same content is honoured
    mockState.records = [record({ email: BOTH_EMAIL })];
    const built = await readLiveAuthSnapshot(UID);
    if (built.status !== "resolved") throw new Error("expected resolved");
    const t = deriveVerifiedAdminScopes(built.snapshot);
    expect([t.lookupStatus, t.adminPortal, t.governanceAdmin]).toEqual(["resolved", true, true]);
    // a spread copy loses the brand
    expect(deriveVerifiedAdminScopes({ ...built.snapshot }).lookupStatus).toBe("lookup_failed");
  });
  it("resolveVerifiedAdminScopes keeps its legacy semantics (user/usage contract): absent `disabled` counts as enabled there", async () => {
    const r = record({ email: PORTAL_EMAIL });
    delete r.disabled;
    mockState.records = [r];
    expect(await resolveVerifiedAdminScopes(UID)).toEqual({
      lookupStatus: "resolved",
      adminPortal: true,
      governanceAdmin: false,
      email: PORTAL_EMAIL,
      emailVerified: true,
      disabled: false,
    });
  });
  it("resolveVerifiedAdminScopes maps user-not-found and outages to lookup_failed", async () => {
    for (const e of [Object.assign(new Error("x"), { code: "auth/user-not-found" }), new Error("down")]) {
      mockState.records = [e];
      getUserCall = 0;
      expect(await resolveVerifiedAdminScopes(UID)).toEqual({
        lookupStatus: "lookup_failed",
        adminPortal: false,
        governanceAdmin: false,
        email: "",
        emailVerified: false,
        disabled: true,
      });
    }
    mockState.auth = null;
    expect((await resolveVerifiedAdminScopes(UID)).lookupStatus).toBe("lookup_failed");
    mockState.auth = FAKE_AUTH;
    getUser.mockClear();
    expect((await resolveVerifiedAdminScopes("")).lookupStatus).toBe("lookup_failed");
    expect(getUser).not.toHaveBeenCalled();
  });
});

/**
 * CORRECTION ROUND — the 401/503 boundary is decided by STRUCTURE, never by
 * reading caller-controlled text. See lib/admin/privilegedCredentialAdapter.ts
 * for the SDK line citations; lib/admin/__tests__/privilegedCredentialAdapter.spec.ts
 * pins the SDK constants and proves the pre-validation superset against the
 * installed SDK.
 */
describe("structural pre-validation: a crafted credential never reaches the SDK", () => {
  const CRAFTED_BEARERS: Array<[string, () => string]> = [
    ["aud carrying the SDK's key-fetch text", () => mint("bearer", { aud: "Error fetching public keys for Google certs: boom" })],
    ["iss carrying key-fetch-error", () => mint("bearer", { iss: "key-fetch-error Error fetching public keys for Google certs" })],
    ["aud as an array containing the project id", () => mint("bearer", { aud: [PROJECT_ID] })],
    ["very long aud (75 KiB of the key-fetch text)", () => mint("bearer", { aud: "Error fetching ".repeat(5000) })],
    ["unicode and bidi-override in aud", () => mint("bearer", { aud: "Error fetching public keys ✓ ‮" })],
    ["aud with regex metacharacters", () => mint("bearer", { aud: "(.*)+$^[Error fetching]\\" })],
    ["aud equal to the project id in a different case", () => mint("bearer", { aud: PROJECT_ID.toUpperCase() })],
    ["another project's aud and iss", () => mint("bearer", { aud: "other-project", iss: ISSUER.bearer + "other-project" })],
    ["the session-cookie issuer on a bearer", () => mint("bearer", { iss: ISSUER.cookie + PROJECT_ID })],
    ["iss with a trailing slash", () => mint("bearer", { iss: `${ISSUER.bearer}${PROJECT_ID}/` })],
    ["sub empty", () => mint("bearer", { sub: "" })],
    ["sub of 129 characters", () => mint("bearer", { sub: "x".repeat(129) })],
    ["sub missing", () => mint("bearer", { sub: undefined })],
    ["sub non-string", () => mint("bearer", { sub: 42 })],
    ["alg none", () => mint("bearer", {}, { alg: "none", kid: "test-kid" })],
    ["alg HS256", () => mint("bearer", {}, { alg: "HS256", kid: "test-kid" })],
    ["alg rs256 (lowercase)", () => mint("bearer", {}, { alg: "rs256", kid: "test-kid" })],
    ["alg missing", () => mint("bearer", {}, { kid: "test-kid" })],
    ["kid missing", () => mint("bearer", {}, { alg: "RS256" })],
    ["kid empty", () => mint("bearer", {}, { alg: "RS256", kid: "" })],
    ["kid non-string", () => mint("bearer", {}, { alg: "RS256", kid: 7 })],
    ["exp in the past", () => mint("bearer", { exp: NOW_SECONDS - 1 })],
    ["exp equal to now at load time (the SDK's `>=` rule)", () => mint("bearer", { exp: NOW_SECONDS })],
    ["exp as a numeric string", () => mint("bearer", { exp: String(NOW_SECONDS + 3600) })],
    ["exp missing", () => mint("bearer", { exp: undefined })],
    ["iat missing", () => mint("bearer", { iat: undefined })],
    ["auth_time missing", () => mint("bearer", { auth_time: undefined })],
    ["auth_time as a string", () => mint("bearer", { auth_time: String(AUTH_TIME) })],
    ["typ JWT with a non-JSON payload (the SDK's raw SyntaxError path)", () => `${b64(GOOD_HEADER)}.${Buffer.from("not json").toString("base64url")}.c2ln`],
    ["payload is a JSON array", () => `${b64(GOOD_HEADER)}.${b64([PROJECT_ID])}.c2ln`],
    ["payload is a JSON string", () => `${b64(GOOD_HEADER)}.${b64("Error fetching public keys")}.c2ln`],
    ["header is not JSON", () => `${Buffer.from("{nope").toString("base64url")}.${b64(claims("bearer"))}.c2ln`],
    ["header is a JSON array", () => `${b64(["RS256"])}.${b64(claims("bearer"))}.c2ln`],
    ["two segments", () => `${b64(GOOD_HEADER)}.${b64(claims("bearer"))}`],
    ["four segments", () => `${TOK_A}.extra`],
    ["empty signature segment", () => `${b64(GOOD_HEADER)}.${b64(claims("bearer"))}.`],
    ["standard-base64 characters in the signature", () => `${b64(GOOD_HEADER)}.${b64(claims("bearer"))}.c2ln+/=`],
    ["whitespace inside the token", () => `${b64(GOOD_HEADER)}. ${b64(claims("bearer"))}.c2ln`],
    ["garbage", () => "not-a-jwt"],
    ["the literal SDK key-fetch text as the token", () => "Error fetching public keys for Google certs: x"],
  ];

  it.each(CRAFTED_BEARERS)(
    "bearer with %s is 401 invalid_credential on every tier; verifyIdToken is NEVER called; no record is read; nothing is logged as unavailable",
    async (_n, mk) => {
      const crafted = mk();
      // The fake would GRANT this token if it were asked — so a pass here proves
      // the SDK was bypassed, not merely that it rejected the token.
      mockState.tokens[crafted] = token();
      for (const tier of TIERS) expectDenied(await check(bearer(crafted), tier), 401, "invalid_credential");
      expect(verifyIdToken).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(events("privileged_auth_unavailable")).toEqual([]);
      expect(events("privileged_access_denied")).toHaveLength(TIERS.length);
    }
  );

  it.each([
    ["aud carrying the SDK's key-fetch text", () => mint("cookie", { aud: "Error fetching public keys for Google certs: boom" })],
    ["the ID-token issuer on a cookie", () => mint("cookie", { iss: ISSUER.bearer + PROJECT_ID })],
    ["typ JWT with a non-JSON payload", () => `${b64(GOOD_HEADER)}.${Buffer.from("not json").toString("base64url")}.c2ln`],
    ["expired", () => mint("cookie", { exp: NOW_SECONDS - 1 })],
    ["kid missing", () => mint("cookie", {}, { alg: "RS256" })],
  ])("cookie with %s is 401 invalid_credential on PORTAL and GOV; verifySessionCookie is NEVER called", async (_n, mk) => {
    const crafted = mk();
    mockState.cookies[crafted] = token();
    expectDenied(await check(req({ cookie: crafted }), "ADMIN_PORTAL"), 401, "invalid_credential");
    expectDenied(await check(req({ cookie: crafted }), "GOVERNANCE_ADMIN"), 401, "invalid_credential");
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("a crafted cookie beside a valid bearer is still 401 — and the bearer does not launder it", async () => {
    const crafted = mint("cookie", { aud: "Error fetching public keys for Google certs: boom" });
    expectDenied(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: crafted }), "ADMIN_PORTAL"), 401, "invalid_credential");
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("control: the well-formed registered bearer reaches the SDK exactly once and is granted", async () => {
    expectGranted(await check(bearer(), "SYSTEM_ADMIN"));
    expect(verifyIdToken.mock.calls).toEqual([[TOK_A, false]]);
  });

  it("control: the pre-validation defect is logged as the error code of a credential denial, never as unavailable", async () => {
    await check(bearer(mint("bearer", { aud: "Error fetching" })), "SYSTEM_ADMIN");
    expect(events("privileged_access_denied").map((e) => e.data)).toEqual([
      { route: "/api/admin/example", tier: "SYSTEM_ADMIN", status: 401, reason: "invalid_credential" },
    ]);
  });
});

describe("after pre-validation: the SDK's verdicts, classified by structure", () => {
  const argErr = (message: string) => new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, message);

  it("a well-formed token Google did not sign (SDK fixed text 'has invalid signature.') is 401, SDK called once, no record read", async () => {
    const unsigned = mint("bearer", { sub: "(.*)+$^[Error fetching public keys]" }); // sub is within the uid grammar
    expectDenied(await check(bearer(unsigned), "SYSTEM_ADMIN"), 401, "invalid_credential");
    expect(verifyIdToken.mock.calls).toEqual([[unsigned, false]]);
    expect(getUser).not.toHaveBeenCalled();
  });
  it("SDK fixed text for an unknown kid is 401", async () => {
    mockState.tokens[TOK_A] = argErr(
      'Firebase ID token has "kid" claim which does not correspond to a known public key. Most likely the ID token is expired, so get a fresh token from your client app and try again.'
    );
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "invalid_credential");
  });
  it.each([
    ["invalid signature", `Firebase session cookie has invalid signature.${SDK_DOCS.cookie}`],
    ["unknown kid", 'Firebase session cookie has "kid" claim which does not correspond to a known public key. Most likely the session cookie is expired, so get a fresh token from your client app and try again.'],
  ])("cookie: SDK fixed text for %s is 401", async (_n, message) => {
    mockState.cookies[COOKIE_A] = argErr(message);
    expectDenied(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "invalid_credential");
  });
  it("the pinned texts are matched per credential kind: an ID-token-worded message thrown for a COOKIE is not a credential verdict (503)", async () => {
    mockState.cookies[COOKIE_A] = argErr(`Firebase ID token has invalid signature.${SDK_DOCS.bearer}`);
    expectDenied(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"), 503, "auth_unavailable");
  });
  it("the pinned text must be a PREFIX: the same words embedded later in a message are not a verdict", async () => {
    mockState.tokens[TOK_A] = argErr(`Error while making request: Firebase ID token has invalid signature.`);
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 503, "auth_unavailable");
  });

  const OUTAGES: Array<[string, () => unknown]> = [
    ["Google cert endpoint error body (utils/jwt.js:133 text)", () => argErr("Error fetching public keys for Google certs: <!DOCTYPE html><title>503 Service Unavailable</title>")],
    ["key-fetch network failure (utils/jwt.js:146 rethrow; the observed SDK shape)", () => argErr("Error while making request: connect ECONNREFUSED 142.250.74.106:443. Error code: ECONNREFUSED")],
    ["key-fetch DNS failure", () => argErr("Error while making request: getaddrinfo ENOTFOUND www.googleapis.com. Error code: ENOTFOUND")],
    ["key-fetch timeout", () => argErr("Error while making request: timeout of 10000ms exceeded. Error code: ETIMEDOUT")],
    ["argument-error with the SDK default message", () => new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT)],
    ["ECONNRESET without an auth code", () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["AbortError", () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    ["app/network-error", () => Object.assign(new Error("Error while making request: socket hang up"), { code: "app/network-error" })],
    ["auth/internal-error", () => new SdkAuthError(AuthClientErrorCode.INTERNAL_ERROR)],
    ["auth/invalid-credential (the SDK could not resolve a project id)", () => new SdkAuthError(AuthClientErrorCode.INVALID_CREDENTIAL)],
    ["a thrown string", () => "boom"],
    ["a thrown null", () => null],
  ];
  it.each(OUTAGES)("%s on the bearer is 503 auth_unavailable on every tier, no record read", async (_n, mk) => {
    mockState.tokens[TOK_A] = mk() as Error;
    for (const tier of TIERS) expectDenied(await check(bearer(), tier), 503, "auth_unavailable");
    expect(getUser).not.toHaveBeenCalled();
    expect(events("privileged_auth_unavailable")).toHaveLength(TIERS.length);
  });
  it.each(OUTAGES.slice(0, 4))("%s on the cookie is 503 on PORTAL", async (_n, mk) => {
    mockState.cookies[COOKIE_A] = mk() as Error;
    expectDenied(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"), 503, "auth_unavailable");
  });
  it("KEY DEMONSTRATION: the network-shaped key-fetch failure contains no 'Error fetching' text — a message matcher mislabels this outage as 401", () => {
    const err = OUTAGES[1][1]() as Error & { code: string };
    expect(err.code).toBe("auth/argument-error");
    expect(/error fetching/i.test(err.message)).toBe(false);
  });
  it("the SDK's own expiry verdict on a token that passed pre-validation (clock skew) is 401", async () => {
    mockState.tokens[TOK_A] = new SdkAuthError(AuthClientErrorCode.ID_TOKEN_EXPIRED, "Firebase ID token has expired. Get a fresh ID token from your client app and try again (auth/id-token-expired).");
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "invalid_credential");
    mockState.cookies[COOKIE_A] = new SdkAuthError(AuthClientErrorCode.SESSION_COOKIE_EXPIRED);
    expectDenied(await check(req({ cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "invalid_credential");
  });
});

describe("SP-5 slots: an existing-but-empty header or cookie is a presented credential", () => {
  it.each([[""], ["   "]])("Authorization %p beside a valid cookie is 401 invalid_credential — the cookie never substitutes", async (h) => {
    expectDenied(await check(req({ authorization: h, cookie: COOKIE_A }), "ADMIN_PORTAL"), 401, "invalid_credential");
    expect(getUser).not.toHaveBeenCalled();
  });
  it("Authorization '' alone is 401 invalid_credential, not missing_credentials", async () => {
    for (const tier of TIERS) expectDenied(await check(req({ authorization: "" }), tier), 401, "invalid_credential");
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
  it("an empty __session cookie beside a valid bearer is 401 invalid_credential, no record read", async () => {
    expectDenied(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: "" }), "SYSTEM_ADMIN"), 401, "invalid_credential");
    expectDenied(await check(req({ authorization: `Bearer ${TOK_A}`, cookie: "" }), "ADMIN_PORTAL"), 401, "invalid_credential");
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });
  it("an empty __session cookie alone: SYSTEM is cookie_not_accepted_for_tier, PORTAL and GOV are invalid_credential; no Auth call", async () => {
    expectDenied(await check(req({ cookie: "" }), "SYSTEM_ADMIN"), 401, "cookie_not_accepted_for_tier");
    expectDenied(await check(req({ cookie: "" }), "ADMIN_PORTAL"), 401, "invalid_credential");
    expectDenied(await check(req({ cookie: "" }), "GOVERNANCE_ADMIN"), 401, "invalid_credential");
    expect(verifySessionCookie).not.toHaveBeenCalled();
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });
  it("control: an unrelated cookie is not a __session slot — the bearer alone is granted", async () => {
    const r = new NextRequest("http://localhost/api/admin/example", { headers: { authorization: `Bearer ${TOK_A}`, cookie: "other=1" } });
    expectGranted(await check(r, "SYSTEM_ADMIN"));
  });
});

describe("the project id binds aud/iss", () => {
  it.each([[undefined], [""], [null], [42]])("project id %p: 503 auth_unavailable and the SDK is never called", async (pid) => {
    mockState.projectId = pid;
    for (const tier of TIERS) expectDenied(await check(bearer(), tier), 503, "auth_unavailable");
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(events("privileged_auth_unavailable").map((e) => (e.data as { errorCode: string }).errorCode)).toEqual(Array(TIERS.length).fill("project_id_unavailable"));
  });
  it("a token addressed to the project the SDK was NOT initialised with is 401 before the SDK", async () => {
    mockState.projectId = "another-project";
    expectDenied(await check(bearer(), "SYSTEM_ADMIN"), 401, "invalid_credential");
    expect(verifyIdToken).not.toHaveBeenCalled();
    // control: a token addressed to that project reaches the SDK
    const other = mint("bearer", { aud: "another-project", iss: ISSUER.bearer + "another-project" });
    mockState.tokens[other] = token();
    expectGranted(await check(bearer(other), "SYSTEM_ADMIN"));
    expect(verifyIdToken.mock.calls).toEqual([[other, false]]);
  });
});

describe("static boundaries", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const SRC = readFileSync(join(ROOT, "lib/admin/privilegedAccess.ts"), "utf8");
  const ADAPTER_SRC = readFileSync(join(ROOT, "lib/admin/privilegedCredentialAdapter.ts"), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const code = strip(SRC);
  const adapterCode = strip(ADAPTER_SRC);

  it("the guard is server-only and reads no environment variable or shared secret (SP-8)", () => {
    expect(SRC).toMatch(/^import "server-only";$/m);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/ADMIN_SECRET|BOOTSTRAP_SECRET/);
    // Not even in a comment: the operator-token discovery in
    // docs/__tests__/bootstrapProbeInvariant.spec.ts would classify the module.
    expect(SRC).not.toMatch(/ADMIN_SECRET/);
  });

  it("the adapter is server-only, reads no environment, and never calls the SDK itself (the call is injected)", () => {
    expect(ADAPTER_SRC).toMatch(/^import "server-only";$/m);
    expect(adapterCode).not.toMatch(/process\.env/);
    expect(ADAPTER_SRC).not.toMatch(/ADMIN_SECRET/);
    expect(adapterCode).not.toMatch(/verifyIdToken|verifySessionCookie|\.getUser\s*\(|firebase-admin/);
  });

  it("the guard reads no error message at all; the adapter compares messages only by startsWith against its pinned constants", () => {
    expect(code).not.toMatch(/\.message\b/);
    expect(code).not.toMatch(/error fetching/i);
    // No free-text search of a message: no regex test / match / includes / indexOf on strings in the adapter.
    expect(adapterCode).not.toMatch(/\.(test|match|includes|indexOf|search)\s*\(/);
    expect(adapterCode).not.toMatch(/new RegExp\(/);
    expect(adapterCode.match(/\.startsWith\(/g)).toHaveLength(1);
  });

  it("the guard performs no Auth lookup of its own (the one read is readLiveAuthSnapshot)", () => {
    expect(code).not.toMatch(/\.getUser\s*\(/);
    expect(code.match(/readLiveAuthSnapshot\s*\(/g)).toHaveLength(1);
  });

  it("the guard keeps no module-level mutable state (SP-3)", () => {
    const topLevel = code.split("\n").filter((l) => /^(let|var|const)\s/.test(l));
    for (const l of topLevel) {
      expect(l).not.toMatch(/^(let|var)\s/);
      expect(l).not.toMatch(/new (Map|WeakMap|Set|WeakSet)\b(?!\(\[)/);
    }
  });

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(e)) out.push(p);
    }
    return out;
  }

  it("is DARK at S2-a: nothing under app/ (or middleware) imports the guard yet", () => {
    const files = [...walk(join(ROOT, "app")), join(ROOT, "middleware.ts")];
    expect(files.length).toBeGreaterThan(100);
    const importers = files
      .filter((f) => /privilegedAccess|privilegedCredentialAdapter/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(importers).toEqual([]);
  });

  it("the darkness scan can see an importer (positive control on the matcher)", () => {
    expect(/privilegedAccess|privilegedCredentialAdapter/.test('import { requirePrivilegedAccess } from "@/lib/admin/privilegedAccess";')).toBe(true);
    expect(/privilegedAccess|privilegedCredentialAdapter/.test('import { prevalidateCredential } from "@/lib/admin/privilegedCredentialAdapter";')).toBe(true);
  });
});
