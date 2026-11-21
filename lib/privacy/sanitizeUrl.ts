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

import { SAFE_QUERY_PARAM_SHAPES, isSafeParamValue } from "./urlParamRules";
import { EXTERNAL_PATH, isSafeCodeFilePath, templatePath } from "./routeTemplates";

export const REDACTED = "[redacted]";

// R5 (owner ruling): the parameter rules live in ONE module shared with the pre-telemetry address-bar scrub
// (lib/privacy/urlContentScrub.ts). On every payload that passes through this sanitizer only SAFE_QUERY_PARAM_SHAPES
// values survive; routing, nested-target and content parameters — and every unknown one — are redacted here. SDK paths
// that read location.href without a sanitizing hook (Replay meta href, PostHog /flags, $initial_person_info) see the
// address bar as the pre-telemetry scrub left it, routing values included.
export { SAFE_QUERY_PARAM_SHAPES, isSafeParamValue };

/** The allowlisted parameter NAMES (values are additionally shape-checked). */
export const SAFE_QUERY_PARAMS: ReadonlySet<string> = new Set(SAFE_QUERY_PARAM_SHAPES.keys());

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

/** Placeholder for a relative URL with a path (it cannot be resolved against a route without its base). */
export const RELATIVE_PATH = "[relative-path]";

// Structural hardening: hosts whose paths are THIS app's routes (templated). Every other host is third-party: its
// origin is kept, its path replaced with EXTERNAL_PATH. The current document's host is added at run time (previews,
// local builds).
const FIRST_PARTY_HOSTNAMES = new Set(["convergepanel.com", "www.convergepanel.com", "localhost", "127.0.0.1", "[::1]"]);
function isFirstPartyHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (FIRST_PARTY_HOSTNAMES.has(h) || h.endsWith(".convergepanel.com")) return true;
  try {
    const current = (globalThis as { location?: { hostname?: string } }).location?.hostname;
    return typeof current === "string" && current !== "" && current.toLowerCase() === h;
  } catch {
    return false;
  }
}

const HIERARCHICAL = /^(https?|wss?):\/\/([^/]*)(.*)$/i;
const PROTOCOL_RELATIVE = /^\/\/([^/]*)(.*)$/;
// Stack-frame / debug-image schemes: the path is a code location, kept only when it is a safe code-file path.
const CODE_SCHEME = /^(app|webpack|webpack-internal|file|node|chrome-extension|moz-extension|safari-web-extension):(.*)$/i;
const OTHER_SCHEME = /^([a-z][a-z0-9+.-]{0,31}):/i;

/** Placeholder for a host name that is itself credential-shaped (never kept). */
export const REDACTED_HOST = "[redacted-host]";

function authorityOf(authority: string): string {
  // Userinfo (`user:pass@`) is dropped; host and port are kept unless the host is credential-shaped.
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  return hasCredentialShapedRun(hostPort) || /[%\\]/.test(hostPort) ? REDACTED_HOST : hostPort;
}

function hostnameOf(authority: string): string {
  if (authority.startsWith("[")) return authority.slice(0, authority.indexOf("]") + 1);
  const colon = authority.indexOf(":");
  return colon === -1 ? authority : authority.slice(0, colon);
}

function sanitizePathFor(hostname: string, path: string, codeLocation: boolean): string {
  if (path === "" || path === "/") return path;
  if (!isFirstPartyHost(hostname)) {
    return codeLocation && isSafeCodeFilePath(path) ? path : EXTERNAL_PATH;
  }
  return templatePath(path, { codeLocation });
}

// A credential-shaped run (32+ base64url characters with both letter cases): never kept in a bare value.
function hasCredentialShapedRun(s: string): boolean {
  for (const m of s.match(/[A-Za-z0-9_-]{32,}/g) ?? []) if (/[a-z]/.test(m) && /[A-Z]/.test(m)) return true;
  return false;
}

