/**
 * Request IDs for the API platform (Addendum 1 §3; PRD §9.3 `X-Request-Id`).
 * Always server-generated. A client-supplied `X-Request-Id` is never used as the request ID; it is
 * echoed back only as `client_request_id`, and only when it matches a conservative pattern.
 */
import { randomBase62 } from "@/lib/apiPlatform/ids";

export const newRequestId = (): string => `req_${randomBase62(24)}`;

const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The client's own correlation ID, or null when absent or not safe to echo. */
export function clientRequestId(headers: Headers): string | null {
  const raw = headers.get("x-request-id");
  return raw !== null && CLIENT_REQUEST_ID.test(raw) ? raw : null;
}
