/**
 * SEC-3 / S2-a (correction round) — THE CREDENTIAL ADAPTER for the
 * privileged-access guard (`lib/admin/privilegedAccess.ts`).
 *
 * WHY THIS MODULE EXISTS.
 *
 * firebase-admin 12.x maps several DIFFERENT failures onto one error code,
 * `auth/argument-error`, and some of those failures quote the credential's
 * own claim values in the human-readable message:
 *
 *   node_modules/firebase-admin/lib/auth/token-verifier.js
 *     :218-221  wrong `aud`  → `... but got "<payload.aud>"`       (caller content)
 *     :223-226  wrong `iss`  → `... but got "<payload.iss>"`       (caller content)
 *     :210-212  wrong `alg`  → `... but got "<header.alg>"`        (caller content)
 *     :194-208  no `kid` / custom token / legacy custom token        (fixed text)
 *     :232-242  `sub` missing / empty / > 128 chars                  (fixed text)
 *     :270-272  invalid signature                                   (fixed text)
 *     :274-278  `kid` matches no Google public key                  (fixed text)
 *     :280      DEFAULT: any other JwtError, which is the public-key
 *               FETCH failure (`KEY_FETCH_ERROR`, utils/jwt.js:264-273),
 *               carrying the TRANSPORT error's text verbatim — either
 *               "Error fetching public keys for Google certs: ..."
 *               (utils/jwt.js:133) or, for a network failure, whatever the
 *               HTTP client threw (utils/jwt.js:146 rethrows it; observed:
 *               "Error while making request: connect ECONNREFUSED ...").
 *
 * The guard must answer 401 for a bad credential and 503 for an Auth outage.
 * Deciding that by matching text in the message is unsafe in both directions:
 * an unauthenticated caller can put "Error fetching" in its own `aud` and turn
 * a 401 into a 503 (an induced availability signal), and a real key-fetch
 * network failure does not say "Error fetching" at all, so it would be
 * reported as an authentication failure.
 *
 * In addition, `jws` throws a raw `SyntaxError` (no `code`) from inside the
 * SDK's synchronous decode when the header says `typ: "JWT"` and the payload
 * is not JSON (node_modules/jws/lib/verify-stream.js jwsDecode, reached via
 * jsonwebtoken/decode.js and firebase-admin utils/jwt.js:291), so a crafted
 * credential can also produce an error of UNKNOWN shape.
 *
 * THE DESIGN.
 *
 * (1) STRUCTURAL PRE-VALIDATION, before the SDK is called. The raw credential
 *     must be a compact JWS whose header and payload are JSON objects, with
 *     `alg` RS256, a non-empty string `kid`, a `sub` within the SDK's uid
 *     grammar (1..128 chars; utils/validator.js:131-133), `aud` equal to the
 *     project id the Admin app was initialised with, `iss` equal to the
 *     exact issuer the SDK will demand for this credential kind, finite
 *     numeric `exp` / `iat` / `auth_time`, and `exp` still in the future by
 *     the SDK's own rule (jsonwebtoken/verify.js:189, tolerance 0). Every
 *     structural failure is deterministically a CREDENTIAL failure (401) and
 *     the SDK is never called, so no caller-controlled value can ever appear
 *     in an error message that is later classified. This check is a strict
 *     superset of `verifyContent` (token-verifier.js:186-247): each of its
 *     rejection branches is pre-rejected here, which the sibling spec proves
 *     against the installed SDK.
 *
 * (2) BOUNDED CLASSIFICATION after pre-validation. Once (1) has passed, the
 *     only `auth/argument-error` sources left in the SDK are: invalid
 *     signature, no matching `kid`, the `safeDecode` decode failure (reached
 *     only if the SDK's own JWT decoder disagrees with the pre-validation
 *     decoder; pinned so a future SDK or decoder divergence can never turn a
 *     credential defect into a 503), and the key-fetch failure. The first
 *     three are FIXED SDK strings with no caller content, and they are the
 *     only credential outcomes, so THEY are pinned (prefix-equal against the
 *     SDK's exact text). Everything else under `auth/argument-error` is, by
 *     elimination, the key-fetch path — whose message is the transport
 *     error's text and therefore cannot be pinned — and is classified
 *     UNAVAILABLE (503), which is what design assumption A-2 prescribes for
 *     a public-key fetch failure.
 *
 *     FAIL DIRECTION FOR THE UNKNOWN. An error of unknown code or shape after
 *     pre-validation is 503 (SP-2: fail closed on unavailable Auth). This is
 *     safe against induced-availability only BECAUSE of (1): after
 *     pre-validation the caller's bytes can no longer steer the SDK into an
 *     unknown-shape error (the `SyntaxError` path above is pre-rejected), so
 *     an unknown error there is a genuine infrastructure condition.
 *
 * VERSION-PINNED ADAPTER, NOT A BOUNDARY. The pinned strings in this file are
 * the SDK's own constants. `lib/admin/__tests__/privilegedCredentialAdapter.spec.ts`
 * reads them back out of node_modules/firebase-admin so that an SDK upgrade
 * that changes any of them fails the suite instead of silently moving a
 * credential failure into the 503 bucket.
 *
 * No alternative structured signal exists in firebase-admin 12.x: the
 * `FirebaseAuthError` carries `errorInfo.code` equal to `code`, the
 * `JwtErrorCode` is discarded at token-verifier.js:280, and the public-key
 * fetch is not separable from verification without re-implementing it.
 */

