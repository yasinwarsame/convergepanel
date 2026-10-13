/**
 * Order 5 — Provider Search Evidence: URL validation and the deterministic
 * credential screen for provider-returned search-result URLs. PURE: no I/O,
 * no environment, no logging, never throws, never returns or rewrites a URL.
 *
 * Owner privacy ruling: a URL that looks like it carries credentials or
 * secret-bearing material drops the WHOLE search-result entry from future
 * capture eligibility. Nothing is stripped or repaired; the screen only
 * answers "keep" or "drop" (with a closed reason category).
 *
 * The screen is signal-based, not entropy-based. It drops on strong,
 * explicit credential signals only:
 *   - userinfo (`user:pass@`);
 *   - credential-oriented parameter NAMES (access/id/refresh tokens, api /
 *     access / secret / private keys, authorization, credentials, secrets,
 *     passwords, signatures, session ids, signed-URL fields such as
 *     `X-Amz-*`, `X-Goog-*`, Azure SAS `sig`, CloudFront `Signature`), in the
 *     query (split on `&` and `;`), in `;matrix` path parameters, and in
 *     `name=value` path segments;
 *   - JWT-shaped values (query value, path segment, fragment piece);
 *   - explicit credential prefixes (`Bearer <token>`, `Basic <token>`,
 *     `sk_live_`, `ghp_`, `AKIA…`, `AIza…`, `xoxb-`, `glpat-`, …);
 *   - credential markers in a fragment (`#access_token=`, `#token=`, …);
 *   - known credential-in-path webhook hosts (Slack/Discord/Telegram/…);
 *   - the same rules once inside a nested URL query value (`?next=…`).
 * It deliberately does NOT drop a URL merely because a path segment or value
 * is long, hexadecimal, numeric, a UUID or otherwise high-entropy, nor for
 * malformed percent-encoding: false removal of ordinary source URLs is itself
 * a governance defect. Accepted residuals: opaque tokens under non-credential
 * names or bare in a path, OAuth `?code=` values (ambiguous name), names
 * nested two URL levels deep.
 *
 * Decoding is lenient and total: maximal `%XX` runs that form valid UTF-8 are
 * decoded; anything else keeps its literal text, except that encoded ASCII
 * bytes are always decoded (so `%61ccess_token` is still a credential name).
 * Names are compared case-insensitively after removing control / zero-width
 * characters and mapping `.`, `+` and whitespace to `_`.
 */

/** Serialized-URL byte ceiling (UTF-8) for a usable search-result URL. */
export const SEARCH_RESULT_URL_MAX_BYTES = 512;

export type UrlScreenOutcome =
  | { kind: "usable" }
  | { kind: "invalid" }
  | { kind: "over_limit" }
  | { kind: "privacy_dropped"; signal: PrivacySignal };

export type PrivacySignal =
  | "userinfo"
  | "credential_query_name"
  | "credential_value"
  | "credential_fragment"
  | "credential_path"
  | "credential_host"
  | "screen_error";

/** Always-credential parameter names (after normalization). */
const CREDENTIAL_NAMES = new Set([
  "access_token",
  "id_token",
  "refresh_token",
  "token",
  "auth",
  "authorization",
  "bearer",
  "api_key",
  "apikey",
  "api-key",
  "credential",
  "credentials",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "pwd",
  "sessionid",
  "session_id",
  "phpsessid",
  "jsessionid",
  "jwt",
  "signature",
  "sig",
  "awsaccesskeyid",
  "googleaccessid",
  "key-pair-id",
  "x-api-key",
]);

/** Pagination / cursor names that end in "token" but carry no credential. */
const NON_CREDENTIAL_TOKEN_NAMES = /^(page|next|next_page|nextpage|continuation|sync|cursor)[_-]?token$/;

const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /^x-amz-[a-z0-9-]+$/, // S3 presigned / SigV4
  /^x-goog-[a-z0-9-]+$/, // GCS signed URLs
  /^oauth_[a-z0-9_]+$/, // OAuth 1.0 parameters
  /^aspsessionid[a-z0-9]*$/,
  // Separated suffix family: reset_token, auth_token, private_token, x-api-key …
  /(^|[_-])(token|secret|signature|password|passwd|api[_-]?key|apikey)$/,
  // Key family: access_key, secret_key, private_key, accessKeyId, auth_key … (no bare `_key` suffix: sort_key, designer_key stay)
  /^(access|secret|private|auth|signing|client|master|account|api)[_-]?key(_?id)?$/,
  // camelCase credential names (lower-cased here): accessToken, authToken, clientSecret …
  /^(access|auth|api|id|refresh|bearer|session|private|client|reset|security)(token|secret)$/,
];

