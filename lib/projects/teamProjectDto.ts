/**
 * Team Project Backend, Phase 8C-A — the Team Project summary DTO. A
 * deliberate superset of `toProjectSummaryDto()` (the Personal DTO, left
 * completely unmodified): every Personal field, PLUS `workspaceId` and
 * `createdByUserId`. Both additions are safe for every Team role to see —
 * per `lib/workspaces/capabilities.ts`, any role that can reach this DTO
 * at all already has `projects.read`, and provenance metadata within a
 * shared Workspace is exactly what "shared" means. `createdByUserId` is
 * immutable, non-authoritative attribution only (Section 19) — no route
 * ever branches on it for access control.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import type { ProjectV1 } from "./types";
import { serializeUpdateTimeToken, type UpdateTimeToken } from "./updateTimeToken";

export interface TeamProjectSummaryDto {
  id: string;
  workspaceId: string;
  name: string;
  status: ProjectV1["status"];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  updateTime: UpdateTimeToken;
}

/** `documentUpdateTime` is the Firestore document's own native `updateTime` at the point of read — supplied by the caller, never derived from `project.updatedAt`. */
export function toTeamProjectSummaryDto(project: ProjectV1, documentUpdateTime: Timestamp): TeamProjectSummaryDto {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    status: project.status,
    createdByUserId: project.createdByUserId,
    createdAt: project.createdAt.toDate().toISOString(),
    updatedAt: project.updatedAt.toDate().toISOString(),
    updateTime: serializeUpdateTimeToken(documentUpdateTime),
  };
}
