/**
 * Project Read Foundation, Phase 7A.1 — strict `?status=` parsing for
 * `GET /api/user/projects`. Corrects a Phase 7A defect: the original
 * implementation silently coerced any unsupported explicit value (e.g.
 * `?status=all`, `?status=garbage`) to `"active"`, making a malformed
 * client request appear identical to a well-formed default one. That is
 * never acceptable: "absent" and "present but invalid" must stay
 * distinguishable, exactly like every other strict query/body parser in
 * this codebase (`parseCreateProjectBody`, `parseRunProjectAssociationBody`,
 * etc.) already treats an unrecognized value as a hard rejection, never a
 * silent fallback.
 *
 * `?status=` (present, empty) is treated as an explicitly-supplied
 * invalid value, not omission — `URLSearchParams.getAll()` returns `[""]`
 * for that input, which this function's "empty array means absent" check
 * correctly does NOT match.
 *
 * Duplicate `?status=a&status=b` is rejected as ambiguous — detectable
 * here because `URLSearchParams.getAll()` (unlike `.get()`, which only
 * ever returns the first) preserves every occurrence.
 */

import "server-only";

export type ParseProjectListStatusQueryResult = { ok: true; status: "active" | "archived" } | { ok: false; reason: "invalid_value" | "duplicate" };

export function parseProjectListStatusQuery(searchParams: URLSearchParams): ParseProjectListStatusQueryResult {
  const values = searchParams.getAll("status");
  if (values.length === 0) {
    return { ok: true, status: "active" };
  }
  if (values.length > 1) {
    return { ok: false, reason: "duplicate" };
  }
  const raw = values[0];
  if (raw === "active" || raw === "archived") {
    return { ok: true, status: raw };
  }
  return { ok: false, reason: "invalid_value" };
}
