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

const UTM_VALUE = /^[A-Za-z0-9_.\-]{1,64}$/;
const LOWER_IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/;
const SMALL_INTEGER = /^\d{1,6}$/;
const FLAG = /^(?:|0|1|true|false|yes|no)$/i;

/**
 * Query parameters whose values may be transmitted to telemetry verbatim —
 * and only when the DECODED value matches the parameter's shape (round 2,
 * review MINOR-4: a bare name allowlist let `?tab=<claim text>` through).
 * A non-matching value is redacted like any other parameter. Adding an entry
 * is a privacy decision: the value must never be able to carry user-authored
 * content, identifiers of people, or credentials.
 */
export const SAFE_QUERY_PARAM_SHAPES: ReadonlyMap<string, RegExp> = new Map([
  ["utm_source", UTM_VALUE],
  ["utm_medium", UTM_VALUE],
  ["utm_campaign", UTM_VALUE],
  ["utm_term", UTM_VALUE],
  ["utm_content", UTM_VALUE],
  ["tab", /^(?:verify|research|video)$/],
  ["source", LOWER_IDENTIFIER],
  ["view", LOWER_IDENTIFIER],
  ["scope", LOWER_IDENTIFIER],
  ["plan", LOWER_IDENTIFIER],
  ["interval", LOWER_IDENTIFIER],
  ["cycle", LOWER_IDENTIFIER],
  ["page", SMALL_INTEGER],
  ["limit", SMALL_INTEGER],
  ["offset", SMALL_INTEGER],
  ["signedOut", FLAG],
  ["sessionClearFailed", FLAG],
  ["success", FLAG],
  ["canceled", FLAG],
  ["upgraded", FLAG],
]);

/** The allowlisted parameter NAMES (values are additionally shape-checked). */
export const SAFE_QUERY_PARAMS: ReadonlySet<string> = new Set(SAFE_QUERY_PARAM_SHAPES.keys());

/** True when `key` is allowlisted AND its decoded `value` has the allowed shape. */
export function isSafeParamValue(key: string, value: string): boolean {
  const shape = SAFE_QUERY_PARAM_SHAPES.get(key);
  return shape !== undefined && shape.test(value);
}

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
  // `;` is treated as a separator too (some servers and frameworks split on it).
  for (const pair of body.split(/[&;]/)) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const key = safeDecode(rawKey);
    const value = eq === -1 ? "" : safeDecode(pair.slice(eq + 1));
    if (isSafeParamValue(key, value)) {
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

// A "token" is a run of characters that cannot end a URL in prose / logs.
const TEXT_TOKEN = /[^\s"'<>`()[\]{}]+/g;
const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Sanitizes every URL-like token embedded in free text (a Sentry span
 * description `GET https://host/api/x?q=...`, a transaction name, an
 * exception message, a Replay performance-span description). A token is
 * sanitized when it starts with a scheme (`https://`, `HTTPS://`, `app:///`,
 * any case) or contains `?`/`#` followed by a `name=value` — so scheme-less
 * `host/path?q=...`, relative `/path?q=...` and bare `?q=...` are covered.
 * Prose like "is it true?" or "issue #1" is left unchanged.
 */
export function sanitizeUrlsInText(text: string): string {
  return text.replace(TEXT_TOKEN, (token) => {
    if (ABSOLUTE_SCHEME.test(token)) return sanitizeUrl(token);
    const at = token.search(/[?#]/);
    if (at !== -1 && token.slice(at + 1).includes("=")) return sanitizeUrl(token);
    return token;
  });
}

/** Keys whose string value is a URL (or a URL list) in PostHog / Sentry payloads. */
export function isUrlKey(key: string): boolean {
  return (
    /(?:url|uri|href|referr?er|target)$/i.test(key) ||
    /^url\./i.test(key) || // OpenTelemetry `url.full` / `url.original` / `url.path`
    // DOM attributes (Replay snapshots) and stack frames (exceptions):
    key === "src" ||
    key === "srcset" ||
    key === "action" ||
    key === "filename" ||
    key === "abs_path" ||
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

/** Keys whose value is a URL fragment on its own (OTel `url.fragment`, `http.fragment`) — always dropped. */
export function isFragmentKey(key: string): boolean {
  return /(?:^|\.)fragment$/i.test(key);
}

/** Keys whose value is free text that may embed URLs. */
function isUrlBearingTextKey(key: string): boolean {
  return (
    key === "description" ||
    key === "transaction" ||
    key === "name" ||
    key === "message" ||
    key === "value" || // Sentry / PostHog exception values
    key === "$exception_message"
  );
}

function sanitizeQueryValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeQueryString(value);
  if (Array.isArray(value)) {
    // Sentry may represent query_string as [[key, value], ...].
    return value.map((pair) => {
      if (Array.isArray(pair) && pair.length >= 1) {
        const key = String(pair[0]);
        if (isSafeParamValue(key, String(pair[1] ?? ""))) return pair;
        return PLAIN_PARAM_NAME.test(key) ? [key, REDACTED] : [REDACTED, REDACTED];
      }
      return REDACTED;
    });
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSafeParamValue(key, String(v ?? ""))) out[key] = v;
      else if (PLAIN_PARAM_NAME.test(key)) out[key] = REDACTED;
      else out[REDACTED] = REDACTED;
    }
    return out;
  }
  return value;
}

const DEFAULT_MAX_DEPTH = 12;
/** Replaces any object subtree below the depth bound (fail closed). */
export const TRUNCATED = "[truncated]";

/**
 * Walks a telemetry payload IN PLACE and sanitizes every URL-bearing field:
 * string values under URL keys, string arrays under `urls`, query-string
 * values under query keys, and URLs embedded in description/transaction/name/
 * message / exception-value text; fragment keys are redacted. Cycle-safe;
 * depth-bounded and FAIL-CLOSED (default 12, a Replay DOM snapshot passes a
 * larger bound): an object below the bound is replaced with `[truncated]`.
 * Returns the same object.
 */
export function scrubUrlFields<T>(payload: T, options: { maxDepth?: number } = {}): T {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (depth >= maxDepth && node[i] && typeof node[i] === "object") node[i] = TRUNCATED;
        else walk(node[i], depth + 1);
      }
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (depth >= maxDepth && value && typeof value === "object") {
        // Fail closed: a subtree deeper than the bound is replaced, never sent unscrubbed.
        record[key] = TRUNCATED;
        continue;
      }
      if (isFragmentKey(key)) {
        if (typeof value === "string") record[key] = REDACTED;
      } else if (isQueryKey(key)) {
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
