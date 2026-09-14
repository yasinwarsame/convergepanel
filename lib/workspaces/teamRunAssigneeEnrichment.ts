/**
 * Project/Research Assignment (brief §6.6) — the run-list counterpart of
 * `enrichTeamProjectDtos()`: normalizes every fetched row's stored
 * `assigneeUid` (malformed ⇒ `null`, logged, never surfaced), resolves all
 * unique uids on the page through ONE `resolveAssigneePresentations()` call
 * under the D2 run rule, and returns one presentation-or-null per row in
 * input order. Never a per-row read.
 */

import "server-only";
import { logger } from "@/lib/logger";
import { normalizeStoredAssigneeUid } from "./assignmentNormalization";
import { resolveAssigneePresentations } from "./assigneePresentation";
import type { TeamRunAssigneeDto } from "./teamRunSummary";

export async function resolveRunAssigneesForPage(workspaceId: string, rows: readonly { docId: string; data: Record<string, unknown> }[]): Promise<(TeamRunAssigneeDto | null)[]> {
  const uids = rows.map((row) => {
    const normalized = normalizeStoredAssigneeUid(row.data.assigneeUid);
    if (normalized.malformed) {
      logger.warn("[workspaces/teamRunAssigneeEnrichment] Malformed stored assigneeUid normalized to null (integrity anomaly)", { workspaceId, runId: row.docId });
    }
    return normalized.uid;
  });
  const unique = Array.from(new Set(uids.filter((u): u is string => u !== null)));
  const presentations = unique.length > 0 ? await resolveAssigneePresentations(workspaceId, "run", unique) : new Map<string, TeamRunAssigneeDto>();
  return uids.map((uid) => (uid ? (presentations.get(uid) ?? null) : null));
}
