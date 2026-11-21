/**
 * Analytics reverse proxy policy (post-deployment containment for the PR #335 Production finding,
 * private advisory GHSA-655j-5f43-92pw follow-up).
 *
 * Root cause being contained: `/ingest/*` used to be a `next.config.js` EXTERNAL REWRITE to PostHog. A rewrite
 * proxy forwards the browser's request headers, and every same-origin request carries the site's cookies
 * (`__session` is `path: "/"`). Header stripping in middleware relied on the platform applying middleware
 * request-header overrides to external rewrites, and Vercel's routing matched case variants (`/INGEST/...`) that
 * the build marked case-sensitive. Neither can be observed or guaranteed from the app.
 *
 * Containment: the proxy is now app code (`app/ingest/[...path]/route.ts`). The upstream request is BUILT here
 * from an explicit allowlist, so no inbound header the allowlist does not name (Cookie, Authorization, any other
 * credential, in any letter case) can reach PostHog, whatever the platform does. Paths must be the exact canonical
 * spelling; every case, encoding or slash variant is refused before any upstream request.
 *
 * Pure and dependency-free; never logs; never throws.
 */

export const POSTHOG_API_ORIGIN = "https://us.i.posthog.com";
export const POSTHOG_ASSETS_ORIGIN = "https://us-assets.i.posthog.com";

/** Request headers copied to PostHog. Nothing else is ever forwarded. Lowercase names. */
export const FORWARDED_REQUEST_HEADERS: readonly string[] = ["accept", "content-type", "content-encoding", "user-agent", "x-forwarded-for"];

/** Response headers copied back to the browser. `content-encoding` / `content-length` are dropped (fetch decodes). */
export const FORWARDED_RESPONSE_HEADERS: readonly string[] = ["content-type", "cache-control", "etag", "last-modified", "expires", "vary"];

export type ProxyPathClass = "canonical" | "variant" | "unrelated";

function decodeBounded(path: string): string | null {
  let current = path;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null; // still changing after the bound: treat as hostile
}

const TELEMETRY_PREFIX = /^\/+(?:ingest|monitoring)(?:[/.;\\]|$)/;

/**
 * `canonical`: exactly `/ingest`, `/ingest/...`, `/monitoring` or `/monitoring/...` as raw bytes, with no `%`,
 * `\`, empty segment or dot segment. `variant`: anything that DECODES (case-insensitively, after collapsing
 * slashes) to one of those prefixes but is not canonical: refused with 404. `unrelated`: everything else.
 */
export function classifyTelemetryProxyPath(rawPathname: string): ProxyPathClass {
  if (typeof rawPathname !== "string") return "unrelated";
  const decoded = decodeBounded(rawPathname);
  const probe = (decoded ?? rawPathname).replace(/\\/g, "/").toLowerCase();
  const telemetryish = TELEMETRY_PREFIX.test(probe) || (decoded === null && /ingest|monitoring/i.test(rawPathname));
  if (!telemetryish) return "unrelated";
  const canonicalPrefix = rawPathname === "/ingest" || rawPathname.startsWith("/ingest/") || rawPathname === "/monitoring" || rawPathname.startsWith("/monitoring/");
  if (!canonicalPrefix) return "variant";
  if (/[%\\]/.test(rawPathname)) return "variant";
  const segments = rawPathname.slice(1).split("/");
  // A single trailing slash is allowed (`/ingest/e/`); any other empty segment or a dot segment is not.
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s === "" && i !== segments.length - 1) return "variant";
    if (s === "." || s === "..") return "variant";
  }
  return "canonical";
}

const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * The upstream URL for a canonical `/ingest...` path (query string passed through), or null when the path is not
 * a canonical, well-formed PostHog proxy path. The host is a LITERAL prefix (no configuration, no environment
 * variable can change it); tests redirect these hosts at the network layer instead (test preload).
 */
export function upstreamUrlFor(rawPathname: string, search: string): string | null {
  if (classifyTelemetryProxyPath(rawPathname) !== "canonical") return null;
  if (rawPathname !== "/ingest" && !rawPathname.startsWith("/ingest/")) return null;
  const rest = rawPathname === "/ingest" ? "" : rawPathname.slice("/ingest/".length);
  const parts = rest === "" ? [] : rest.split("/");
  const trailing = parts.length > 0 && parts[parts.length - 1] === "";
  const segments = trailing ? parts.slice(0, -1) : parts;
  if (!segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")) return null;
  const isAsset = segments[0] === "static" || segments[0] === "array";
  const path = `${segments.join("/")}${trailing ? "/" : ""}`;
  const query = typeof search === "string" && search.startsWith("?") ? search : "";
  return isAsset ? `https://us-assets.i.posthog.com/${path}${query}` : `https://us.i.posthog.com/${path}${query}`;
}

/** The ONLY headers sent upstream: allowlisted names copied from the inbound request. */
export function upstreamRequestHeaders(inbound: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = inbound.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/** The ONLY headers returned to the browser: allowlisted names copied from the upstream response. */
export function downstreamResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const v = upstream.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/** Fail-closed switch: `CP_ANALYTICS_PROXY_DISABLED=1` refuses every proxy request (a redeploy applies it). */
export function analyticsProxyDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CP_ANALYTICS_PROXY_DISABLED === "1";
}
