/**
 * Project/Research Assignment (brief §6.6) — builds `TeamProjectSummaryDto`s
 * with their `assignees` presentations in ONE batched pass per page: the
 * stored lists are normalized (malformed ⇒ `[]`, logged, never surfaced),
 * every unique uid across the page is resolved once through
 * `resolveAssigneePresentations()` (one membership `getAll` + the
 * membership-evidenced name resolver), and each DTO receives its ordered
 * presentations. Never a per-row read.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import { logger } from "@/lib/logger";
import type { ProjectV1 } from "@/lib/projects/types";
import { toTeamProjectSummaryDto, type TeamProjectSummaryDto } from "@/lib/projects/teamProjectDto";
import { normalizeStoredAssigneeUids } from "./assignmentNormalization";
import { resolveAssigneePresentations, type AssigneePresentation } from "./assigneePresentation";

export async function enrichTeamProjectDtos(workspaceId: string, items: readonly { project: ProjectV1; documentUpdateTime: Timestamp | null }[]): Promise<TeamProjectSummaryDto[]> {
  const normalizedLists = items.map((item) => {
    const normalized = normalizeStoredAssigneeUids(item.project.assigneeUids);
    if (normalized.malformed) {
      logger.warn("[workspaces/teamProjectAssigneeEnrichment] Malformed stored assigneeUids normalized to [] (integrity anomaly)", { workspaceId, projectId: item.project.id });
    }
    return normalized.uids;
  });
  const allUids = Array.from(new Set(normalizedLists.flat()));
  const presentations = allUids.length > 0 ? await resolveAssigneePresentations(workspaceId, "project", allUids) : new Map<string, AssigneePresentation>();
  return items.map((item, i) => {
    const assignees = normalizedLists[i].map((uid) => presentations.get(uid)).filter((p): p is AssigneePresentation => p !== undefined);
    return toTeamProjectSummaryDto(item.project, item.documentUpdateTime, assignees);
  });
}