/**
 * Structural hardening: the part of a URL before `?`. Origin kept (userinfo dropped); first-party path templated
 * (lib/privacy/routeTemplates.ts); third-party path replaced; non-hierarchical schemes (`data:`, `blob:`, `mailto:`,
 * `javascript:` ...) reduced to `scheme:[redacted]`; a relative path with a `/` becomes {@link RELATIVE_PATH}.
 */
function sanitizeUrlBase(base: string, codeLocation: boolean): string {
  if (base === "") return "";
  let m = HIERARCHICAL.exec(base);
  if (m) {
    const authority = authorityOf(m[2]);
    return `${m[1]}://${authority}${sanitizePathFor(hostnameOf(authority), m[3], codeLocation)}`;
  }
  m = PROTOCOL_RELATIVE.exec(base);
  if (m) {
    const authority = authorityOf(m[1]);
    return `//${authority}${sanitizePathFor(hostnameOf(authority), m[2], codeLocation)}`;
  }
  m = CODE_SCHEME.exec(base);
  if (m) {
    // `app:///_next/static/chunks/x.js`, `webpack-internal:///./components/x.tsx`, `node:internal/...`
    const scheme = m[1].toLowerCase();
    const rest = m[2].replace(/^\/\/[^/]*/, "");
    const asPath = ("/" + rest).replace(/^\/+/, "/").replace(/\/\.\//g, "/");
    if (isSafeCodeFilePath(asPath)) return base;
    if (scheme === "node" && /^[a-z0-9_:/.-]{1,128}$/i.test(rest) && !hasCredentialShapedRun(rest)) return base;
    return `${m[1]}:${REDACTED}`;
  }
  if (base.startsWith("/")) return templatePath(base, { codeLocation });
  m = OTHER_SCHEME.exec(base);
  if (m) {
    if (/^about:(blank|srcdoc)$/i.test(base)) return base;
    return `${m[1]}:${REDACTED}`;
  }
  if (base.includes("/") || base.includes("\\")) {
    return codeLocation && isSafeCodeFilePath("/" + base.replace(/^\.\//, "")) ? base : RELATIVE_PATH;
  }
  // A bare word (`<anonymous>`, `native`, a relative file name): kept unless credential-shaped.
  return hasCredentialShapedRun(base) || base.length > 256 ? REDACTED : base;
}

/**
 * Sanitizes one URL (absolute, protocol-relative, path-relative, or a bare `?query`):
 *   - origin kept, userinfo dropped;
 *   - path: a first-party path becomes its route template (unknown routes -> `/[unmatched]`), a third-party path
 *     becomes `/[external-path]` (lib/privacy/routeTemplates.ts);
 *   - fragment dropped;
 *   - query filtered through {@link sanitizeQueryString}.
 * `codeLocation` (stack-frame file names, debug images) additionally keeps safe code-file paths for symbolication.
 * Never throws.
 */
export function sanitizeUrl(url: string, options: { codeLocation?: boolean } = {}): string {
  try {
    const hashAt = url.indexOf("#");
    const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
    const queryAt = withoutHash.indexOf("?");
    const rawBase = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
    const base = sanitizeUrlBase(rawBase, options.codeLocation === true);
    if (queryAt === -1) return base;
    const query = sanitizeQueryString(withoutHash.slice(queryAt + 1));
    return query === "" ? base : `${base}?${query}`;
  } catch {
    return REDACTED;
  }
}

/** `sanitizeUrl` for an arbitrary value: non-strings are returned unchanged. */
export function sanitizeUrlValue<T>(value: T): T {
  return (typeof value === "string" ? sanitizeUrl(value) : value) as T;
}

// A "token" is a run of characters that cannot end a URL in prose / logs. Square brackets are allowed inside a
// token so route templates (`/workspace/team/[workspaceId]`) and `[redacted]` survive a second pass unchanged.
const TEXT_TOKEN = /[^\s"'<>`(){}]+/g;
const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_SCHEME_TOKEN = /^(blob|data|javascript|vbscript|mailto|tel|sms|file|filesystem):/i;
// Sentence punctuation after a URL (`see /pricing.`) is not part of it; `:12:3` line/column suffixes are kept.
const TRAILING_PUNCTUATION = /[.,;!]+$|:$/;

function sanitizeToken(token: string): string {
  const p = TRAILING_PUNCTUATION.exec(token);
  const core = p ? token.slice(0, p.index) : token;
  const tail = p ? p[0] : "";
  if (core === "") return token;
  return sanitizeUrl(core) + tail;
}

/**
 * Sanitizes every URL-like token embedded in free text (a Sentry span description `GET https://host/api/x?q=...`,
 * a transaction name, an exception message, a Replay performance-span description). A token is sanitized when it
 * starts with a scheme (`https://`, `app:///`, `blob:`, `data:`, any case), starts with `/` (a path: templated),
 * starts with `//`, or contains `?`/`#` followed by a `name=value`. Prose like "is it true?", "issue #1" or
 * "and/or" is left unchanged.
 */
export function sanitizeUrlsInText(text: string): string {
  return text.replace(TEXT_TOKEN, (token) => {
    if (ABSOLUTE_SCHEME.test(token) || OPAQUE_SCHEME_TOKEN.test(token) || token.startsWith("/")) return sanitizeToken(token);
    const at = token.search(/[?#]/);
    if (at !== -1 && token.slice(at + 1).includes("=")) return sanitizeToken(token);
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
    key === "previous" || // Replay `navigation.push` breadcrumb `data.previous` (R5)
    key === "$pathname_with_query" ||
    // Structural hardening: path-only fields (`$pathname`, `$initial_pathname`, `$prev_pageview_pathname`, OTel
    // `url.path`, `http.target`) are templated like any URL path.
    /pathname$/i.test(key) ||
    key === "path" ||
    /\.path$/i.test(key) ||
    isCodeLocationKey(key)
  );
}

/**
 * Keys whose value is a CODE location (stack-frame file names, debug images), not a page URL: a safe code-file path
 * is kept so source maps keep working; anything else is templated exactly like a URL.
 */
export function isCodeLocationKey(key: string): boolean {
  return key === "filename" || key === "abs_path" || key === "code_file" || key === "debug_file" || key === "code.filepath" || key === "module_path";
}

/** Keys whose value is a raw query string (Sentry `request.query_string`, OTel `url.query` / `http.query`). */
export function isQueryKey(key: string): boolean {
  return /^(?:query_string|url\.query|http\.query|query)$/i.test(key);
}

/** Keys whose value is a URL fragment on its own (OTel `url.fragment`, `http.fragment`) — always dropped. */
export function isFragmentKey(key: string): boolean {
  return /(?:^|\.)fragment$/i.test(key);
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
 * Walks a telemetry payload IN PLACE and sanitizes every URL-bearing field: string values under URL keys (whole
 * value is a URL), string arrays under `urls`, query-string values under query keys; fragment keys are redacted.
 * Structural hardening: EVERY other string, under any key at any depth, has the URLs and paths embedded in it
 * sanitized ({@link sanitizeUrlsInText}), so an SDK field this list does not name cannot carry a raw path, query or
 * fragment. Cycle-safe; depth-bounded and FAIL-CLOSED (default 12, a Replay DOM snapshot passes a larger bound): an
 * object below the bound is replaced with `[truncated]`. Returns the same object.
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
        else if (typeof node[i] === "string") node[i] = sanitizeUrlsInText(node[i]);
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
        const codeLocation = isCodeLocationKey(key);
        if (typeof value === "string") record[key] = sanitizeUrl(value, { codeLocation });
        else if (Array.isArray(value)) record[key] = value.map((v) => (typeof v === "string" ? sanitizeUrl(v, { codeLocation }) : v));
        else walk(value, depth + 1);
      } else if (typeof value === "string") {
        record[key] = sanitizeUrlsInText(value);
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return payload;
}
