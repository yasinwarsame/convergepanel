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
 * The screen is deterministic and signal-based (high-confidence signals,
 * fail-closed where specified), never entropy-based. It drops on:
 *   - userinfo (`user:pass@`, `:pass@`);
 *   - credential-oriented parameter NAMES with a non-empty value: an exact
 *     list (token, access_token, api_key, secret, password, pass, pw, pwd,
 *     sid, sessionid, signature, sig, credential(s), …), signed-URL families
 *     (`X-Amz-*`, `X-Goog-*`, `oauth_*`), and bounded qualifier+noun
 *     families (accessToken, clientSecret, x-api-key, accessKeyId,
 *     userPassword …) — never an open-ended suffix, so designToken,
 *     timeSignature, forgotPassword stay. Checked in the query (`&`/`;`),
 *     `name=value` path segments, `;matrix` parameters and fragment pairs;
 *     bracketed names are tested part by part; a bare `auth` counts only with
 *     a token-shaped value; the ambiguous `key` and `code` never count by name;
 *   - credential VALUE syntax: JWTs, known secret prefixes (`sk_live_`,
 *     `ghp_`, `AKIA…`, `AIza…`, `xoxb-`, `glpat-` …), and `Bearer|Basic|Token`
 *     (optionally `Scheme:`) followed by a payload with credential syntax
 *     (JWT, known prefix, token68 punctuation/padding, or Basic base64 of
 *     `user:password`) — never "contains a digit";
 *   - credential path CONTEXT: `/reset-password/<v>`, `/access-token/<v>` …
 *     with a non-empty, non-slug next segment;
 *   - host-specific webhook paths (Slack, Discord incl. `/api/vN/webhooks/`,
 *     Telegram, Outlook, Zapier, IFTTT), host compared with one trailing
 *     DNS dot removed;
 *   - the same rules once inside a clearly URL-like nested query value
 *     (absolute, protocol-relative, relative, query-relative, scheme-less
 *     `host.tld/…`), except for search-text parameters (`q`, `query`, …).
 * It deliberately does NOT drop for long, hexadecimal, numeric, UUID or
 * otherwise high-entropy ids, nor for malformed percent-encoding: false
 * removal of ordinary source URLs is itself a governance defect. Accepted
 * residuals: opaque tokens without credential syntax under non-credential
 * names or bare in a path (incl. opaque `Bearer <hex>`), OAuth `?code=`,
 * generic `?key=` values, names nested two URL levels deep, confusable
 * (non-NFKC) look-alike characters.
 *
 * Decoding is lenient and total: maximal `%XX` runs that form valid UTF-8 are
 * decoded; anything else keeps its literal text, except that encoded ASCII
 * bytes are always decoded. Names are compared after NFKC normalization,
 * removal of control / zero-width / soft-hyphen characters, case-folding and
 * mapping `.`, `+` and whitespace to `_`. A raw value above
 * SEARCH_RESULT_URL_MAX_PROCESSING_BYTES is `over_limit` without inspection.
 */

/** Serialized-URL byte ceiling (UTF-8) for a usable search-result URL. */
export const SEARCH_RESULT_URL_MAX_BYTES = 512;

/**
 * Processing-safety ceiling (UTF-8 bytes of the raw provider string), well
 * above realistic signed URLs (a few KB). A URL beyond it is classified
 * `over_limit` without parsing or privacy inspection, so a pathological
 * provider value cannot cause disproportionate work. URLs between 512 bytes
 * and this ceiling are still privacy-screened first.
 */
export const SEARCH_RESULT_URL_MAX_PROCESSING_BYTES = 16_384;

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
  "pass",
  "pw",
  "sid",
  "sessionid",
  "session_id",
  "sessionkey",
  "session_key",
  "sastoken",
  "sas_token",
  "sharedaccesssignature",
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

/**
 * Bounded, high-confidence credential-name FAMILIES — a credential-oriented
 * qualifier joined (with or without `_`/`-`, any case) to a credential noun.
 * There is deliberately no open-ended suffix rule: an ordinary word that
 * merely ends in token/secret/password/signature (designToken, cryptoToken,
 * timeSignature, forgotPassword, topSecret …) is not a credential name.
 */
const CREDENTIAL_QUALIFIERS =
  "access|auth|api|id|refresh|bearer|session|private|client|reset|security|sas|oauth|csrf|xsrf|user|app|admin|account|master|secret|signing|personal|service|login|magic|invite|verification|confirmation|upload|download|share";
const CREDENTIAL_NOUNS = "token|secret|key|apikey|api_key|signature|sig";
/** Password nouns only with an account-holder qualifier (userPassword, adminPwd …) — never action words (resetPassword=true, forgotPassword=1). */
const PASSWORD_QUALIFIERS = "user|admin|account|login|client|app|db|database|master|root|service|proxy|smtp|ftp";