/** Fully-matching JWT (three base64url parts). */
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** `Bearer`/`Basic` followed by a token68-shaped credential (the whole value). Prose such as "Bearer authentication explained" never matches. */
const AUTH_SCHEME = /^(bearer|basic)\s+([A-Za-z0-9\-._~+/]{8,}=*)$/i;

function looksLikeToken68(token: string): boolean {
  if (/[0-9=+/]/.test(token)) return true;
  // Mixed-case opaque token (e.g. base64 "dXNlcjpwYXNz"): at least two lower→upper transitions.
  let transitions = 0;
  for (let i = 1; i < token.length; i++) if (/[a-z]/.test(token[i - 1]) && /[A-Z]/.test(token[i])) transitions += 1;
  return transitions >= 2;
}

/** Explicit credential prefixes, anchored at the start of a tested unit. */
const CREDENTIAL_PREFIXES: readonly RegExp[] = [
  /^(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/,
  /^whsec_[A-Za-z0-9]{10,}/,
  /^sk-(proj|ant)-[A-Za-z0-9_-]{40,}/,
  /^sk-[A-Za-z0-9]{20,}/,
  /^github_pat_[A-Za-z0-9_]{10,}/,
  /^gh[pousr]_[A-Za-z0-9]{30,}/,
  /^xox[abpr]-[A-Za-z0-9-]{10,}/,
  /^(AKIA|ASIA)[A-Z0-9]{16}$/,
  /^AIza[0-9A-Za-z_-]{35}$/,
  /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
  /^glpat-[A-Za-z0-9_-]{20,}/,
];

/** Hosts whose URLs carry the credential in the path (host or any subdomain), with the path prefix that does. */
const CREDENTIAL_HOSTS: ReadonlyArray<{ host: string; pathPrefix: RegExp }> = [
  { host: "hooks.slack.com", pathPrefix: /^\/(services|workflows|triggers)\// },
  { host: "discord.com", pathPrefix: /^\/api\/webhooks\// },
  { host: "discordapp.com", pathPrefix: /^\/api\/webhooks\// },
  { host: "api.telegram.org", pathPrefix: /^\/bot/ },
  { host: "outlook.office.com", pathPrefix: /^\/webhook\// },
  { host: "hooks.zapier.com", pathPrefix: /^\/hooks\/catch\// },
  { host: "maker.ifttt.com", pathPrefix: /\/key\// },
];

/** Lenient, total percent-decoding (see module doc). */
function decode(part: string): string {
  return part.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
        const byte = parseInt(hex, 16);
        return byte < 0x80 ? String.fromCharCode(byte) : escape;
      });
    }
  });
}

function normalizeName(rawName: string): string {
  return rawName
    .replace(/[\u0000-\u001f\u007f​-‏⁠﻿]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.+\s]+/g, "_");
}

function isCredentialName(rawName: string): boolean {
  const name = normalizeName(rawName);
  if (name.length === 0) return false;
  if (CREDENTIAL_NAMES.has(name)) return true;
  if (NON_CREDENTIAL_TOKEN_NAMES.test(name)) return false;
  return CREDENTIAL_NAME_PATTERNS.some((re) => re.test(name));
}

/** A value is credential-shaped if it (with `+` read as a space, too) is an auth-scheme credential, or it or any sub-token is a JWT or carries an explicit credential prefix. */
function isCredentialValue(value: string): boolean {
  for (const variant of new Set([value.trim(), value.replace(/\+/g, " ").trim()])) {
    const scheme = AUTH_SCHEME.exec(variant);
    if (scheme && looksLikeToken68(scheme[2])) return true;
  }
  const units = new Set<string>([value.trim()]);
  for (const piece of value.split(/[^A-Za-z0-9_.-]+/)) if (piece) units.add(piece);
  for (const piece of value.split(/[^A-Za-z0-9_-]+/)) if (piece) units.add(piece);
  for (const unit of Array.from(units)) {
    if (JWT.test(unit)) return true;
    if (CREDENTIAL_PREFIXES.some((re) => re.test(unit))) return true;
  }
  return false;
}

function hostMatches(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

/** `name=value` pairs separated by `&` or `;`, each part decoded. */
function splitPairs(raw: string): Array<{ name: string; value: string | null }> {
  if (raw.length === 0) return [];
  return raw.split(/[&;]/).map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1 ? { name: decode(pair), value: null } : { name: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) };
  });
}

