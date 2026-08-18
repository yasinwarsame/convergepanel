/**
 * Project Read Foundation, Phase 7A — strict query-string parsing for
 * `GET /api/user/project-runs`. `projectId` and `scope=unfiled` are
 * mutually exclusive, and exactly one is required — never inferred, never
 * defaulted. A syntactically malformed `projectId` value is deliberately
 * NOT rejected here with a distinguishable 400: it's passed through to
 * `resolveProjectForOwner()`, which already concealment-maps
 * `invalid_project_id` to the same 404 `project_not_found` every other
 * malformed/foreign/nonexistent Project id gets — introducing a separate
 * 400 here would create exactly the distinguishing oracle the rest of the
 * Project routes already avoid.
 */

import "server-only";
import type { ProjectRunsScope } from "./listProjectRunsForOwner";

export type ParseProjectRunsQueryResult =
  | { ok: true; scope: ProjectRunsScope; limit: number; cursorRaw: string | null }
  | { ok: false; reason: "missing_scope" | "ambiguous_scope" | "unknown_scope" };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function parseProjectRunsQuery(searchParams: URLSearchParams): ParseProjectRunsQueryResult {
  const projectId = searchParams.get("projectId");
  const scopeParam = searchParams.get("scope");

  if (projectId !== null && scopeParam !== null) {
    return { ok: false, reason: "ambiguous_scope" };
  }
  if (projectId === null && scopeParam === null) {
    return { ok: false, reason: "missing_scope" };
  }

  let scope: ProjectRunsScope;
  if (projectId !== null) {
    scope = { type: "project", projectId };
  } else if (scopeParam === "unfiled") {
    scope = { type: "unfiled" };
  } else {
    return { ok: false, reason: "unknown_scope" };
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const cursorRaw = searchParams.get("cursor");

  return { ok: true, scope, limit, cursorRaw };
}
