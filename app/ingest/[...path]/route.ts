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

async function readCapped(request: Request, cap: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

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
  let body: Uint8Array | undefined;
  if (request.method === "POST") {
    // Review MINOR-2: refuse an oversize body before buffering it (declared length, then a running count).
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
    const read = await readCapped(request, MAX_BODY_BYTES);
    if (read === null) return new Response(null, { status: 413 });
    body = read;
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamRequestHeaders(request.headers),
      body: body as BodyInit | undefined,
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
