/**
 * PR #329 R5 (R4 review MAJOR-1, owner ruling) — the address-bar scrub
 * contract applied before any telemetry SDK initializes (and again on every
 * soft navigation). Pure: computes the clean URL and the content to move into
 * the tab hand-offs; `lib/client/verifyPrefill.ts migrateContentFromUrl` applies
 * it (address bar first, then the identity-bound hand-off / memory hold).
 *
 * Rules come ONLY from `lib/privacy/urlParamRules.ts` (shared with the
 * telemetry sanitizer):
 *   - a telemetry-safe or registered routing parameter whose decoded value has
 *     its shape is kept BYTE-FOR-BYTE;
 *   - `redirect` / `next`: the value is decoded (at most MAX_EXTRA_DECODE_PASSES
 *     extra passes, until it is a local path), bounded (MAX_NESTED_TARGET_CHARS,
 *     MAX_NEST_DEPTH, token-shaped path segments) and cleaned recursively with
 *     these same rules; content inside is moved to the hand-off and the cleaned
 *     target is written back, so the post-auth redirect still lands there. Any
 *     bound violated anywhere inside → the top-level parameter is dropped
 *     entirely, and content inside it is discarded (fail closed);
 *   - content on a hand-off route (CONTENT_HANDOFFS) is captured, then dropped;
 *   - EVERY other parameter is dropped (fail closed) — unknown names, known
 *     content names elsewhere, routing names with a content-shaped value,
 *     content in key position;
 *   - inside a nested target, everything after the first content parameter is
 *     dropped too: an over-decoding producer (signup's `safeRedirect` decodes
 *     the nested target once more before re-encoding it) splits a claim at its
 *     own `&`, so the boundary is unreliable there;
 *   - fragment: a plain anchor or a registered routing fragment is kept; a
 *     hand-off fragment (`/verify#text=`) is captured; anything else is dropped.
 *     A nested target keeps no fragment.
 * The path is never rewritten (no producer puts content in a path segment;
 * the sanitizer treats the path as non-content). Never throws.
 */
import {
  CONTENT_HANDOFFS,
  CONTENT_PARAMS,
  MAX_EXTRA_DECODE_PASSES,
  MAX_NESTED_TARGET_CHARS,
  MAX_NEST_DEPTH,
  MAX_QUERY_PAIRS,
  NESTED_PATH_SEGMENT,
  PLAIN_ANCHOR,
  ROUTING_FRAGMENT_KEYS,
  isNestedTargetParam,
  isRoutingParamValue,
  isSafeParamValue,
  type ContentHandoffKind,
} from "./urlParamRules";

export type ContentCapture = { kind: ContentHandoffKind; text: string };
export type UrlScrubResult = {
  /** "" or "?…" */
  search: string;
  /** "" or "#…" */
  hash: string;
  /** In URL order; the consumer takes the first of each kind. */
  captures: ContentCapture[];
  changed: boolean;
};

/** Signals a bound violation inside a nested target (caught at the top-level parameter). */
class OutOfBounds extends Error {}

/** Query-component decoding as URLSearchParams reads it ("+" is a space); null when malformed. */
function decodeComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return null;
  }
}
/** Content is moved, never interpreted: malformed escapes are kept as typed. */
function decodeContent(raw: string): string {
  return decodeComponent(raw) ?? raw.replace(/\+/g, " ");
}

function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
function isLocalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

function handoffFor(path: string, name: string, tab: string | undefined, inFragment: boolean): ContentHandoffKind | null {
  const p = normalizePath(path);
  const rule = CONTENT_HANDOFFS.find((r) => r.path === p && r.param === name && (!inFragment || r.fragment) && (r.tab === undefined || r.tab === tab));
  return rule ? rule.kind : null;
}

function splitPair(pair: string): { rawName: string; rawValue: string } {
  const eq = pair.indexOf("=");
  return eq === -1 ? { rawName: pair, rawValue: "" } : { rawName: pair.slice(0, eq), rawValue: pair.slice(eq + 1) };
}