const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /^x-amz-[a-z0-9-]+$/, // S3 presigned / SigV4
  /^x-goog-[a-z0-9-]+$/, // GCS signed URLs
  /^oauth_[a-z0-9_]+$/, // OAuth 1.0 parameters
  /^aspsessionid[a-z0-9]*$/,
  // qualifier + noun, optional `x-` prefix and `_id` suffix: x-api-key, xApiKey, accessToken, refresh_token,
  // clientSecret, userPassword, sessionKey, auth_key, secret_key, accessKeyId …
  new RegExp(`^(x[_-]?)?(${CREDENTIAL_QUALIFIERS})[_-]?(${CREDENTIAL_NOUNS})([_-]?id)?$`),
  new RegExp(`^(${PASSWORD_QUALIFIERS})[_-]?(password|passwd|pwd|pass|pw)$`),
  // Vendor access-key ids: AWSAccessKeyId, OSSAccessKeyId, accessKeyId …
  /^([a-z0-9]{1,8}[_-]?)?access[_-]?key[_-]?id$/,
];

/**
 * Names that are credentials only together with a token-shaped value: `auth`
 * is also used for ordinary flags (NYT share links: `?auth=login-email`).
 */
const TOKEN_VALUE_ONLY_NAMES = new Set(["auth"]);

/**
 * A token-shaped value in a credential-named context: ≥ 16 token characters,
 * not a plain word / slug, mixing at least two of lower-case, upper-case and
 * digits. Used only together with a credential-oriented NAME — never alone.
 */
function isTokenShapedValue(value: string): boolean {
  if (!/^[A-Za-z0-9._~+/=-]{16,}$/.test(value)) return false;
  if (/^[a-z]+([-_.][a-z]+)*$/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2;
}

/** Fully-matching JWT (three base64url parts). */
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** `Bearer`/`Basic`/`Token` scheme (optionally `Scheme:`) followed by a single token68-charset payload (the whole value). */
const AUTH_SCHEME = /^(bearer|basic|token)(?:\s*:\s*|\s+)([A-Za-z0-9\-._~+/]{8,}=*)$/i;

/**
 * Is an auth-scheme payload credential SYNTAX (never "contains a digit")?
 * - a JWT or a known secret prefix;
 * - token68 punctuation or base64 padding (`+`, `/`, trailing `=`);
 * - for `Basic`: it base64-decodes to printable `user:password` text.
 * An opaque payload with none of these (e.g. "authentication2") is not
 * treated as a credential — an accepted residual for opaque bearer tokens.
 */
function isAuthSchemeCredential(scheme: string, payload: string): boolean {
  if (JWT.test(payload) || CREDENTIAL_PREFIXES.some((re) => re.test(payload))) return true;
  if (/[+/]/.test(payload) || /=+$/.test(payload)) return true;
  if (scheme.toLowerCase() === "basic" && /^[A-Za-z0-9+/]+={0,2}$/.test(payload) && payload.length % 4 === 0) {
    const decoded = Buffer.from(payload, "base64").toString("latin1");
    return /^[\x20-\x7e]+:[\x20-\x7e]*$/.test(decoded);
  }
  return false;
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
  { host: "discord.com", pathPrefix: /^\/api\/(v\d{1,3}\/)?webhooks\// },
  { host: "discordapp.com", pathPrefix: /^\/api\/(v\d{1,3}\/)?webhooks\// },
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
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2060\ufeff]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.+\s]+/g, "_");
}

function isCredentialName(rawName: string): boolean {
  // Bracketed names (`access_token[]`, `access_token[0]`, `data[access_token]`): test each part.
  if (/[[\]]/.test(rawName)) return rawName.split(/[[\]]+/).some((part) => part.length > 0 && isCredentialName(part));
  const name = normalizeName(rawName);
  if (name.length === 0) return false;
  if (CREDENTIAL_NAMES.has(name)) return true;
  return CREDENTIAL_NAME_PATTERNS.some((re) => re.test(name));
}

