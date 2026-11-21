/**
 * PostHog reverse proxy as app code (containment for the PR #335 Production finding). The upstream request is
 * built from an explicit header allowlist (lib/telemetry/analyticsProxy.ts): no cookie, Authorization or other
 * inbound credential can be forwarded, whatever the platform does with the inbound request. Non-canonical paths
 * (case, encoding, slash variants) are refused before any upstream request. Never logs.
 */
import {
  analyticsProxyDisabled,
  downstreamResponseHeaders,
  upstreamRequestHeaders,
  upstreamUrlFor,
} from "@/lib/telemetry/analyticsProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function proxy(request: Request): Promise<Response> {
  if (analyticsProxyDisabled()) return new Response(null, { status: 404 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 404 });
  }
  const target = upstreamUrlFor(url.pathname, url.search);
  if (target === null) return new Response(null, { status: 404 });
  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamRequestHeaders(request.headers),
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: downstreamResponseHeaders(upstream.headers),
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
