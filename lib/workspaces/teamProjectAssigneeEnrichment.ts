/**
 * Project/Research Assignment (brief §6.6) — builds `TeamProjectSummaryDto`s
 * with their `assignees` presentations in ONE batched pass per page: the
 * stored lists are normalized (malformed ⇒ `[]`, logged, never surfaced),
 * every unique uid across the page is resolved once through
 * `resolveAssigneePresentations()` (one membership `getAll` + the
 * membership-evidenced name resolver), and each DTO receives its ordered
 * presentations. Never a per-row read.
 *
 * NEVER THROWS (PR #164 review C1): the callers have often ALREADY
 * COMMITTED a canonical mutation; a presentation failure degrades every
 * assignee to the fallback label + `stale`, never to an HTTP failure that
 * would invite a duplicate create/mutation on retry.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import { logger } from "@/lib/logger";
import type { ProjectV1 } from "@/lib/projects/types";
import { toTeamProjectSummaryDto, type TeamProjectSummaryDto } from "@/lib/projects/teamProjectDto";
import { normalizeStoredAssigneeUids } from "./assignmentNormalization";
import { resolveAssigneePresentations, degradedAssigneePresentation, type AssigneePresentation } from "./assigneePresentation";

export async function enrichTeamProjectDtos(workspaceId: string, items: readonly { project: ProjectV1; documentUpdateTime: Timestamp | null }[]): Promise<TeamProjectSummaryDto[]> {
  const normalizedLists = items.map((item) => {
    const normalized = normalizeStoredAssigneeUids(item.project.assigneeUids);
    if (normalized.malformed) {
      // Logged WITHOUT the raw value (which may be arbitrarily large or non-string).
      logger.warn("[workspaces/teamProjectAssigneeEnrichment] Malformed or over-cap stored assigneeUids normalized to [] (integrity anomaly)", { workspaceId, projectId: item.project.id });
    }
    return normalized.uids;
  });
  const allUids = Array.from(new Set(normalizedLists.flat()));
  let presentations: Map<string, AssigneePresentation>;
  try {
    presentations = allUids.length > 0 ? await resolveAssigneePresentations(workspaceId, "project", allUids) : new Map<string, AssigneePresentation>();
  } catch (err) {
    logger.warn("[workspaces/teamProjectAssigneeEnrichment] Presentation failed — assignees degrade to stale", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    presentations = new Map(allUids.map((uid) => [uid, degradedAssigneePresentation(uid)]));
  }
  return items.map((item, i) => {
    const assignees = normalizedLists[i].map((uid) => presentations.get(uid) ?? degradedAssigneePresentation(uid));
    return toTeamProjectSummaryDto(item.project, item.documentUpdateTime, assignees);
  });
}
