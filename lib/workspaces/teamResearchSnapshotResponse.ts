/**
 * ADD-TO-TEAM-PROJECT §R — the response contract shared by the snapshot
 * route (server) and its client (`hooks/useTeamResearchSnapshot.ts`).
 * Pure, no `server-only`, no I/O — the same module validates the DTO on
 * both sides so the client can never accept a shape the server does not
 * emit (mirrors `lib/projects/runProjectAssociationResponse.ts`).
 */

export type TeamResearchSnapshotErrorBody = { ok: false; errorCode: string; message: string };

/**
 * A source that is missing, not the caller's, Team-bound, invalidly bound,
 * not a run at all, or not complete — ONE concealed response for all of
 * them. Which predicate failed is never revealed.
 */
export function sourceResearchNotFoundConcealedResponse(): { status: number; body: TeamResearchSnapshotErrorBody } {
  return { status: 404, body: { ok: false, errorCode: "source_not_found", message: "This research could not be found." } };
}

/**
 * The complete snapshot payload exceeds the repository's total-document
 * budget. Non-retryable: the historical artifact is never truncated to fit,
 * and nothing was written.
 */
export function snapshotTooLargeResponse(): { status: number; body: TeamResearchSnapshotErrorBody } {
  return { status: 413, body: { ok: false, errorCode: "snapshot_too_large", message: "This research is too large to copy into a Team Project." } };
}

/** Built server-side from trusted path identifiers + the created run id; the client re-derives it to validate the DTO. */
export function buildTeamResearchDetailHref(args: { workspaceId: string; projectId: string; runId: string }): string {
  return `/workspace/team/${encodeURIComponent(args.workspaceId)}/projects/${encodeURIComponent(args.projectId)}/research/${encodeURIComponent(args.runId)}`;
}

export type TeamResearchSnapshotStatus = "created" | "already_exists";

export interface TeamResearchSnapshotDto {
  ok: true;
  status: TeamResearchSnapshotStatus;
  runId: string;
  workspaceId: string;
  projectId: string;
  href: string;
}

export function buildTeamResearchSnapshotDto(args: { status: TeamResearchSnapshotStatus; runId: string; workspaceId: string; projectId: string }): TeamResearchSnapshotDto {
  return {
    ok: true,
    status: args.status,
    runId: args.runId,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    href: buildTeamResearchDetailHref(args),
  };
}

/**
 * Client-side integrity check: the response must name the destination the
 * caller asked for and an `href` that is exactly the one built from those
 * identifiers — a response is never allowed to redirect the user somewhere
 * the request did not target.
 */
export function validateTeamResearchSnapshotDto(body: unknown, expected: { workspaceId: string; projectId: string }): TeamResearchSnapshotDto | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return null;
  if (b.status !== "created" && b.status !== "already_exists") return null;
  if (typeof b.runId !== "string" || b.runId.length === 0) return null;
  if (b.workspaceId !== expected.workspaceId || b.projectId !== expected.projectId) return null;
  const href = buildTeamResearchDetailHref({ workspaceId: expected.workspaceId, projectId: expected.projectId, runId: b.runId });
  if (b.href !== href) return null;
  return { ok: true, status: b.status, runId: b.runId, workspaceId: expected.workspaceId, projectId: expected.projectId, href };
}

export type TeamResearchSnapshotErrorCode =
  | "unauthorized"
  | "auth_error"
  | "rate_limited"
  | "invalid_request_body"
  | "unexpected_field"
  | "insufficient_capability"
  | "team_workspace_not_found"
  | "project_not_found"
  | "project_archived"
  | "source_not_found"
  | "snapshot_too_large"
  | "internal_error"
  | "network_error";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "auth_error",
  "rate_limited",
  "invalid_request_body",
  "unexpected_field",
  "insufficient_capability",
  "team_workspace_not_found",
  "project_not_found",
  "project_archived",
  "source_not_found",
  "snapshot_too_large",
  "internal_error",
]);

/** Unknown/absent server codes collapse to `internal_error` — the client never invents a more specific story than the server told. */
export function mapTeamResearchSnapshotErrorCode(raw: unknown): TeamResearchSnapshotErrorCode {
  return typeof raw === "string" && KNOWN_ERROR_CODES.has(raw) ? (raw as TeamResearchSnapshotErrorCode) : "internal_error";
}