function scrubQuery(path: string, rawQuery: string, depth: number, captures: ContentCapture[], nested: boolean): string {
  const pairs = rawQuery.split("&").filter((p) => p !== "");
  if (pairs.length > MAX_QUERY_PAIRS) {
    if (nested) throw new OutOfBounds();
    pairs.length = MAX_QUERY_PAIRS; // top level: the rest is dropped (fail closed)
  }
  let tab: string | undefined;
  for (const pair of pairs) {
    const { rawName, rawValue } = splitPair(pair);
    if (decodeComponent(rawName) === "tab") {
      tab = decodeComponent(rawValue) ?? undefined;
      break;
    }
  }
  const kept: string[] = [];
  let afterContent = false;
  for (const pair of pairs) {
    if (nested && afterContent) continue;
    const { rawName, rawValue } = splitPair(pair);
    const name = decodeComponent(rawName);
    if (name === null) continue;
    const kind = handoffFor(path, name, tab, false);
    if (kind !== null || CONTENT_PARAMS.includes(name)) {
      afterContent = true;
      if (kind !== null) captures.push({ kind, text: decodeContent(rawValue) });
      continue;
    }
    const value = decodeComponent(rawValue);
    if (value === null) continue;
    if (isSafeParamValue(name, value) || isRoutingParamValue(name, value)) {
      kept.push(pair);
      continue;
    }
    if (isNestedTargetParam(name)) {
      if (nested) {
        // A violation anywhere inside propagates to the top-level parameter.
        const cleaned = cleanNestedTarget(value, depth + 1, captures);
        kept.push(cleaned === value ? pair : `${rawName}=${encodeURIComponent(cleaned)}`);
        continue;
      }
      const inner: ContentCapture[] = [];
      try {
        const cleaned = cleanNestedTarget(value, depth + 1, inner);
        kept.push(cleaned === value ? pair : `${rawName}=${encodeURIComponent(cleaned)}`);
        captures.push(...inner);
      } catch (e) {
        if (!(e instanceof OutOfBounds)) throw e;
        // Beyond the bounds: the whole parameter is dropped, and nothing inside it is kept anywhere.
      }
      continue;
    }
    // Anything else is content-bearing by default: dropped.
  }
  return kept.join("&");
}

/** Throws OutOfBounds when a bound is exceeded or the value is not a local path. */
function cleanNestedTarget(value: string, depth: number, captures: ContentCapture[]): string {
  if (depth > MAX_NEST_DEPTH) throw new OutOfBounds();
  if (value.length > MAX_NESTED_TARGET_CHARS) throw new OutOfBounds();
  let target = value;
  for (let pass = 0; !isLocalPath(target); pass++) {
    if (pass >= MAX_EXTRA_DECODE_PASSES || !/%[0-9A-Fa-f]{2}/.test(target)) throw new OutOfBounds();
    try {
      target = decodeURIComponent(target);
    } catch {
      throw new OutOfBounds();
    }
  }
  const hashAt = target.indexOf("#");
  const beforeHash = hashAt === -1 ? target : target.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : target.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  if (!path.split("/").every((segment) => NESTED_PATH_SEGMENT.test(segment))) throw new OutOfBounds();
  const cleanQuery = scrubQuery(path, query, depth, captures, true);
  if (fragment) scrubFragment(path, fragment, captures, true);
  return cleanQuery ? `${path}?${cleanQuery}` : path;
}

/** Returns the fragment to keep (without "#"), capturing hand-off content. */
function scrubFragment(path: string, fragment: string, captures: ContentCapture[], nested: boolean): string {
  if (!fragment) return "";
  if (!nested && PLAIN_ANCHOR.test(fragment)) return fragment;
  const pairs = fragment.split("&").filter((p) => p !== "").map(splitPair);
  const routingKeys = ROUTING_FRAGMENT_KEYS.get(normalizePath(path));
  if (!nested && routingKeys && pairs.length > 0 && pairs.every((p) => routingKeys.includes(decodeComponent(p.rawName) ?? ""))) return fragment;
  for (const { rawName, rawValue } of pairs) {
    const name = decodeComponent(rawName);
    if (name === null) continue;
    const kind = handoffFor(path, name, undefined, true);
    if (kind !== null) {
      captures.push({ kind, text: decodeContent(rawValue) });
      break;
    }
  }
  return "";
}

/** The clean `search` / `hash` for a location, and the content to move into the hand-offs. Never throws. */
export function scrubUrlParts(location: { pathname: string; search: string; hash: string }): UrlScrubResult {
  const search = location.search ?? "";
  const hash = location.hash ?? "";
  const captures: ContentCapture[] = [];
  let cleanSearch = "";
  let cleanHash = "";
  try {
    const query = scrubQuery(location.pathname, search.startsWith("?") ? search.slice(1) : search, 0, captures, false);
    cleanSearch = query ? `?${query}` : "";
    const fragment = scrubFragment(location.pathname, hash.startsWith("#") ? hash.slice(1) : hash, captures, false);
    cleanHash = fragment ? `#${fragment}` : "";
  } catch {
    // Fail closed: an unexpected error leaves no query and no fragment.
    return { search: "", hash: "", captures: [], changed: search !== "" || hash !== "" };
  }
  return { search: cleanSearch, hash: cleanHash, captures, changed: cleanSearch !== search || cleanHash !== hash || captures.length > 0 };
}
