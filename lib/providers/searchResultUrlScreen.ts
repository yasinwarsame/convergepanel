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
 *   - credential-oriented query parameter NAMES (access/id/refresh tokens,
 *     api keys, authorization, secrets, passwords, signatures, session ids,
 *     signed-URL fields such as `X-Amz-*`, `X-Goog-*`, Azure SAS `sig`,
 *     CloudFront `Signature`), also inside `;matrix` path parameters;
 *   - JWT-shaped values (query value, path segment, fragment piece);
 *   - explicit credential prefixes (`Bearer …`, `sk_live_`, `ghp_`, `AKIA…`,
 *     `AIza…`, `xoxb-`, `glpat-`, …);
 *   - credential markers in a fragment (`#access_token=`, `#token=`, …);
 *   - known credential-in-path webhook hosts (Slack/Discord/Telegram/…);
 *   - the same rules once inside a nested URL query value (`?next=…`).
 * It deliberately does NOT drop a URL merely because a path segment or value
 * is long, hexadecimal, numeric, a UUID or otherwise high-entropy: false
 * removal of ordinary source URLs (content ids, commit SHAs, article ids,
 * Google Docs ids) is itself a governance defect. Accepted residual: opaque
 * tokens carried under non-credential names or bare in a path pass the
 * screen (these are public web-search results).
 *
 * Decoding: query strings are split raw on `&` and the first `=`, then each
 * part is `decodeURIComponent`-decoded (`+` is never translated; no
 * URLSearchParams). A decoding error fails closed (drop, `decode_error`).
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
  | "decode_error";

/** Always-credential query/matrix parameter names (case-insensitive, decoded). */
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

const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /^x-amz-[a-z0-9-]+$/, // S3 presigned / SigV4
  /^x-goog-[a-z0-9-]+$/, // GCS signed URLs
  /^oauth_[a-z0-9_]+$/, // OAuth 1.0 parameters
  /^aspsessionid[a-z0-9]*$/,
  // Separated suffix family: reset_token, auth_token, private_token, x-api-key …
  /(^|[_-])(token|secret|signature|password|passwd|api[_-]?key|apikey)$/,
  // camelCase credential names (lower-cased here): accessToken, authToken, apiKey, clientSecret …
  /^(access|auth|api|id|refresh|bearer|session|private|client|reset|security)(token|secret|key)$/,
];

/** Fully-matching JWT (three base64url parts). */
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** Explicit credential prefixes, anchored at the start of a tested unit. */
const CREDENTIAL_PREFIXES: readonly RegExp[] = [
  /^bearer\s+\S{8,}/i,
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

/** Credential markers inside a fragment (case-insensitive). */
const FRAGMENT_MARKERS = /(^|[&#?;/])(access_token|id_token|refresh_token|token|code|api_key|apikey|auth)=/i;

/** A Chrome text fragment (`#:~:text=…`) — exempt from the fragment marker rule, but its pieces are still tested. */
const TEXT_FRAGMENT = /^:~:text=[^&]*(&text=[^&]*)*$/;

class DecodeError extends Error {}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new DecodeError();
  }
}

function isCredentialName(rawName: string): boolean {
  const name = rawName.trim().toLowerCase();
  if (name.length === 0) return false;
  if (CREDENTIAL_NAMES.has(name)) return true;
  return CREDENTIAL_NAME_PATTERNS.some((re) => re.test(name));
}

/** A value (or path segment / fragment piece) is credential-shaped if it, or any of its sub-tokens, is a JWT or carries an explicit credential prefix. */
function isCredentialValue(value: string): boolean {
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

function splitQuery(search: string): Array<{ name: string; value: string | null }> {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw.length === 0) return [];
  return raw.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1 ? { name: decode(pair), value: null } : { name: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) };
  });
}

/** Screens query, fragment and path of an already-parsed URL. `nested` limits recursion to one level. */
function screenParts(url: URL, nested: boolean): PrivacySignal | null {
  for (const { host, pathPrefix } of CREDENTIAL_HOSTS) {
    if (hostMatches(url.hostname.toLowerCase(), host) && pathPrefix.test(url.pathname)) return "credential_host";
  }

  for (const { name, value } of splitQuery(url.search)) {
    if (isCredentialName(name)) return "credential_query_name";
    if (value === null) continue;
    if (isCredentialValue(value)) return "credential_value";
    if (!nested && /^(https?:\/\/|\/|\?)/i.test(value)) {
      const inner = screenNestedValue(value);
      if (inner) return inner;
    }
  }

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment.length > 0) {
    const decoded = decode(fragment);
    if (!TEXT_FRAGMENT.test(decoded) && FRAGMENT_MARKERS.test(decoded)) return "credential_fragment";
    for (const piece of decoded.split(/[&=/?;]/)) {
      if (piece && isCredentialValue(piece)) return "credential_fragment";
    }
  }

  for (const rawSegment of url.pathname.split("/")) {
    if (!rawSegment) continue;
    const [head, ...params] = rawSegment.split(";");
    const segment = decode(head);
    if (isCredentialValue(segment)) return "credential_path";
    for (const param of params) {
      const eq = param.indexOf("=");
      const name = decode(eq === -1 ? param : param.slice(0, eq));
      if (isCredentialName(name)) return "credential_path";
      if (eq !== -1 && isCredentialValue(decode(param.slice(eq + 1)))) return "credential_path";
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
    // DecodeError (malformed percent-encoding) — or anything unexpected — fails closed.
    return { kind: "privacy_dropped", signal: "decode_error" };
  }
}
