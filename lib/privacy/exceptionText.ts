/**
 * Round 2 (2026-11-18, review MINOR-3) — content-minimizing treatment of an
 * exception message before it leaves the browser / server in Sentry or
 * PostHog error events.
 *
 * Source fixes remove the known content-bearing messages; this is the
 * boundary backstop:
 *   - a `SyntaxError` from `JSON.parse` / `Response.json()` quotes the start
 *     of the text it failed on (`Unexpected token 'T', "The claim "... is not
 *     valid JSON`; Safari: `JSON Parse error: Unexpected identifier "The"`) —
 *     every quoted segment is replaced;
 *   - URLs inside the message go through the shared URL sanitizer;
 *   - the message is capped at MAX_EXCEPTION_VALUE_CHARS.
 */
import { sanitizeUrlsInText } from "./sanitizeUrl";

export const MAX_EXCEPTION_VALUE_CHARS = 300;

export function redactExceptionValue(type: string, value: string): string {
  let out = value;
  if (type === "SyntaxError" || /\bJSON\b/.test(out)) {
    out = out.replace(/"(?:[^"\\]|\\.)*"(?:\.\.\.)?/g, '"[redacted]"').replace(/'(?:[^'\\]|\\.){2,}'/g, "'[redacted]'");
  }
  out = sanitizeUrlsInText(out);
  if (out.length > MAX_EXCEPTION_VALUE_CHARS) out = `${out.slice(0, MAX_EXCEPTION_VALUE_CHARS)}…[truncated]`;
  return out;
}
