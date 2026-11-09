/**
 * SEC-3 / S2-a (correction round) — THE CREDENTIAL ADAPTER, PINNED TO THE SDK.
 *
 * Three kinds of evidence, all against the firebase-admin that is actually
 * installed under node_modules (not a copy, not a fixture):
 *
 *   1. DRIFT PINS. Every SDK constant the adapter relies on — error code,
 *      jwtName prefixes, the two fixed credential messages, the issuers, the
 *      algorithm, the uid grammar, the key-fetch text and the default branch
 *      that discards the JwtErrorCode — is read back out of the SDK source.
 *      An SDK upgrade that changes any of them fails here, not in production.
 *
 *   2. EXECUTABLE SUPERSET PROOF. For each `verifyContent` rejection branch a
 *      crafted token is run through the REAL verifier (offline: those branches
 *      run before any key fetch) and through the adapter's pre-validation; the
 *      SDK must reject it with `auth/argument-error` (or the raw SyntaxError
 *      path) AND pre-validation must reject it first.
 *
 *   3. THE REAL OUTAGE OBJECT. A well-formed token is run through the real
 *      verifier with an HTTP agent that cannot connect, so the error object is
 *      exactly what the SDK throws when Google's key endpoint is unreachable.
 *      The adapter must classify it unavailable — and the test records that
 *      its message carries no "Error fetching" text, which is why the retired
 *      message matcher mislabelled this outage as an authentication failure.
 */

import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import { join } from "node:path";
import { AuthClientErrorCode, FirebaseAuthError } from "firebase-admin/auth";
/** The SDK marks the real `(info, message)` constructor `@internal`, so the public typings hide it. */
const SdkAuthError = FirebaseAuthError as unknown as new (info: { code: string; message: string }, message?: string) => FirebaseAuthError;
import {
  EXPECTED_ISSUER_PREFIX,
  SDK_ALGORITHM,
  SDK_ARGUMENT_ERROR_CODE,
  SDK_CREDENTIAL_ARGUMENT_ERROR_SUFFIXES,
  SDK_CREDENTIAL_ERROR_CODES,
  SDK_JWT_NAME,
  SDK_UID_MAX_LENGTH,
  classifyVerificationFailure,
  prevalidateCredential,
  verifyPrevalidatedCredential,
  type CredentialKind,
  type PrevalidatedCredential,
} from "@/lib/admin/privilegedCredentialAdapter";

const ROOT = join(__dirname, "..", "..", "..");
const SDK_LIB = join(ROOT, "node_modules", "firebase-admin", "lib");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const tokenVerifierSrc = read(SDK_LIB, "auth", "token-verifier.js");
const jwtSrc = read(SDK_LIB, "utils", "jwt.js");
const errorSrc = read(SDK_LIB, "utils", "error.js");
const validatorSrc = read(SDK_LIB, "utils", "validator.js");
const jwsSrc = read(ROOT, "node_modules", "jws", "lib", "verify-stream.js");
const jsonwebtokenVerifySrc = read(ROOT, "node_modules", "jsonwebtoken", "verify.js");
const sdkVersion = (JSON.parse(read(ROOT, "node_modules", "firebase-admin", "package.json")) as { version: string }).version;

// The verifier factory is internal (not in the package `exports` map), so it is
// loaded by file path. It is the same module instance `firebase-admin/auth` uses.
type Verifier = { verifyJWT(token: string, isEmulator?: boolean): Promise<unknown> };

const tokenVerifier = require(join(SDK_LIB, "auth", "token-verifier.js")) as {
  createIdTokenVerifier(app: unknown): Verifier;
  createSessionCookieVerifier(app: unknown): Verifier;
};

const PROJECT_ID = "test-project-invented";
const NOW = 1_800_000_000;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const HEADER = { alg: "RS256", kid: "test-kid", typ: "JWT" };
function claims(kind: CredentialKind, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: PROJECT_ID, iss: EXPECTED_ISSUER_PREFIX[kind] + PROJECT_ID, sub: "uid-alpha", iat: NOW - 60, exp: NOW + 3600, auth_time: NOW - 60, ...over };
}
function mint(kind: CredentialKind, over: Record<string, unknown> = {}, header: unknown = HEADER, sig = "c2lnbmF0dXJl"): string {
  return `${b64(header)}.${b64(claims(kind, over))}.${sig}`;
}
const GOOD: Record<CredentialKind, string> = { bearer: mint("bearer"), cookie: mint("cookie") };