import "server-only";

export type CredentialKind = "bearer" | "cookie";

/** token-verifier.js:292 and :314 — the issuer each verifier demands. */
export const EXPECTED_ISSUER_PREFIX: Readonly<Record<CredentialKind, string>> = Object.freeze({
  bearer: "https://securetoken.google.com/",
  cookie: "https://session.firebase.google.com/",
});

/** token-verifier.js:40 and :64 — the `jwtName` that prefixes every message. */
export const SDK_JWT_NAME: Readonly<Record<CredentialKind, string>> = Object.freeze({
  bearer: "Firebase ID token",
  cookie: "Firebase session cookie",
});

/** utils/jwt.js:24 */
export const SDK_ALGORITHM = "RS256";
/** utils/validator.js:131-133 (`isUid`), token-verifier.js:239. */
export const SDK_UID_MAX_LENGTH = 128;
/** utils/error.js:374-377 — `AuthClientErrorCode.INVALID_ARGUMENT`, prefixed `auth/`. */
export const SDK_ARGUMENT_ERROR_CODE = "auth/argument-error";

/**
 * token-verifier.js:271 and :275-277 — the two FIXED-TEXT `argument-error`
 * messages that remain reachable after pre-validation and that mean "bad
 * credential". Compared by prefix because the SDK appends a documentation
 * sentence after each. Neither embeds any caller-controlled value.
 */
export const SDK_CREDENTIAL_ARGUMENT_ERROR_SUFFIXES: readonly string[] = Object.freeze([
  " has invalid signature.",
  ' has "kid" claim which does not correspond to a known public key.',
]);

/**
 * token-verifier.js:171-173 (`safeDecode`) — the third FIXED-TEXT
 * `argument-error`: "Decoding <jwtName> failed. Make sure you passed …". It is
 * raised when the SDK's own `decodeJwt` rejects the string. Pre-validation
 * decodes the same three segments first, so today this path is unreachable;
 * it is pinned as a credential outcome so that a decoder divergence (SDK
 * upgrade, Buffer encoding change) can never classify a bad credential as a
 * verifier outage. The template wraps the jwtName; no caller value appears.
 */
export const SDK_CREDENTIAL_DECODE_FAILED = Object.freeze({ prefix: "Decoding ", suffix: " failed." });

/**
 * Codes that are ALWAYS a credential outcome whatever the message. With
 * `checkRevoked = false` the SDK cannot throw the revoked / disabled /
 * not-found codes from verification, but if a code in this family ever does
 * arrive it names a property of the credential, never of the infrastructure.
 */
export const SDK_CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth/id-token-expired",
  "auth/session-cookie-expired",
  "auth/id-token-revoked",
  "auth/session-cookie-revoked",
  "auth/invalid-id-token",
  "auth/user-disabled",
  "auth/user-not-found",
]);

/** The jws compact-serialisation grammar (jws/lib/verify-stream.js:8), with the signature segment required. */
const COMPACT_JWS = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export type CredentialShapeDefect =
  | "not_compact_jws"
  | "header_not_object"
  | "payload_not_object"
  | "alg_not_rs256"
  | "kid_missing"
  | "sub_invalid"
  | "aud_mismatch"
  | "iss_mismatch"
  | "exp_invalid"
  | "iat_invalid"
  | "auth_time_invalid"
  | "expired";

/** What pre-validation proved about the bytes. `sub` is the uid the SDK will return for them. */
export type PrevalidatedCredential = Readonly<{ sub: string; exp: number; iat: number; authTime: number }>;

export type PrevalidationResult = { ok: true; value: PrevalidatedCredential } | { ok: false; defect: CredentialShapeDefect };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Structural pre-validation. TOTAL: never throws, never performs I/O, reads no
 * environment. `nowSeconds` is injected so the expiry rule is testable.
 */
