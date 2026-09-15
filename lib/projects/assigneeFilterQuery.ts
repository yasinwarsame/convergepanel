/**
 * Project/Research Assignment (brief §6.7) — strict `?assignee=` parsing
 * shared by the Team Project list and both Team run list routes. The ONLY
 * accepted value is `me` (the caller's own uid, substituted server-side
 * from the authenticated identity — never a caller-supplied uid, so the
 * filter can never be used to enumerate another member's assignments by
 * uid). Absent ⇒ no filter. Present-but-empty, unknown, or duplicated ⇒
 * hard rejection, mirroring `parseProjectListStatusQuery()`.
 */

import "server-only";

export type ParseAssigneeFilterQueryResult = { ok: true; filter: "me" | null } | { ok: false; reason: "invalid_value" | "duplicate" };

export function parseAssigneeFilterQuery(searchParams: URLSearchParams): ParseAssigneeFilterQueryResult {
  const values = searchParams.getAll("assignee");
  if (values.length === 0) return { ok: true, filter: null };
  if (values.length > 1) return { ok: false, reason: "duplicate" };
  if (values[0] === "me") return { ok: true, filter: "me" };
  return { ok: false, reason: "invalid_value" };
}