/** An agent that can never connect: the real SDK's key fetch fails offline and immediately (ECONNREFUSED is not retried). */
function refusingAgent(): Agent {
  const agent = new Agent();
  (agent as unknown as { createConnection: () => never }).createConnection = () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
  };
  return agent;
}
function realVerifier(kind: CredentialKind): Verifier {
  const app = { options: { projectId: PROJECT_ID, httpAgent: refusingAgent() } };
  return kind === "bearer" ? tokenVerifier.createIdTokenVerifier(app) : tokenVerifier.createSessionCookieVerifier(app);
}
async function realReject(kind: CredentialKind, token: string): Promise<unknown> {
  try {
    await realVerifier(kind).verifyJWT(token);
  } catch (err) {
    return err;
  }
  throw new Error("expected the real SDK to reject");
}
const codeOf = (e: unknown) => (e as { code?: unknown })?.code;
const messageOf = (e: unknown) => String((e as { message?: unknown })?.message ?? "");

describe(`SDK drift pins (firebase-admin ${sdkVersion})`, () => {
  it("is the 12.x line this adapter was written against", () => {
    expect(sdkVersion.split(".")[0]).toBe("12");
  });
  it("the argument-error code", () => {
    expect(errorSrc).toMatch(/AuthClientErrorCode\.INVALID_ARGUMENT = \{\s*code: 'argument-error',/);
    expect(`auth/${AuthClientErrorCode.INVALID_ARGUMENT.code}`).toBe(SDK_ARGUMENT_ERROR_CODE);
    expect(new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, "x").code).toBe(SDK_ARGUMENT_ERROR_CODE);
  });
  it("the jwtName prefixes", () => {
    expect(tokenVerifierSrc).toContain(`jwtName: '${SDK_JWT_NAME.bearer}',`);
    expect(tokenVerifierSrc).toContain(`jwtName: '${SDK_JWT_NAME.cookie}',`);
    expect(tokenVerifierSrc.match(/jwtName: '/g)).toHaveLength(3); // ID token, Auth Blocking token, session cookie
  });
  it("the issuers each verifier demands", () => {
    expect(tokenVerifierSrc).toMatch(new RegExp(`function createIdTokenVerifier\\(app\\) \\{\\s*return new FirebaseTokenVerifier\\(CLIENT_CERT_URL, '${EXPECTED_ISSUER_PREFIX.bearer}'`));
    expect(tokenVerifierSrc).toMatch(new RegExp(`function createSessionCookieVerifier\\(app\\) \\{\\s*return new FirebaseTokenVerifier\\(SESSION_COOKIE_CERT_URL, '${EXPECTED_ISSUER_PREFIX.cookie}'`));
    expect(tokenVerifierSrc).toContain("else if (payload.iss !== this.issuer + projectId) {");
  });
  it("the two fixed credential messages that remain reachable after pre-validation (mapJwtErrorToAuthError)", () => {
    expect(tokenVerifierSrc).toContain("const errorMessage = `${this.tokenInfo.jwtName} has invalid signature.` + verifyJwtTokenDocsMessage;");
    expect(tokenVerifierSrc).toContain("const errorMessage = `${this.tokenInfo.jwtName} has \"kid\" claim which does not ` +");
    expect(tokenVerifierSrc).toContain("`correspond to a known public key. Most likely the ${this.tokenInfo.shortName} ` +");
    expect(SDK_CREDENTIAL_ARGUMENT_ERROR_SUFFIXES).toEqual([" has invalid signature.", ' has "kid" claim which does not correspond to a known public key.']);
  });
  it("the default branch discards the JwtErrorCode and forwards the transport message under argument-error", () => {
    const fn = tokenVerifierSrc.slice(tokenVerifierSrc.indexOf("mapJwtErrorToAuthError(error) {"), tokenVerifierSrc.indexOf("exports.FirebaseTokenVerifier = FirebaseTokenVerifier;"));
    expect(fn.match(/error\.code === jwt_1\.JwtErrorCode\./g)).toHaveLength(3);
    expect(fn).toContain("TOKEN_EXPIRED");
    expect(fn).toContain("INVALID_SIGNATURE");
    expect(fn).toContain("NO_MATCHING_KID");
    expect(fn.trimEnd().endsWith("return new error_1.FirebaseAuthError(error_1.AuthClientErrorCode.INVALID_ARGUMENT, error.message);\n    }\n}")).toBe(true);
  });
  it("the key-fetch path: both message shapes reach the default branch", () => {
    expect(jwtSrc).toContain("let errorMessage = 'Error fetching public keys for Google certs: ';");
    // The non-RequestResponseError (network) failure is rethrown unchanged — it never says "Error fetching".
    expect(jwtSrc).toMatch(/throw new Error\(errorMessage\);\s*\}\s*throw err;\s*\}\);/);
    expect(jwtSrc).toContain("const JWT_CALLBACK_ERROR_PREFIX = 'error in secret or public key callback: ';");
    expect(jwtSrc).toContain('JwtErrorCode["KEY_FETCH_ERROR"] = "key-fetch-error";');
    expect(jsonwebtokenVerifySrc).toContain("return done(new JsonWebTokenError('error in secret or public key callback: ' + err.message));");
  });
  it("verifyContent has exactly the ten rejection branches the pre-validation covers", () => {
    const body = tokenVerifierSrc.slice(tokenVerifierSrc.indexOf("verifyContent(fullDecodedToken, projectId, isEmulator, audience) {"), tokenVerifierSrc.indexOf("verifySignature(jwtToken, isEmulator) {"));
    expect(body.match(/\berrorMessage = /g)).toHaveLength(10);
    expect(body).toContain("typeof header.kid === 'undefined'");
    expect(body).toContain("header.alg !== jwt_1.ALGORITHM_RS256");
    expect(body).toContain("payload.aud !== projectId");
    expect(body).toContain("typeof payload.sub !== 'string'");
    expect(body).toContain("payload.sub === ''");
    expect(body).toContain(`payload.sub.length > ${SDK_UID_MAX_LENGTH}`);
    expect(body).toContain("throw new error_1.FirebaseAuthError(error_1.AuthClientErrorCode.INVALID_ARGUMENT, errorMessage);");
  });
  it("the algorithm, the uid grammar, uid = sub", () => {
    expect(jwtSrc).toContain(`exports.ALGORITHM_RS256 = '${SDK_ALGORITHM}';`);
    expect(validatorSrc).toContain(`return typeof uid === 'string' && uid.length > 0 && uid.length <= ${SDK_UID_MAX_LENGTH};`);
    expect(tokenVerifierSrc).toContain("decodedIdToken.uid = decodedIdToken.sub;");
  });
  it("the compact-JWS grammar and the unguarded JSON.parse behind the SyntaxError path (jws)", () => {
    expect(jwsSrc).toContain("var JWS_REGEX = /^[a-zA-Z0-9\\-_]+?\\.[a-zA-Z0-9\\-_]+?\\.([a-zA-Z0-9\\-_]+)?$/;");
    expect(jwsSrc).toMatch(/if \(header\.typ === 'JWT' \|\| opts\.json\)\s*payload = JSON\.parse\(payload, opts\.encoding\);/);
    expect(jwtSrc).toContain("const fullDecodedToken = jwt.decode(jwtToken, {");
  });
  it("the always-credential codes exist in the SDK with those spellings", () => {
    for (const code of SDK_CREDENTIAL_ERROR_CODES) {
      expect(errorSrc).toContain(`code: '${code.replace(/^auth\//, "")}',`);
    }
    expect(SDK_CREDENTIAL_ERROR_CODES.has(SDK_ARGUMENT_ERROR_CODE)).toBe(false);
  });
});

