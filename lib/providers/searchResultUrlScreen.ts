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
 *     sid, sessionid, signature, sig, hmac, otp, passcode, credential(s), …),
 *     signed-URL families (`X-Amz-*`, `X-Goog-*`, `oauth_*`), and bounded
 *     qualifier+noun families: up to two credential qualifiers + a strong
 *     noun (accessToken, personal_access_token, clientSecret, x-api-key),
 *     the weak nouns `key`/`sig` only after a strong qualifier (auth_key,
 *     secret_key, consumer_key — never masterkey, user_key, appSig),
 *     password nouns only after an account-holder or new/old qualifier
 *     (userPassword, new_password — never resetPassword=true), and vendor
 *     access-key ids. Never an open-ended suffix, so designToken,
 *     timeSignature, forgotPassword stay. Checked in the query (`&`/`;`),
 *     `name=value` path segments, `;matrix` parameters and fragment pairs
 *     (hash routes split on `?` too: `#/reset-password?token=…`);
 *     bracketed names are tested part by part; a bare `auth` counts only with
 *     a token-shaped value; the ambiguous `key` and `code` never count by name;
 *   - credential VALUE syntax: JWTs, known secret prefixes (`sk_live_`,
 *     `ghp_`, `AKIA…`, `AIza…`, `xoxb-`, `glpat-` …), and `Bearer|Basic|Token`
 *     (optionally `Scheme:`) followed by a payload with credential syntax
 *     (JWT, known prefix, token68 punctuation/padding, or Basic base64 of
 *     `user:password`) — never "contains a digit";
 *   - credential path CONTEXT: `/reset-password/<v>`, `/access-token/<v>` …
 *     (URL path or hash route) when the next segment is token-shaped (≥ 8
 *     chars; not a word/slug in any case, version, small number or file name);
 *   - host-specific webhook paths (Slack, Discord incl. `/api/vN/webhooks/`,
 *     Telegram, Outlook, Zapier, IFTTT), host compared with one trailing
 *     DNS dot removed, path compared decoded, slash-collapsed, lower-cased;
 *   - the same rules (userinfo included) once inside a clearly URL-like
 *     nested query value (trimmed; absolute, double-encoded absolute,
 *     protocol-relative, relative, query-relative, scheme-less
 *     `host.tld|localhost|IPv4` followed by `/`, `?` or `#`), except for
 *     search-text parameters (`q`, `query`, …).
 * It deliberately does NOT drop for long, hexadecimal, numeric, UUID or
 * otherwise high-entropy ids, nor for malformed percent-encoding: false
 * removal of ordinary source URLs is itself a governance defect. Accepted
 * residuals: opaque tokens without credential syntax under non-credential
 * names or bare in a path (incl. opaque `Bearer <hex>`), OAuth `?code=`,
 * generic `?key=` values, names nested two URL levels deep, confusable
 * (non-NFKC) look-alike characters, zero-width characters inside VALUES
 * (normalization applies to names only). Accepted false positives: owner-
 * listed names regardless of value (`sid` e.g. Booking, `sig` e.g. Google
 * Books, `private_key=false`).
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
  "hmac",
  "otp",
  "passcode",
  "authenticity_token",
  "csrfmiddlewaretoken",
  "secret_access_key",
  "secretaccesskey",
  "aws_secret_access_key",
  "subscription_key",
  "subscription-key",
  "ocp-apim-subscription-key",
  "connect_sid",
  "asp_net_sessionid",
  "token_secret",
]);

/**
 * Bounded, high-confidence credential-name FAMILIES — a credential-oriented
 * qualifier joined (with or without `_`/`-`, any case) to a credential noun.
 * There is deliberately no open-ended suffix rule: an ordinary word that
 * merely ends in token/secret/password/signature (designToken, cryptoToken,
 * timeSignature, forgotPassword, topSecret …) is not a credential name.
 */
const CREDENTIAL_QUALIFIERS =
  "access|auth|api|id|refresh|bearer|session|private|client|reset|security|sas|oauth|csrf|xsrf|user|app|admin|account|master|secret|signing|personal|service|login|magic|magic_link|invite|verification|verify|confirmation|upload|download|share|consumer|unsubscribe|bot|github|gitlab|hf|slack|webhook|password|invitation|unlock";
