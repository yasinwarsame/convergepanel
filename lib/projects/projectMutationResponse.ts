/**
 * Phase 7D — client-safe response validation for the Project lifecycle
 * mutation endpoints (`POST /api/user/projects`, `PATCH
 * /api/user/projects/{id}`, `POST /api/user/projects/{id}/archive`,
 * `POST /api/user/projects/{id}/restore`). A successful HTTP response is
 * not, by itself, sufficient to adopt a returned Project DTO into UI
 * state — the DTO's own `id`/`status` must also satisfy the operation's
 * contract (e.g. an archive response whose `status` isn't `"archived"`,
 * or whose `id` doesn't match the Project that was archived, is an
 * integrity error, never adopted). See `validateProjectMutationDto()`.
 */

import { isValidUpdateTimeTokenShape, type UpdateTimeToken } from "@/lib/projects/updateTimeTokenClient";

export type ProjectMutationErrorCode =
  | "unauthorized"
  | "auth_error"
  | "projects_disabled"
  | "invalid_request_body"
  | "unexpected_field"
  | "invalid_project_name"
  | "invalid_update_time"
  | "conflict"
  | "invalid_project_status_transition"
  | "project_not_found"
  | "project_unavailable"
  | "too_many_projects"
  | "rate_limited"
  | "workspace_missing"
  | "workspace_invalid"
  | "workspace_unavailable"
  | "internal_error"
  | "network_error";

const KNOWN_SERVER_ERROR_CODES: readonly Exclude<ProjectMutationErrorCode, "network_error">[] = [
  "unauthorized",
  "auth_error",
  "projects_disabled",
  "invalid_request_body",
  "unexpected_field",
  "invalid_project_name",
  "invalid_update_time",
  "conflict",
  "invalid_project_status_transition",
  "project_not_found",
  "project_unavailable",
  "too_many_projects",
  "rate_limited",
  "workspace_missing",
  "workspace_invalid",
  "workspace_unavailable",
  "internal_error",
];

/** An unrecognized/absent errorCode on a non-ok response is never guessed into a known one it doesn't match — it collapses to `internal_error`, mirroring every other response parser in this codebase (`parseWorkspaceRunsPageResponse`, `parseProjectsListPageResponse`, ...). */
export function mapMutationErrorCode(raw: unknown): ProjectMutationErrorCode {
  const found = KNOWN_SERVER_ERROR_CODES.find((code) => code === raw);
  return found ?? "internal_error";
}

export interface ProjectMutationDto {
  id: string;
  name: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  updateTime: UpdateTimeToken;
}

function isValidProjectMutationDtoShape(raw: unknown): raw is ProjectMutationDto {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.name === "string" &&
    (c.status === "active" || c.status === "archived") &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string" &&
    isValidUpdateTimeTokenShape(c.updateTime)
  );
}

export type ProjectMutationSuccessCheck =
  | { operation: "create" }
  | { operation: "rename"; expectedId: string; expectedStatus: "active" | "archived" }
  | { operation: "archive"; expectedId: string }
  | { operation: "restore"; expectedId: string };

/**
 * Returns the validated DTO only when BOTH the structural shape AND the
 * operation-specific contract hold:
 *  - create: `status` must be `"active"` (a freshly created Project is
 *    never archived).
 *  - rename: `id` must equal the Project that was renamed; `status` must
 *    be unchanged (rename never transitions status).
 *  - archive: `id` must match; `status` must be exactly `"archived"`.
 *  - restore: `id` must match; `status` must be exactly `"active"`.
 * Any mismatch returns `null` — a contradictory "successful" response is
 * an integrity error, never partially adopted or reinterpreted.
 */
export function validateProjectMutationDto(raw: unknown, check: ProjectMutationSuccessCheck): ProjectMutationDto | null {
  if (!isValidProjectMutationDtoShape(raw)) return null;
  switch (check.operation) {
    case "create":
      return raw.status === "active" ? raw : null;
    case "rename":
      return raw.id === check.expectedId && raw.status === check.expectedStatus ? raw : null;
    case "archive":
      return raw.id === check.expectedId && raw.status === "archived" ? raw : null;
    case "restore":
      return raw.id === check.expectedId && raw.status === "active" ? raw : null;
  }
}