function screenPairs(raw: string, nested: boolean, nameSignal: PrivacySignal, valueSignal: PrivacySignal): PrivacySignal | null {
  for (const { name, value } of splitPairs(raw)) {
    if (value === null) continue;
    if (isCredentialName(name)) return nameSignal;
    if (isCredentialValue(value)) return valueSignal;
    if (!nested && /^(https?:\/\/|\/|\?)/i.test(value)) {
      const inner = screenNestedValue(value);
      if (inner) return inner;
    }
  }
  return null;
}

/** Screens query, fragment and path of an already-parsed URL. `nested` limits recursion to one level. */
function screenParts(url: URL, nested: boolean): PrivacySignal | null {
  for (const { host, pathPrefix } of CREDENTIAL_HOSTS) {
    if (hostMatches(url.hostname.toLowerCase(), host) && pathPrefix.test(url.pathname)) return "credential_host";
  }

  const search = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const querySignal = screenPairs(search, nested, "credential_query_name", "credential_value");
  if (querySignal) return querySignal;

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment.length > 0) {
    const decoded = decode(fragment);
    // Credential names in `name=value` fragment pairs (`#access_token=…`). A text fragment
    // (`#:~:text=…`) only ever has the names `:~:text` / `text`, so it is never dropped by name.
    for (const { name, value } of splitPairs(decoded.replace(/^[?/]+/, ""))) {
      if (value !== null && isCredentialName(name)) return "credential_fragment";
    }
    if (isCredentialValue(decoded)) return "credential_fragment";
    for (const piece of decoded.split(/[&=/?;]/)) {
      if (piece && isCredentialValue(piece)) return "credential_fragment";
    }
  }

  for (const rawSegment of url.pathname.split("/")) {
    if (!rawSegment) continue;
    const [head, ...params] = rawSegment.split(";");
    const segment = decode(head);
    if (isCredentialValue(segment)) return "credential_path";
    // `name=value` path segments (e.g. /access_token=abc/) and `;matrix` parameters.
    const pairSignal = screenPairs([segment.includes("=") ? segment : "", ...params].filter(Boolean).join(";"), true, "credential_path", "credential_path");
    if (pairSignal) return pairSignal;
    for (const param of params) {
      const name = decode(param.split("=")[0]);
      if (isCredentialName(name)) return "credential_path";
    }
  }
  return null;
}

/** A nested URL/path carried in a query value (e.g. `?next=/reset?token=…`), screened once with the same query/fragment/path rules. */
function screenNestedValue(value: string): PrivacySignal | null {
  let inner: URL;
  try {
    inner = new URL(value, "https://nested.invalid");
  } catch {
    return null; // not a URL: already tested as a value
  }
  return screenParts(inner, true);
}

/**
 * Classify one provider-returned `url` value. Never throws. Exactly one
 * outcome per value, tested in this order: invalid → over_limit →
 * privacy_dropped → usable.
 */
export function screenSearchResultUrl(raw: unknown): UrlScreenOutcome {
  if (typeof raw !== "string" || raw.length === 0) return { kind: "invalid" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
  if (url.hostname.length === 0) return { kind: "invalid" };
  if (Buffer.byteLength(url.href, "utf8") > SEARCH_RESULT_URL_MAX_BYTES) return { kind: "over_limit" };
  if (url.username !== "" || url.password !== "") return { kind: "privacy_dropped", signal: "userinfo" };
  try {
    const signal = screenParts(url, false);
    return signal ? { kind: "privacy_dropped", signal } : { kind: "usable" };
  } catch {
    // Decoding is total, so this is only reachable through an unforeseen runtime error: fail closed.
    return { kind: "privacy_dropped", signal: "screen_error" };
  }
}
