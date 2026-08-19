/**
 * Phase 7E-A — client-safe response validation for the ALREADY-PRODUCTION-
 * PROVEN association endpoint (`PATCH /api/user/runs/{runId}/project`,
 * Phase 6D.4A). This module does not change, wrap, or widen that route's
 * contract — it only validates what the route already promises before the
 * UI adopts it. The route's frozen success body is a narrow acknowledgement
 * (`{ok, runId, projectId}`, `app/api/user/runs/[runId]/project/route.ts`
 * line 146) — no Project name, no `updateTime`; the UI relies on canonical
 * `GET` reconciliation (resetting Unfiled) rather than inventing extra
 * fields the route doesn't return.
 */

import { isValidProjectIdSyntaxClientSide } from "@/lib/projects/projectIdClient";

export type RunProjectAssociationErrorCode =
  | "unauthorized"
  | "auth_error"
  | "projects_disabled"
  | "invalid_request_body"
  | "unexpected_field"
  | "run_not_found"
  | "project_not_found"
  | "project_archived"
  | "project_association_conflict"
  | "project_association_unchanged"
  | "rate_limited"
  | "internal_error"
  | "network_error";

const KNOWN_SERVER_ERROR_CODES: readonly Exclude<RunProjectAssociationErrorCode, "network_error">[] = [
  "unauthorized",
  "auth_error",
  "projects_disabled",
  "invalid_request_body",
  "unexpected_field",
  "run_not_found",
  "project_not_found",
  "project_archived",
  "project_association_conflict",
  "project_association_unchanged",
  "rate_limited",
  "internal_error",
];

/** An unrecognized/absent errorCode on a non-ok response collapses to `internal_error`, mirroring every other response parser in this codebase — never guessed into a known code it doesn't match. */
export function mapRunProjectAssociationErrorCode(raw: unknown): RunProjectAssociationErrorCode {
  const found = KNOWN_SERVER_ERROR_CODES.find((code) => code === raw);
  return found ?? "internal_error";
}

export interface RunProjectAssociationDto {
  runId: string;
  projectId: string | null;
}

function isValidRunProjectAssociationDtoShape(raw: unknown): raw is RunProjectAssociationDto {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  if (typeof c.runId !== "string" || c.runId.length === 0) return false;
  if (c.projectId === null) return true;
  return isValidProjectIdSyntaxClientSide(c.projectId);
}

/**
 * Returns the validated DTO only when the response's `runId`/`projectId`
 * exactly match what this specific assignment operation asked for. A
 * response naming a different run, or a different resulting Project, is an
 * integrity error — never adopted, never partially trusted.
 */
export function validateRunProjectAssociationDto(raw: unknown, check: { expectedRunId: string; expectedTargetProjectId: string | null }): RunProjectAssociationDto | null {
  if (!isValidRunProjectAssociationDtoShape(raw)) return null;
  if (raw.runId !== check.expectedRunId) return null;
  if (raw.projectId !== check.expectedTargetProjectId) return null;
  return raw;
}