export function prevalidateCredential(raw: unknown, kind: CredentialKind, projectId: string, nowSeconds: number): PrevalidationResult {
  if (typeof raw !== "string") return { ok: false, defect: "not_compact_jws" };
  const match = COMPACT_JWS.exec(raw);
  if (!match) return { ok: false, defect: "not_compact_jws" };
  const header = decodeJsonSegment(match[1]);
  if (!header) return { ok: false, defect: "header_not_object" };
  const payload = decodeJsonSegment(match[2]);
  if (!payload) return { ok: false, defect: "payload_not_object" };

  if (header.alg !== SDK_ALGORITHM) return { ok: false, defect: "alg_not_rs256" };
  if (typeof header.kid !== "string" || header.kid === "") return { ok: false, defect: "kid_missing" };

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > SDK_UID_MAX_LENGTH) return { ok: false, defect: "sub_invalid" };
  // `aud` must be the exact project id string: an array, another string or a
  // non-string all fail. (token-verifier.js:218 compares with `!==`.)
  if (typeof projectId !== "string" || projectId === "" || payload.aud !== projectId) return { ok: false, defect: "aud_mismatch" };
  if (payload.iss !== EXPECTED_ISSUER_PREFIX[kind] + projectId) return { ok: false, defect: "iss_mismatch" };

  const exp = payload.exp;
  if (!finiteNumber(exp)) return { ok: false, defect: "exp_invalid" };
  const iat = payload.iat;
  if (!finiteNumber(iat)) return { ok: false, defect: "iat_invalid" };
  const authTime = payload.auth_time;
  if (!finiteNumber(authTime)) return { ok: false, defect: "auth_time_invalid" };
  // jsonwebtoken/verify.js:189 — `clockTimestamp >= payload.exp` is expired (tolerance 0).
  if (!finiteNumber(nowSeconds) || nowSeconds >= exp) return { ok: false, defect: "expired" };

  return { ok: true, value: Object.freeze({ sub, exp, iat, authTime }) };
}

export function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function errorMessageOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

export type VerificationFailureClass = "credential" | "unavailable";

/**
 * Classifies an error thrown by `verifyIdToken` / `verifySessionCookie` for a
 * credential that PASSED `prevalidateCredential`. The `proof` parameter is
 * the type-level requirement that pre-validation happened: without it the
 * default below would be reachable by caller-controlled bytes.
 *
 *   - a code in SDK_CREDENTIAL_ERROR_CODES            → credential
 *   - `auth/argument-error` with a pinned fixed text  → credential
 *   - `auth/argument-error` with any other text       → unavailable (key fetch; A-2)
 *   - any other code, or no code at all               → unavailable (SP-2)
 */
export function classifyVerificationFailure(proof: PrevalidatedCredential, err: unknown, kind: CredentialKind): VerificationFailureClass {
  if (!proof || typeof proof.sub !== "string") return "unavailable";
  const code = errorCodeOf(err);
  if (SDK_CREDENTIAL_ERROR_CODES.has(code)) return "credential";
  if (code === SDK_ARGUMENT_ERROR_CODE) {
    const message = errorMessageOf(err);
    const name = SDK_JWT_NAME[kind];
    // The three pinned fixed texts, each as the full prefix the SDK emits for this credential kind.
    const credentialPrefixes = [
      SDK_CREDENTIAL_DECODE_FAILED.prefix + name + SDK_CREDENTIAL_DECODE_FAILED.suffix,
      ...SDK_CREDENTIAL_ARGUMENT_ERROR_SUFFIXES.map((suffix) => name + suffix),
    ];
    return credentialPrefixes.some((prefix) => message.startsWith(prefix)) ? "credential" : "unavailable";
  }
  return "unavailable";
}

export type AdaptedVerification =
  | { kind: "rejected_shape"; defect: CredentialShapeDefect }
  | { kind: "verified"; proof: PrevalidatedCredential; decoded: unknown }
  | { kind: "credential_error"; errorCode: string }
  | { kind: "unavailable"; errorCode: string };

/**
 * The composed step the guard calls: pre-validate, THEN verify, THEN classify.
 * The SDK call is injected so the guard's single Admin SDK dependency stays in
 * the guard. Never throws for a throwing `verify`; a throwing `verify` is
 * classified, not propagated.
 */
export async function verifyPrevalidatedCredential(
  kind: CredentialKind,
  raw: unknown,
  projectId: string,
  nowSeconds: number,
  verify: (raw: string) => Promise<unknown>
): Promise<AdaptedVerification> {
  const pre = prevalidateCredential(raw, kind, projectId, nowSeconds);
  if (!pre.ok) return { kind: "rejected_shape", defect: pre.defect };
  try {
    const decoded = await verify(raw as string);
    return { kind: "verified", proof: pre.value, decoded };
  } catch (err) {
    const errorCode = errorCodeOf(err) || "no_error_code";
    return classifyVerificationFailure(pre.value, err, kind) === "credential"
      ? { kind: "credential_error", errorCode }
      : { kind: "unavailable", errorCode };
  }
}
