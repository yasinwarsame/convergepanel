import "server-only";
import { NextResponse } from "next/server";

/**
 * The uniform denial for a failed `resolveGovernanceRequestUser`. The body
 * carries no identity, tier or scope information.
 */
export function governanceAuthDenialResponse(status: 401 | 503): NextResponse {
  if (status === 503) {
    return NextResponse.json(
      { ok: false, error: { code: "auth_unavailable", message: "Authorization is temporarily unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } }
    );
  }
  return NextResponse.json(
    { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}
