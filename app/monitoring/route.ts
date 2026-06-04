import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Sentry tunnel: forwards client-side error envelopes through our origin
// to bypass ad-blockers. Only forwards to our known Sentry ingest host.
const SENTRY_HOST = "o4511503698624512.ingest.us.sentry.io";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const envelope = await req.text();
    const header = JSON.parse(envelope.split("\n")[0]);
    const dsn = new URL(header.dsn);

    if (dsn.hostname !== SENTRY_HOST) {
      return NextResponse.json({ error: "Invalid DSN host" }, { status: 400 });
    }

    const projectId = dsn.pathname.replace(/^\//, "");
    const sentryUrl = `https://${SENTRY_HOST}/api/${projectId}/envelope/`;

    const response = await fetch(sentryUrl, {
      method: "POST",
      body: envelope,
      headers: { "Content-Type": "application/x-sentry-envelope" },
    });

    return new NextResponse(null, { status: response.status });
  } catch {
    return NextResponse.json({ error: "Tunnel error" }, { status: 400 });
  }
}
