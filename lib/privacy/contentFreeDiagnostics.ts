/**
 * Privacy remediation round 2 (2026-11-18, review B2) — content-free
 * diagnostics for log lines and error responses.
 *
 * Model output, synthesized reports and user claims must never be logged.
 * Several values that LOOK like metadata quote content:
 *   - a JSON `SyntaxError` message quotes the start of the unparseable text
 *     (`Unexpected token 'T', "The claim "... is not valid JSON`);
 *   - a Zod issue message for an enum / literal quotes the RECEIVED value
 *     (`Invalid enum value. Expected 'a' | 'b', received '<model text>'`).
 * These helpers keep what makes a log line useful (error class, issue code,
 * field path, counts, lengths) and drop the rest. Isomorphic (browser + server).
 */

/** The error's class name only (`SyntaxError`, `ZodError`, `AbortError`), never its message. */
export function errorName(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as { name?: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return typeof err;
}

export type ContentFreeIssue = { path: string; code: string };

/** `{ path, code }` per Zod-like issue (`err.issues` or `err.errors`) — no messages, no received values. Max 50. */
export function issueSummary(err: unknown): ContentFreeIssue[] {
  const src = err && typeof err === "object" ? ((err as any).issues ?? (err as any).errors) : undefined;
  if (!Array.isArray(src)) return [];
  return src.slice(0, 50).map((i: any) => ({
    path: Array.isArray(i?.path) ? i.path.map((p: unknown) => String(p)).join(".") : "",
    code: typeof i?.code === "string" ? i.code : "unknown",
  }));
}

/** For pre-formatted `"<field>: <message>"` issue strings: the field part only. */
export function issueFieldsFromStrings(issues: readonly string[]): string[] {
  return issues.slice(0, 50).map((s) => {
    const at = s.indexOf(":");
    return at === -1 ? "(unknown)" : s.slice(0, at);
  });
}
