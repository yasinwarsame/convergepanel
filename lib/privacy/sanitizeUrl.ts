/**
 * Privacy remediation (2026-11-17 audit, findings L1/B.6) — the ONE shared
 * URL sanitizer for every telemetry boundary (PostHog `before_send` and the
 * manual `$pageview`, browser/server/edge Sentry hooks, Sentry Replay
 * recording events).
 *
 * Why an ALLOWLIST, not a denylist: claim / question text reaches URLs under
 * several names today (`text` from the browser extension, `claim` and `q` from
 * `/verify`, and nested inside `redirect=`/`next=` on login/signup), and any
 * future feature can add another. A denylist silently leaks the next new
 * name; an allowlist fails closed. Only parameters whose values are known,
 * low-cardinality, non-content operational signals (marketing `utm_*`, tab
 * names, pagination, billing-return flags) keep their value. Every other
 * parameter keeps its NAME (so "a `claim` param was present" is still
 * observable for debugging) but its value is replaced with `[redacted]`.
 * A parameter whose NAME is not a plain identifier (e.g. `?Is the earth flat`
 * — content in key position) is collapsed to a single `[redacted]` token.
 * The fragment (`#...`) is always dropped (Phase 8D.3.1: invitation tokens).
 *
 * Isomorphic and dependency-free (runs in the browser, Node and Edge).
 * Parsing is manual (no `URL` constructor) so the scheme/host/path portion is
 * returned byte-for-byte unchanged and relative URLs need no base.
 */

export const REDACTED = "[redacted]";

/**
 * Query parameters whose values may be transmitted to telemetry verbatim.
 * Adding a name here is a privacy decision: the value must never be able to
 * carry user-authored content, identifiers of people, or credentials.
 */
export const SAFE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "tab",
  "source",
  "view",
  "scope",
  "page",
  "limit",
  "offset",
  "signedOut",
  "sessionClearFailed",
  "success",
  "canceled",
  "upgraded",
  "plan",
  "interval",
  "cycle",
]);

const PLAIN_PARAM_NAME = /^[A-Za-z0-9_.\-[\]]{1,64}$/;

function safeDecode(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/g, " "));
  } catch {
    return component;
  }
}

/**
 * Sanitizes a raw query string (with or without a leading `?`). Returns the
 * sanitized query WITHOUT a leading `?` (empty string when nothing remains).
 */
export function sanitizeQueryString(query: string): string {
  const body = query.startsWith("?") ? query.slice(1) : query;
  if (body === "") return "";
  const out: string[] = [];
  for (const pair of body.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const key = safeDecode(rawKey);
    if (SAFE_QUERY_PARAMS.has(key)) {
      out.push(pair);
    } else if (PLAIN_PARAM_NAME.test(key)) {
      out.push(`${rawKey}=${REDACTED}`);
    } else {
      out.push(REDACTED);
    }
  }
  return out.join("&");
}

/**
 * Sanitizes one URL (absolute, protocol-relative, path-relative, or a bare
 * `?query`). The part before `?` is kept as-is; the fragment is dropped; the
 * query is filtered through {@link sanitizeQueryString}.
 */
export function sanitizeUrl(url: string): string {
  const hashAt = url.indexOf("#");
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  if (queryAt === -1) return withoutHash;
  const base = withoutHash.slice(0, queryAt);
  const query = sanitizeQueryString(withoutHash.slice(queryAt + 1));
  return query === "" ? base : `${base}?${query}`;
}

/** `sanitizeUrl` for an arbitrary value: non-strings are returned unchanged. */
export function sanitizeUrlValue<T>(value: T): T {
  return (typeof value === "string" ? sanitizeUrl(value) : value) as T;
}

// Absolute http(s) URLs, or a path (`/...`, at the start or after whitespace /
// a quote / `(` / `=`) that carries a query or fragment. No lookbehind: older
// Safari versions reject it at parse time, which would break the client bundle.
const URL_IN_TEXT = /(https?:\/\/[^\s"'<>`]+)|(^|[\s"'(=])(\/[^\s"'<>`?#]*[?#][^\s"'<>`]*)/g;

/**
 * Sanitizes every URL embedded in free text (e.g. a Sentry span description
 * `GET https://host/api/x?q=...`, a transaction name, a Replay performance
 * span description). Text outside the URL is left unchanged.
 */
export function sanitizeUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (_match, absolute: string | undefined, lead: string | undefined, path: string | undefined) =>
    absolute !== undefined ? sanitizeUrl(absolute) : `${lead ?? ""}${sanitizeUrl(path ?? "")}`
  );
}

/** Keys whose string value is a URL (or a URL list) in PostHog / Sentry payloads. */
export function isUrlKey(key: string): boolean {
  return (
    /(?:url|uri|href|referr?er|target)$/i.test(key) ||
    /^url\./i.test(key) || // OpenTelemetry `url.full` / `url.original` / `url.path`
    key === "urls" ||
    key === "to" ||
    key === "from" ||
    key === "$pathname_with_query"
  );
}

/** Keys whose value is a raw query string (Sentry `request.query_string`, OTel `url.query` / `http.query`). */
export function isQueryKey(key: string): boolean {
  return /^(?:query_string|url\.query|http\.query|query)$/i.test(key);
}

/** Keys whose value is free text that may embed URLs. */
function isUrlBearingTextKey(key: string): boolean {
  return key === "description" || key === "transaction" || key === "name" || key === "message";
}

function sanitizeQueryValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeQueryString(value);
  if (Array.isArray(value)) {
    // Sentry may represent query_string as [[key, value], ...].
    return value.map((pair) => {
      if (Array.isArray(pair) && pair.length >= 1) {
        const key = String(pair[0]);
        if (SAFE_QUERY_PARAMS.has(key)) return pair;
        return PLAIN_PARAM_NAME.test(key) ? [key, REDACTED] : [REDACTED, REDACTED];
      }
      return REDACTED;
    });
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SAFE_QUERY_PARAMS.has(key)) out[key] = v;
      else if (PLAIN_PARAM_NAME.test(key)) out[key] = REDACTED;
      else out[REDACTED] = REDACTED;
    }
    return out;
  }
  return value;
}

const DEFAULT_MAX_DEPTH = 12;

/**
 * Walks a telemetry payload IN PLACE and sanitizes every URL-bearing field:
 * string values under URL keys, string arrays under `urls`, query-string
 * values under query keys, and URLs embedded in description/transaction/name/
 * message text. Cycle- and depth-safe (default depth 12; a Replay DOM
 * snapshot passes a larger bound). Returns the same object.
 */
export function scrubUrlFields<T>(payload: T, options: { maxDepth?: number } = {}): T {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > maxDepth) return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (isQueryKey(key)) {
        record[key] = sanitizeQueryValue(value);
      } else if (isUrlKey(key)) {
        if (typeof value === "string") record[key] = sanitizeUrl(value);
        else if (Array.isArray(value)) record[key] = value.map((v) => sanitizeUrlValue(v));
        else walk(value, depth + 1);
      } else if (typeof value === "string") {
        if (isUrlBearingTextKey(key)) record[key] = sanitizeUrlsInText(value);
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return payload;
}
