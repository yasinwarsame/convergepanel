import { handleTunnelRequest } from "@sentry/core";
import { resolveSentryDsn } from "@/lib/telemetry/sentryDsn";

export const runtime = "nodejs";

// Sentry tunnel: forwards client-side error/session-replay envelopes through
// our origin to bypass ad-blockers. Delegates to @sentry/core's own
// handleTunnelRequest, which operates on the raw request body throughout —
// a hand-rolled req.text() implementation here previously forced a lossy
// UTF-8 round-trip that corrupted binary (compressed Replay) envelope items.
//
// Telemetry isolation: the only allowed DSN is the explicitly configured
// browser DSN — the same value the client initializes with — and there is no
// hard-coded fallback. Unconfigured means the tunnel is disabled: it answers
// 404 without reading the body or contacting Sentry.
export async function POST(request: Request): Promise<Response> {
  const dsn = resolveSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);
  if (dsn === undefined) return new Response(null, { status: 404 });
  return handleTunnelRequest({ request, allowedDsns: [dsn] });
}
