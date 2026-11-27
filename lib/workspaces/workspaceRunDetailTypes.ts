/**
 * ZCA L-3 — client-safe shape of `GET /api/user/workspace-review-runs/[runId]`.
 * `workspaceRunDetail.ts` is server-only; the client imports only this module. `parse…` accepts a
 * body only when it is exactly the endpoint's ok shape, so a malformed or unexpected answer renders
 * the neutral "unavailable" state rather than partial data.
 */
import { HUMAN_REVIEW_STATUSES, type HumanReviewStatus } from "@/lib/adaptiveSchema/governanceRecordParser";

export interface WorkspaceRunDetailInfo {
  runId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  runLabel: string;
  reviewStatus: HumanReviewStatus | null;
  createdAt: string | null;
  reviewedAt: string | null;
}

const str = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

export function parseWorkspaceRunDetailResponse(body: unknown): WorkspaceRunDetailInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { ok?: unknown; detail?: unknown };
  if (b.ok !== true || typeof b.detail !== "object" || b.detail === null) return null;
  const d = b.detail as Record<string, unknown>;
  if (!str(d.runId) || !str(d.workspaceId) || !str(d.workspaceName) || !str(d.runLabel)) return null;
  if (!strOrNull(d.projectId) || !strOrNull(d.projectName) || !strOrNull(d.createdAt) || !strOrNull(d.reviewedAt)) return null;
  if (d.reviewStatus !== null && !(str(d.reviewStatus) && HUMAN_REVIEW_STATUSES.has(d.reviewStatus as HumanReviewStatus))) return null;
  return {
    runId: d.runId,
    workspaceId: d.workspaceId,
    workspaceName: d.workspaceName,
    projectId: d.projectId,
    projectName: d.projectName,
    runLabel: d.runLabel,
    reviewStatus: d.reviewStatus as HumanReviewStatus | null,
    createdAt: d.createdAt,
    reviewedAt: d.reviewedAt,
  };
}