/** Strong credential nouns: credential-bearing with any qualifier above (up to two chained: personal_access_token). */
const STRONG_CREDENTIAL_NOUNS = "token|secret|apikey|api_key|signature";
/** Weak nouns (`key`, `sig`) are everyday words (masterkey, user_key, appSig): credential-bearing only with a strong qualifier. */
const STRONG_QUALIFIERS = "access|api|auth|secret|private|signing|client|session|sas|oauth|consumer";
/** Password nouns only with an account-holder or new/old qualifier (userPassword, new_password) — never action words (resetPassword=true, forgotPassword=1). */
const PASSWORD_QUALIFIERS = "user|admin|account|login|client|app|db|database|master|root|service|proxy|smtp|ftp|new|old|current|confirm";

const CREDENTIAL_NAME_PATTERNS: readonly RegExp[] = [
  /^x-amz-[a-z0-9-]+$/, // S3 presigned / SigV4
  /^x-goog-[a-z0-9-]+$/, // GCS signed URLs
  /^oauth_[a-z0-9_]+$/, // OAuth 1.0 parameters
  /^aspsessionid[a-z0-9]*$/,
  // qualifier(s) + strong noun, optional `x-` prefix: x-api-key, xApiKey, accessToken, refresh_token, clientSecret,
  // personal_access_token, magic_link_token, consumer_secret …
  new RegExp(`^(x[_-]?)?((${CREDENTIAL_QUALIFIERS})[_-]?){1,2}(${STRONG_CREDENTIAL_NOUNS})$`),
  // strong qualifier + weak noun: auth_key, secret_key, private_key, consumer_key, sessionKey, oauth_sig …
  new RegExp(`^(x[_-]?)?(${STRONG_QUALIFIERS})[_-]?(key|sig)$`),
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

/**
 * Navigation / prose pieces: every piece is a word optionally followed by
 * digits (`windows11`, `iPhone15`, `Statistics`, `oauth2`) or digits
 * optionally followed by letters (`2fa`, `2024`, `365`). Opaque tokens mix
 * letters and digits inside a piece (`aB3dEfGh`, `6a7b8c9d…`). Syntax, not
 * entropy: a value made only of word-like pieces is never a credential by
 * shape alone.
 */
function allPiecesWordLike(value: string, separators: RegExp): boolean {
  const pieces = value.split(separators).filter((p) => p.length > 0);
  return pieces.length > 0 && pieces.every((p) => /^[A-Za-z]+[0-9]*$/.test(p) || /^[0-9]+[A-Za-z]*$/.test(p));
}

/** Fully-matching JWT (three base64url parts). */
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/** `Bearer`/`Basic`/`Token` scheme (optionally `Scheme:`) followed by a single token68 payload that starts with an alphanumeric/`-._~` character (never `+` or `/`, which are form-encoded spaces and path separators in prose). */
const AUTH_SCHEME = /^(bearer|basic|token)(?:\s*:\s*|\s+)([A-Za-z0-9\-._~][A-Za-z0-9\-._~+/]{7,}=*)$/i;

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
  // Base64 padding.
  if (/[A-Za-z0-9]={1,2}$/.test(payload)) return true;
  // Interior token68 punctuation only inside a long, mixed-class payload ("chemistry/biology" stays prose).
  // Interior token68 punctuation only inside a long, mixed-class payload that is not word-like prose
  // ("Statistics/Probability", "COVID19/Vaccines" stay prose).
  if (/[A-Za-z0-9][+/][A-Za-z0-9]/.test(payload) && payload.length >= 16 && !allPiecesWordLike(payload, /[+/]/)) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(payload)).length;
    if (classes >= 2) return true;
  }
  if (scheme.toLowerCase() === "basic" && /^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
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
  /^(AKIA|ASIA)(?=[A-Z0-9]*[0-9])[A-Z0-9]{16}$/,
  /^ya29\.[A-Za-z0-9_-]{20,}/, // Google OAuth access token
  /^AIza[0-9A-Za-z_-]{35}$/,
  /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/,
  /^glpat-[A-Za-z0-9_-]{20,}/,
];