/** A value is credential-shaped if it (with `+` read as a space, too) is an auth-scheme credential, or it or any sub-token is a JWT or carries an explicit credential prefix. */
function isCredentialValue(value: string): boolean {
  for (const variant of new Set([value.trim(), value.replace(/\+/g, " ").trim()])) {
    const scheme = AUTH_SCHEME.exec(variant);
    if (scheme && isAuthSchemeCredential(scheme[1], scheme[2])) return true;
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

/** Host-specific match; the hostname is compared case-insensitively with ONE trailing DNS root dot removed (`discord.com.` ≡ `discord.com`). Comparison only — the URL is never rewritten. */
function hostMatches(hostname: string, host: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === host || h.endsWith(`.${host}`);
}

/** Search-query parameters: their values are free text typed by a person, never parsed as nested URLs (`?q=/api/v1?token=…` is a search, not a link). Value-level credential syntax is still screened. */
const SEARCH_TEXT_NAMES = new Set(["q", "query", "search", "search_query", "keywords", "keyword", "term", "text"]);

/**
 * Is a query value clearly URL-like (and so screened once as a nested URL)?
 * absolute http(s), protocol-relative `//host/…`, relative `/…`,
 * query-relative `?…`, or a scheme-less `host.tld/…` (no whitespace).
 */
function nestedUrlCandidate(value: string): string | null {
  if (/\s/.test(value)) return null;
  if (/^https?:\/\//i.test(value) || /^\/\//.test(value) || /^[/?]/.test(value)) return value;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}(:\d{1,5})?\/\S*$/i.test(value)) return `https://${value}`;
  return null;
}

/**
 * Path segments that explicitly name the FOLLOWING segment as credential-
 * bearing (`/reset-password/<token>`, `/access-token/<value>`). Compared
 * after name normalization with `-` read as `_`.
 */
const CREDENTIAL_PATH_CONTEXT = new Set([
  "access_token",
  "auth_token",
  "session_token",
  "reset_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "reset_password",
  "password_reset",
]);

/** A plain lower-case word or slug (optionally with a page extension) is navigation, not a credential value. */
function isPlainSlug(segment: string): boolean {
  return /^[a-z]+([-_][a-z]+)*(\.(html?|php|aspx?))?$/.test(segment);
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
  for (const pair of splitPairs(raw)) {
    let { name, value } = pair;
    // A name that decoded to `name=value` (e.g. `?access_token%3Dabc`) is re-split.
    if (value === null && name.includes("=")) {
      const eq = name.indexOf("=");
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    // No value, or an empty value, carries no secret.
    if (value === null || value.length === 0) continue;
    if (isCredentialName(name)) return nameSignal;
    if (TOKEN_VALUE_ONLY_NAMES.has(normalizeName(name)) && isTokenShapedValue(value)) return nameSignal;
    if (isCredentialValue(value)) return valueSignal;
    if (!nested && !SEARCH_TEXT_NAMES.has(normalizeName(name))) {
      const candidate = nestedUrlCandidate(value);
      const inner = candidate ? screenNestedValue(candidate) : null;
      if (inner) return inner;
    }
  }
  return null;
}

/** Screens query, fragment and path of an already-parsed URL. `nested` limits recursion to one level. */
function screenParts(url: URL, nested: boolean): PrivacySignal | null {
  for (const { host, pathPrefix } of CREDENTIAL_HOSTS) {
    if (hostMatches(url.hostname, host) && pathPrefix.test(url.pathname)) return "credential_host";
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
      // Same rule as the query: an absent or empty value carries no secret.
      if (value !== null && value.length > 0 && isCredentialName(name)) return "credential_fragment";
    }
    if (isCredentialValue(decoded)) return "credential_fragment";
    for (const piece of decoded.split(/[&=/?;]/)) {
      if (piece && isCredentialValue(piece)) return "credential_fragment";
    }
  }

  const rawSegments = url.pathname.split("/");
  for (let i = 0; i < rawSegments.length; i++) {
    const rawSegment = rawSegments[i];
    if (!rawSegment) continue;
    const [head, ...params] = rawSegment.split(";");
    const segment = decode(head);
    if (isCredentialValue(segment)) return "credential_path";
    // Credential context: `/reset-password/<value>`, `/access-token/<value>` — the next non-empty, non-slug segment.
    if (CREDENTIAL_PATH_CONTEXT.has(normalizeName(segment).replace(/-/g, "_"))) {
      const next = decode((rawSegments[i + 1] ?? "").split(";")[0]);
      if (next.length > 0 && !isPlainSlug(next)) return "credential_path";
    }
    // `name=value` path segments (e.g. /access_token=abc/) and `;matrix` parameters.
    const pairSignal = screenPairs([segment.includes("=") ? segment : "", ...params].filter(Boolean).join(";"), true, "credential_path", "credential_path");
    if (pairSignal) return pairSignal;
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
 * outcome per value, tested in this order: invalid → privacy_dropped →
 * over_limit → usable. Privacy is screened before the size limit so that
 * long signed URLs (S3/GCS presigned links routinely exceed 512 bytes) are
 * counted as privacy drops, not merely as over-limit.
 */
export function screenSearchResultUrl(raw: unknown): UrlScreenOutcome {
  if (typeof raw !== "string" || raw.length === 0) return { kind: "invalid" };
  if (Buffer.byteLength(raw, "utf8") > SEARCH_RESULT_URL_MAX_PROCESSING_BYTES) return { kind: "over_limit" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
  if (url.hostname.length === 0) return { kind: "invalid" };
  if (url.username !== "" || url.password !== "") return { kind: "privacy_dropped", signal: "userinfo" };
  try {
    const signal = screenParts(url, false);
    if (signal) return { kind: "privacy_dropped", signal };
    return Buffer.byteLength(url.href, "utf8") > SEARCH_RESULT_URL_MAX_BYTES ? { kind: "over_limit" } : { kind: "usable" };
  } catch {
    // Decoding is total, so this is only reachable through an unforeseen runtime error: fail closed.
    return { kind: "privacy_dropped", signal: "screen_error" };
  }
}
