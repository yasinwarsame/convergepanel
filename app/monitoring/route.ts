import { handleTunnelRequest } from "@sentry/core";

export const runtime = "nodejs";

// Sentry tunnel: forwards client-side error/session-replay envelopes through
// our origin to bypass ad-blockers. Delegates to @sentry/core's own
// handleTunnelRequest, which operates on the raw request body throughout —
// a hand-rolled req.text() implementation here previously forced a lossy
// UTF-8 round-trip that corrupted binary (compressed Replay) envelope items.
const ALLOWED_DSNS = ["https://0d1785e8cafc519f0e99ecc4501ffc06@o4511503698624512.ingest.us.sentry.io/4511503843065856"];

export async function POST(request: Request): Promise<Response> {
  return handleTunnelRequest({ request, allowedDsns: ALLOWED_DSNS });
}