/** Hosts whose URLs carry the credential in the path (host or any subdomain), with the path prefix that does. */
const CREDENTIAL_HOSTS: ReadonlyArray<{ host: string; pathPrefix: RegExp }> = [
  { host: "hooks.slack.com", pathPrefix: /^\/(services|workflows|triggers)\// },
  { host: "discord.com", pathPrefix: /^\/api\/(v\d{1,3}\/)?webhooks\// },
  { host: "discordapp.com", pathPrefix: /^\/api\/(v\d{1,3}\/)?webhooks\// },
  { host: "api.telegram.org", pathPrefix: /^\/(file\/)?bot/ },
  { host: "outlook.office.com", pathPrefix: /^\/webhook\// },
  { host: "webhook.office.com", pathPrefix: /^\/webhookb2\// },
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
    .replace(/[.+\s_]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
    // The scheme may start the value or follow a delimiter (`Authorization: Bearer …`, `"Bearer …"`, `(Bearer …)`).
    const starts = [0];
    for (const m of variant.matchAll(/[\s:("'=](?=(bearer|basic|token)\b)/gi)) starts.push((m.index ?? 0) + 1);
    for (const start of starts) {
      const candidate = variant.slice(start).replace(/["')\]]+$/, "").trim();
      const scheme = AUTH_SCHEME.exec(candidate);
      if (scheme && isAuthSchemeCredential(scheme[1], scheme[2])) return true;
    }
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
  const h = hostname.toLowerCase().replace(/\.+$/, "");
  return h === host || h.endsWith(`.${host}`);
}

/** Search-query parameters: their values are free text typed by a person, never parsed as nested URLs (`?q=/api/v1?token=…` is a search, not a link). Value-level credential syntax is still screened. */
const SEARCH_TEXT_NAMES = new Set(["q", "query", "search", "search_query", "keywords", "keyword", "term", "text"]);

/**
 * Is a query value clearly URL-like (and so screened once as a nested URL)?
 * absolute http(s), protocol-relative `//host/…`, relative `/…`,
 * query-relative `?…`, or a scheme-less `host.tld/…` (no whitespace).
 */
function nestedUrlCandidate(rawValue: string): string | null {
  let value = rawValue.trim();
  // One extra decode for a double-encoded absolute URL (`https%3A%2F%2F…`).
  if (/^https?%3A/i.test(value)) value = decode(value).trim();
  if (/\s/.test(value)) return null;
  if (/^https?:\/\//i.test(value) || /^\/\//.test(value) || /^[/?]/.test(value)) return value;
  // Other absolute schemes (`ftp://user:pass@…`) and scheme-less userinfo (`user:pass@host/…`).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^[^\s/@:]+:[^\s/@]*@[a-z0-9.-]+/i.test(value)) return `https://${value}`;
  if (/^([a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}|localhost|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?[/?#]\S*$/i.test(value)) return `https://${value}`;
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

/**
 * Is the segment after a credential path context a credential-bearing value?
 * Navigation is excluded: words or slugs in any case, version strings
 * (`v2`, `0.1.2`), small numbers (pagination) and file names. What remains —
 * ≥ 8 token characters such as a UUID, hex or opaque token — is the value.
 */
function isCredentialPathCandidate(segment: string): boolean {
  if (segment.length < 8) return false;
  if (!/^[A-Za-z0-9._~+=-]+$/.test(segment)) return false;
  // UUIDs and long hex are the canonical reset / access token forms.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
  // Navigation: slugs, versions, dates and file names made only of word-like pieces
  // (`windows11`, `office-365`, `oauth2-authorization-code`, `2024-01-15`, `index.md`).
  if (allPiecesWordLike(segment, /[-_.~]/)) return false;
  return true;
}

/** Credential path context in a `/`-separated path (URL path or hash-route fragment). */
function screenPathContext(rawSegments: readonly string[]): boolean {
  const seg = (i: number) => decode((rawSegments[i] ?? "").split(";")[0]);
  for (let i = 0; i < rawSegments.length - 1; i++) {
    const key = normalizeName(seg(i)).replace(/-/g, "_");
    if (CREDENTIAL_PATH_CONTEXT.has(key) && isCredentialPathCandidate(seg(i + 1))) return true;
    // Two-segment context: `/password/reset/<token>` (Laravel default).
    if (key === "password" && normalizeName(seg(i + 1)) === "reset" && isCredentialPathCandidate(seg(i + 2))) return true;
  }
  return false;
}

/** Webhook path matching on an ASCII-decoded, slash-collapsed, lower-cased path (`/API//%77ebhooks/` ≡ `/api/webhooks/`). */
function normalizedHostPath(pathname: string): string {
  return decode(pathname).replace(/\/{2,}/g, "/").toLowerCase();
}

/** `name=value` pairs separated by `&` or `;`, each part decoded. */
function splitPairs(raw: string): Array<{ name: string; value: string | null; formValue: string | null }> {
  if (raw.length === 0) return [];
  return raw.split(/[&;]/).map((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return { name: decode(pair), value: null, formValue: null };
    const rawValue = pair.slice(eq + 1);
    // `formValue` reads `+` as a space BEFORE percent-decoding, so an encoded `%2B` stays a literal `+`.
    return { name: decode(pair.slice(0, eq)), value: decode(rawValue), formValue: decode(rawValue.replace(/\+/g, " ")) };
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
    if (isCredentialValue(value) || (pair.formValue !== null && isCredentialValue(pair.formValue))) return valueSignal;
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
  const hostPath = normalizedHostPath(url.pathname);
  for (const { host, pathPrefix } of CREDENTIAL_HOSTS) {
    if (hostMatches(url.hostname, host) && pathPrefix.test(hostPath)) return "credential_host";
  }

  const search = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const querySignal = screenPairs(search, nested, "credential_query_name", "credential_value");
  if (querySignal) return querySignal;

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment.length > 0) {
    const decoded = decode(fragment);
    // Credential names in `name=value` fragment pairs (`#access_token=…`). A text fragment
    // (`#:~:text=…`) only ever has the names `:~:text` / `text`, so it is never dropped by name.
    // Hash routes (`#/reset-password?token=…`, `#!/cb?access_token=…`): pairs are split on `&`, `;` and `?`,
    // and the route's `/`-segments get the same credential path-context rule as the URL path.
    const routeAndQuery = decoded.replace(/^[!?/]+/, "");
    for (const pairText of routeAndQuery.split("?")) {
      for (const { name, value } of splitPairs(pairText)) {
        // Same rule as the query: an absent or empty value carries no secret.
        if (value !== null && value.length > 0 && isCredentialName(name)) return "credential_fragment";
        if (value !== null && TOKEN_VALUE_ONLY_NAMES.has(normalizeName(name)) && isTokenShapedValue(value)) return "credential_fragment";
      }
    }
    if (screenPathContext(decoded.split("?")[0].replace(/^!/, "").split("/"))) return "credential_fragment";
    if (isCredentialValue(decoded)) return "credential_fragment";
    for (const piece of decoded.split(/[&=/?;]/)) {
      if (piece && isCredentialValue(piece)) return "credential_fragment";
    }
  }

  const rawSegments = url.pathname.split("/");
  // Credential context: `/reset-password/<token>`, `/access-token/<value>` — a token-shaped next segment.
  if (screenPathContext(rawSegments)) return "credential_path";
  for (let i = 0; i < rawSegments.length; i++) {
    const rawSegment = rawSegments[i];
    if (!rawSegment) continue;
    const [head, ...params] = rawSegment.split(";");
    const segment = decode(head);
    if (isCredentialValue(segment)) return "credential_path";
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
  if (inner.username !== "" || inner.password !== "") return "userinfo";
  return screenParts(inner, true);
}

/**
 * Classify one provider-returned `url` value. Never throws. Exactly one
 * outcome per value: a string above the processing-safety ceiling is
 * `over_limit` before anything else (not parsed at all); otherwise the order is
 * invalid → privacy_dropped → over_limit → usable. Privacy is screened before the size limit so that
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
