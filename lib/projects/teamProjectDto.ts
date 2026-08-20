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
 *
 * `updateTime` is nullable — a Phase 8C-A.1 correction. A canonical
 * mutation can commit successfully while the SEPARATE, best-effort
 * post-commit projection read that would normally supply this value
 * fails (see `lib/firestore/teamProjects.ts`'s post-commit-read-failure
 * contract). `null` here means exactly "the mutation committed, but no
 * fresh OCC token is available from this response" — it is NEVER
 * fabricated from `project.updatedAt`, `Timestamp.now()`, or a caller's
 * own stale token. A client that receives `null` must obtain a fresh
 * token via an ordinary canonical read (e.g. the list route) before its
 * next mutation, never by retrying the mutation that returned `null`.
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
  updateTime: UpdateTimeToken | null;
}

/** `documentUpdateTime` is the Firestore document's own native `updateTime` at the point of read — supplied by the caller, never derived from `project.updatedAt`. Pass `null` only when no authoritative native `updateTime` is available (post-commit projection read failure) — never a fabricated stand-in. */
export function toTeamProjectSummaryDto(project: ProjectV1, documentUpdateTime: Timestamp | null): TeamProjectSummaryDto {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    status: project.status,
    createdByUserId: project.createdByUserId,
    createdAt: project.createdAt.toDate().toISOString(),
    updatedAt: project.updatedAt.toDate().toISOString(),
    updateTime: documentUpdateTime ? serializeUpdateTimeToken(documentUpdateTime) : null,
  };
}