describe("executable superset proof: every verifyContent rejection is pre-rejected (real SDK, offline)", () => {
  const VERIFY_CONTENT_CASES: Array<[string, CredentialKind, string, string]> = [
    ["no kid", "bearer", mint("bearer", {}, { alg: "RS256" }), "kid_missing"],
    ["no kid, custom-token audience", "bearer", mint("bearer", { aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit" }, { alg: "RS256" }), "kid_missing"],
    ["no kid, legacy custom token shape", "bearer", mint("bearer", { v: 0, d: { uid: "x" } }, { alg: "HS256" }), "alg_not_rs256"],
    ["wrong alg", "bearer", mint("bearer", {}, { alg: "HS256", kid: "k" }), "alg_not_rs256"],
    ["aud carrying the key-fetch text", "bearer", mint("bearer", { aud: "Error fetching public keys for Google certs: boom" }), "aud_mismatch"],
    ["aud array", "bearer", mint("bearer", { aud: [PROJECT_ID] }), "aud_mismatch"],
    ["iss carrying key-fetch-error", "bearer", mint("bearer", { iss: "key-fetch-error" }), "iss_mismatch"],
    ["cookie issuer on an ID token", "bearer", mint("bearer", { iss: EXPECTED_ISSUER_PREFIX.cookie + PROJECT_ID }), "iss_mismatch"],
    ["sub missing", "bearer", mint("bearer", { sub: undefined }), "sub_invalid"],
    ["sub empty", "bearer", mint("bearer", { sub: "" }), "sub_invalid"],
    ["sub 129 chars", "bearer", mint("bearer", { sub: "x".repeat(129) }), "sub_invalid"],
    ["cookie: aud carrying the key-fetch text", "cookie", mint("cookie", { aud: "Error fetching public keys for Google certs: boom" }), "aud_mismatch"],
    ["cookie: ID-token issuer", "cookie", mint("cookie", { iss: EXPECTED_ISSUER_PREFIX.bearer + PROJECT_ID }), "iss_mismatch"],
    ["garbage", "bearer", "not-a-jwt", "not_compact_jws"],
    ["header not JSON", "bearer", `${Buffer.from("{nope").toString("base64url")}.${b64(claims("bearer"))}.c2ln`, "header_not_object"],
  ];
  it.each(VERIFY_CONTENT_CASES)("%s: the real SDK says auth/argument-error; pre-validation says %s first", async (_n, kind, token, defect) => {
    const err = await realReject(kind, token);
    expect(codeOf(err)).toBe(SDK_ARGUMENT_ERROR_CODE);
    expect(prevalidateCredential(token, kind, PROJECT_ID, NOW)).toEqual({ ok: false, defect });
  });
  it("the SDK quotes the caller's aud and iss in its message — the reason text can never be the boundary", async () => {
    const aud = await realReject("bearer", mint("bearer", { aud: "Error fetching public keys for Google certs: boom" }));
    expect(messageOf(aud)).toContain('but got "Error fetching public keys for Google certs: boom"');
    const iss = await realReject("bearer", mint("bearer", { iss: "key-fetch-error" }));
    expect(messageOf(iss)).toContain('but got "key-fetch-error"');
  });
  it("typ JWT with a non-JSON payload: the real SDK throws a raw SyntaxError with NO code; pre-validation rejects it", async () => {
    const token = `${b64(HEADER)}.${Buffer.from("not json").toString("base64url")}.c2ln`;
    const err = await realReject("bearer", token);
    expect(err).toBeInstanceOf(SyntaxError);
    expect(codeOf(err)).toBeUndefined();
    expect(prevalidateCredential(token, "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "payload_not_object" });
  });
  it("cases the SDK's verifyContent does NOT reject (empty kid, expired, missing iat/auth_time) are still pre-rejected, so they never trigger a key fetch", async () => {
    for (const [token, defect] of [
      [mint("bearer", {}, { alg: "RS256", kid: "" }), "kid_missing"],
      [mint("bearer", { exp: NOW - 1 }), "expired"],
      [mint("bearer", { exp: "soon" }), "exp_invalid"],
      [mint("bearer", { iat: undefined }), "iat_invalid"],
      [mint("bearer", { auth_time: null }), "auth_time_invalid"],
    ] as Array<[string, string]>) {
      expect(prevalidateCredential(token, "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect });
    }
  });
});

describe("the real outage object (real SDK, key endpoint unreachable)", () => {
  it.each(["bearer", "cookie"] as CredentialKind[])(
    "%s: a well-formed credential reaches the key fetch; the SDK throws auth/argument-error WITHOUT 'Error fetching' text; the adapter says unavailable",
    async (kind) => {
      const pre = prevalidateCredential(GOOD[kind], kind, PROJECT_ID, NOW);
      expect(pre.ok).toBe(true);
      const err = await realReject(kind, GOOD[kind]);
      expect(err).toBeInstanceOf(FirebaseAuthError);
      expect(codeOf(err)).toBe(SDK_ARGUMENT_ERROR_CODE);
      expect(messageOf(err)).toMatch(/ECONNREFUSED/);
      expect(/error fetching/i.test(messageOf(err))).toBe(false); // the retired matcher would have said 401
      expect(classifyVerificationFailure((pre as { ok: true; value: PrevalidatedCredential }).value, err, kind)).toBe("unavailable");
    }
  );
  it("the other key-fetch shape (Google answered with an error body) is also unavailable", () => {
    const proof = (prevalidateCredential(GOOD.bearer, "bearer", PROJECT_ID, NOW) as { ok: true; value: PrevalidatedCredential }).value;
    const err = new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, "Error fetching public keys for Google certs: <!DOCTYPE html>...");
    expect(classifyVerificationFailure(proof, err, "bearer")).toBe("unavailable");
  });
});

describe("prevalidateCredential (pure)", () => {
  it("accepts a well-formed credential and returns a frozen proof of exactly what it checked", () => {
    const r = prevalidateCredential(GOOD.bearer, "bearer", PROJECT_ID, NOW);
    expect(r).toEqual({ ok: true, value: { sub: "uid-alpha", exp: NOW + 3600, iat: NOW - 60, authTime: NOW - 60 } });
    if (r.ok) expect(Object.isFrozen(r.value)).toBe(true);
    expect(prevalidateCredential(GOOD.cookie, "cookie", PROJECT_ID, NOW).ok).toBe(true);
  });
  it("kinds are not interchangeable", () => {
    expect(prevalidateCredential(GOOD.bearer, "cookie", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "iss_mismatch" });
    expect(prevalidateCredential(GOOD.cookie, "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "iss_mismatch" });
  });
  it("expiry is the SDK's rule: now >= exp is expired; now = exp - 1 is not", () => {
    const t = mint("bearer", { exp: NOW });
    expect(prevalidateCredential(t, "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "expired" });
    expect(prevalidateCredential(t, "bearer", PROJECT_ID, NOW - 1).ok).toBe(true);
    expect(prevalidateCredential(t, "bearer", PROJECT_ID, NaN)).toEqual({ ok: false, defect: "expired" });
  });
  it("the project id must be a non-empty string equal to aud", () => {
    expect(prevalidateCredential(GOOD.bearer, "bearer", "", NOW)).toEqual({ ok: false, defect: "aud_mismatch" });
    expect(prevalidateCredential(GOOD.bearer, "bearer", "other", NOW)).toEqual({ ok: false, defect: "aud_mismatch" });
    expect(prevalidateCredential(GOOD.bearer, "bearer", undefined as unknown as string, NOW)).toEqual({ ok: false, defect: "aud_mismatch" });
  });
  it("never throws for non-string input", () => {
    for (const raw of [undefined, null, 42, {}, [], Symbol("x")]) {
      expect(prevalidateCredential(raw, "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "not_compact_jws" });
    }
  });
  it("the sub grammar is the SDK's: 1..128 chars, any content", () => {
    expect(prevalidateCredential(mint("bearer", { sub: "x".repeat(128) }), "bearer", PROJECT_ID, NOW).ok).toBe(true);
    expect(prevalidateCredential(mint("bearer", { sub: "(.*)+$ Error fetching ✓" }), "bearer", PROJECT_ID, NOW).ok).toBe(true);
    expect(prevalidateCredential(mint("bearer", { sub: "x".repeat(129) }), "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "sub_invalid" });
  });
  it("checks run in a fixed order so the reported defect is the first structural failure", () => {
    expect(prevalidateCredential(mint("bearer", { aud: "x", sub: "" }, { alg: "none" }), "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "alg_not_rs256" });
    expect(prevalidateCredential(mint("bearer", { aud: "x", sub: "" }), "bearer", PROJECT_ID, NOW)).toEqual({ ok: false, defect: "sub_invalid" });
  });
});

describe("classifyVerificationFailure (pure)", () => {
  const proof = (prevalidateCredential(GOOD.bearer, "bearer", PROJECT_ID, NOW) as { ok: true; value: PrevalidatedCredential }).value;
  const argErr = (m?: string) => new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, m);

  it.each([...SDK_CREDENTIAL_ERROR_CODES])("%s is credential whatever the message", (code) => {
    expect(classifyVerificationFailure(proof, Object.assign(new Error("Error fetching public keys"), { code }), "bearer")).toBe("credential");
  });
  it("argument-error: the two pinned texts are credential, per kind, by prefix", () => {
    for (const kind of ["bearer", "cookie"] as CredentialKind[]) {
      for (const suffix of SDK_CREDENTIAL_ARGUMENT_ERROR_SUFFIXES) {
        expect(classifyVerificationFailure(proof, argErr(`${SDK_JWT_NAME[kind]}${suffix} See docs.`), kind)).toBe("credential");
        const other: CredentialKind = kind === "bearer" ? "cookie" : "bearer";
        expect(classifyVerificationFailure(proof, argErr(`${SDK_JWT_NAME[other]}${suffix} See docs.`), kind)).toBe("unavailable");
        expect(classifyVerificationFailure(proof, argErr(`prefix ${SDK_JWT_NAME[kind]}${suffix}`), kind)).toBe("unavailable");
      }
    }
  });
  it("argument-error with any other text is unavailable (the key-fetch class)", () => {
    for (const m of ["Error fetching public keys for Google certs: x", "Error while making request: read ECONNRESET. Error code: ECONNRESET", "", undefined, "Firebase ID token has incorrect \"aud\" (audience) claim."]) {
      expect(classifyVerificationFailure(proof, argErr(m), "bearer")).toBe("unavailable");
    }
  });
  it("unknown codes, no code, non-Error throws are unavailable (SP-2)", () => {
    for (const e of [new Error("x"), Object.assign(new Error("x"), { code: "ECONNRESET" }), Object.assign(new Error("x"), { code: 7 }), "boom", null, undefined, 42]) {
      expect(classifyVerificationFailure(proof, e, "bearer")).toBe("unavailable");
    }
  });
  it("without a pre-validation proof the classifier refuses to call anything a credential verdict", () => {
    const err = argErr(`${SDK_JWT_NAME.bearer}${SDK_CREDENTIAL_ARGUMENT_ERROR_SUFFIXES[0]}`);
    expect(classifyVerificationFailure(undefined as unknown as PrevalidatedCredential, err, "bearer")).toBe("unavailable");
    expect(classifyVerificationFailure({} as PrevalidatedCredential, err, "bearer")).toBe("unavailable");
    expect(classifyVerificationFailure(proof, err, "bearer")).toBe("credential"); // control
  });
});

describe("verifyPrevalidatedCredential (composition)", () => {
  it("does not call verify for a rejected shape", async () => {
    const verify = jest.fn(async () => ({}));
    expect(await verifyPrevalidatedCredential("bearer", mint("bearer", { aud: "x" }), PROJECT_ID, NOW, verify)).toEqual({ kind: "rejected_shape", defect: "aud_mismatch" });
    expect(verify).not.toHaveBeenCalled();
  });
  it("calls verify exactly once with the raw bytes and returns the proof beside the decoded claims", async () => {
    const verify = jest.fn(async () => ({ sub: "uid-alpha", uid: "uid-alpha" }));
    const r = await verifyPrevalidatedCredential("bearer", GOOD.bearer, PROJECT_ID, NOW, verify);
    expect(verify.mock.calls).toEqual([[GOOD.bearer]]);
    expect(r).toEqual({ kind: "verified", proof: { sub: "uid-alpha", exp: NOW + 3600, iat: NOW - 60, authTime: NOW - 60 }, decoded: { sub: "uid-alpha", uid: "uid-alpha" } });
  });
  it("maps a throwing verify to credential_error / unavailable with the error code, and never propagates", async () => {
    const cred = new SdkAuthError(AuthClientErrorCode.ID_TOKEN_EXPIRED);
    expect(await verifyPrevalidatedCredential("bearer", GOOD.bearer, PROJECT_ID, NOW, async () => { throw cred; })).toEqual({ kind: "credential_error", errorCode: "auth/id-token-expired" });
    const outage = new SdkAuthError(AuthClientErrorCode.INVALID_ARGUMENT, "Error while making request: x");
    expect(await verifyPrevalidatedCredential("bearer", GOOD.bearer, PROJECT_ID, NOW, async () => { throw outage; })).toEqual({ kind: "unavailable", errorCode: "auth/argument-error" });
    expect(await verifyPrevalidatedCredential("bearer", GOOD.bearer, PROJECT_ID, NOW, async () => { throw new Error("no code"); })).toEqual({ kind: "unavailable", errorCode: "no_error_code" });
    expect(await verifyPrevalidatedCredential("bearer", GOOD.bearer, PROJECT_ID, NOW, () => Promise.reject("string"))).toEqual({ kind: "unavailable", errorCode: "no_error_code" });
  });
});
