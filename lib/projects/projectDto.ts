/**
 * Project Foundation, Phase 6C — the browser-facing Project summary DTO.
 * Deliberately narrower than `ProjectV1`: `workspaceId`, `createdByUserId`,
 * and `schemaVersion` are never sent to the client — every route that
 * needs them resolves the Project server-side from the authenticated
 * session, exactly mirroring `GET /api/user/workspace`'s own deliberately
 * minimal `{name, type}` response and its documented reasoning ("the
 * browser has no use for the raw identifier").
 *
 * `updateTime` is the OCC token (Firestore's native document `updateTime`,
 * see `updateTimeToken.ts`) — NOT the same value as `updatedAt` (ordinary
 * application data), even though they're set together on every mutation
 * and will usually be extremely close in value. Both are exposed because
 * they answer different questions: `updatedAt` is display data ("when was
 * this last changed"); `updateTime` is the value a future PATCH/archive/
 * restore request must echo back unchanged to prove it isn't stale.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import type { ProjectV1 } from "./types";
import { serializeUpdateTimeToken, type UpdateTimeToken } from "./updateTimeToken";

export interface ProjectSummaryDto {
  id: string;
  name: string;
  status: ProjectV1["status"];
  createdAt: string;
  updatedAt: string;
  updateTime: UpdateTimeToken;
}

/** `documentUpdateTime` is the Firestore document's own native `updateTime` at the point of read — supplied by the caller (from `DocumentSnapshot.updateTime`), never derived from `project.updatedAt`. */
export function toProjectSummaryDto(project: ProjectV1, documentUpdateTime: Timestamp): ProjectSummaryDto {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt.toDate().toISOString(),
    updatedAt: project.updatedAt.toDate().toISOString(),
    updateTime: serializeUpdateTimeToken(documentUpdateTime),
  };
}
